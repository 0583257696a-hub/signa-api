import type { Services } from '../../context';
import { newId } from '../../lib/crypto';
import { all, first, isUniqueViolation, run } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { iso, utcPeriod, utcPeriodBounds } from '../../lib/time';
import type { BillingContext, MeteredFeature } from './entitlements';

/**
 * USAGE MODEL
 * -----------
 * A usage event is one translation request that passed validation, auth, rate-limit
 * and entitlement checks. Its lifecycle:
 *   reserved  → quota units are held (counters incremented atomically)
 *   succeeded → the translation produced a result; units stay counted
 *   failed    → processing failed; units are released (not counted)
 *   rejected  → quota was exhausted; nothing counted
 * Retries that reuse an Idempotency-Key never double count; they increment
 * `retry_count` on the original event.
 *
 * Counters are monthly, keyed by UTC period "YYYY-MM". Each increment is a single
 * conditional UPSERT (`count < limit`), so concurrent requests cannot exceed a limit.
 * The pooled counter ('translations') and the per-feature counter are reserved in
 * sequence with compensation: a rejection at the second step releases the first.
 */
export const POOLED = 'translations';

export interface UsageReservation {
  eventId: string;
  /** True when this call matched an earlier request with the same idempotency key. */
  replay: boolean;
  previousOutcome?: string;
  period: string;
}

async function tryIncrement(
  svc: Services,
  ctx: BillingContext,
  counter: string,
  period: string,
  limit: number | null,
): Promise<boolean> {
  const now = svc.now();
  // ?6 is the limit (NULL = unlimited). Insert only if the limit allows ≥ 1, and
  // update only while count < limit. No row returned ⇒ the limit is reached.
  const row = await first<{ count: number }>(
    svc.db,
    `INSERT INTO usage_counters (subject_type, subject_id, feature, period, count, updated_at)
       SELECT ?1, ?2, ?3, ?4, 1, ?5 WHERE ?6 IS NULL OR ?6 >= 1
     ON CONFLICT (subject_type, subject_id, feature, period)
       DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
       WHERE ?6 IS NULL OR usage_counters.count < ?6
     RETURNING count`,
    ctx.subjectType,
    ctx.subjectId,
    counter,
    period,
    now,
    limit,
  );
  return row !== null;
}

async function decrement(svc: Services, subjectType: string, subjectId: string, counter: string, period: string): Promise<void> {
  await run(
    svc.db,
    `UPDATE usage_counters SET count = MAX(count - 1, 0), updated_at = ?
      WHERE subject_type = ? AND subject_id = ? AND feature = ? AND period = ?`,
    svc.now(), subjectType, subjectId, counter, period,
  );
}

async function counterValue(svc: Services, ctx: Pick<BillingContext, 'subjectType' | 'subjectId'>, counter: string, period: string): Promise<number> {
  const r = await first<{ count: number }>(
    svc.db,
    'SELECT count FROM usage_counters WHERE subject_type = ? AND subject_id = ? AND feature = ? AND period = ?',
    ctx.subjectType, ctx.subjectId, counter, period,
  );
  return r?.count ?? 0;
}

export async function reserveUsage(
  svc: Services,
  ctx: BillingContext,
  args: { feature: MeteredFeature; userId: string; requestId: string; idempotencyKey: string | null; fingerprint?: string },
): Promise<UsageReservation> {
  const now = svc.now();
  const period = utcPeriod(now);
  let eventId = newId('use');
  let needsInsert = true;

  if (args.idempotencyKey) {
    const existing = await first<{ id: string; outcome: string; period: string; request_fingerprint: string | null }>(
      svc.db,
      'SELECT id, outcome, period, request_fingerprint FROM usage_events WHERE user_id = ? AND feature = ? AND idempotency_key = ?',
      args.userId, args.feature, args.idempotencyKey,
    );
    if (existing) {
      if (args.fingerprint && existing.request_fingerprint && existing.request_fingerprint !== args.fingerprint) {
        throw new AppError('idempotency_conflict');
      }
      await run(svc.db, 'UPDATE usage_events SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?', now, existing.id);
      // A retry of a request that previously failed or was rejected gets a fresh attempt.
      const reopened = await run(
        svc.db,
        `UPDATE usage_events SET outcome = 'reserved', error_code = NULL, period = ?, updated_at = ?
          WHERE id = ? AND outcome IN ('failed','rejected')`,
        period, now, existing.id,
      );
      if (!reopened) return { eventId: existing.id, replay: true, previousOutcome: existing.outcome, period: existing.period };
      eventId = existing.id;
      needsInsert = false;
    }
  }

  if (needsInsert) {
    try {
      await run(
        svc.db,
        `INSERT INTO usage_events (id, request_id, idempotency_key, request_fingerprint, user_id, organization_id, subject_type,
           subject_id, feature, period, units, outcome, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,'reserved',?,?)`,
        eventId, args.requestId, args.idempotencyKey, args.fingerprint ?? null, args.userId, ctx.organizationId, ctx.subjectType, ctx.subjectId,
        args.feature, period, now, now,
      );
    } catch (e) {
      if (isUniqueViolation(e) && args.idempotencyKey) {
        // A concurrent request with the same key won the race.
        const winner = await first<{ id: string; outcome: string; period: string }>(
          svc.db,
          'SELECT id, outcome, period FROM usage_events WHERE user_id = ? AND feature = ? AND idempotency_key = ?',
          args.userId, args.feature, args.idempotencyKey,
        );
        if (winner) return { eventId: winner.id, replay: true, previousOutcome: winner.outcome, period: winner.period };
      }
      throw e;
    }
  }

  const pooledLimit = ctx.entitlements['translations.monthly_limit'];
  const featureLimit = ctx.entitlements[`${args.feature}.monthly_limit`];
  const pooledOk = await tryIncrement(svc, ctx, POOLED, period, pooledLimit);
  if (!pooledOk) return reject(svc, ctx, eventId, POOLED, pooledLimit ?? 0, period);
  const featureOk = await tryIncrement(svc, ctx, args.feature, period, featureLimit);
  if (!featureOk) {
    await decrement(svc, ctx.subjectType, ctx.subjectId, POOLED, period);
    return reject(svc, ctx, eventId, args.feature, featureLimit ?? 0, period);
  }
  return { eventId, replay: false, period };
}

async function reject(svc: Services, ctx: BillingContext, eventId: string, counter: string, limit: number, period: string): Promise<never> {
  await run(svc.db, `UPDATE usage_events SET outcome = 'rejected', error_code = 'quota_exceeded', updated_at = ? WHERE id = ?`, svc.now(), eventId);
  const { end } = utcPeriodBounds(svc.now());
  throw new AppError('quota_exceeded', {
    details: { limitType: counter, limit, used: await counterValue(svc, ctx, counter, period), resetsAt: iso(end), planId: ctx.planId },
  });
}

export async function commitUsage(svc: Services, eventId: string): Promise<void> {
  await run(svc.db, `UPDATE usage_events SET outcome = 'succeeded', updated_at = ? WHERE id = ? AND outcome = 'reserved'`, svc.now(), eventId);
}

/** Releases reserved units after a failure. Safe to call more than once. */
export async function releaseUsage(svc: Services, eventId: string, errorCode: string): Promise<void> {
  const ev = await first<{ subject_type: string; subject_id: string; feature: string; period: string }>(
    svc.db,
    `UPDATE usage_events SET outcome = 'failed', error_code = ?, updated_at = ?
      WHERE id = ? AND outcome = 'reserved'
      RETURNING subject_type, subject_id, feature, period`,
    errorCode.slice(0, 60), svc.now(), eventId,
  );
  if (!ev) return;
  await decrement(svc, ev.subject_type, ev.subject_id, ev.feature, ev.period);
  await decrement(svc, ev.subject_type, ev.subject_id, POOLED, ev.period);
}

export async function usageSummary(svc: Services, ctx: BillingContext) {
  const now = svc.now();
  const period = utcPeriod(now);
  const { start, end } = utcPeriodBounds(now);
  const rows = await all<{ feature: string; count: number }>(
    svc.db,
    'SELECT feature, count FROM usage_counters WHERE subject_type = ? AND subject_id = ? AND period = ?',
    ctx.subjectType, ctx.subjectId, period,
  );
  const used = (k: string) => rows.find((r) => r.feature === k)?.count ?? 0;
  const e = ctx.entitlements;
  return {
    subject: { type: ctx.subjectType, id: ctx.subjectId },
    planId: ctx.planId,
    period: { id: period, start: iso(start), end: iso(end), resetsAt: iso(end) },
    counters: {
      translations: { used: used(POOLED), limit: e['translations.monthly_limit'] },
      emoji: { used: used('emoji'), limit: e['emoji.monthly_limit'] },
      sign: { used: used('sign'), limit: e['sign.monthly_limit'] },
    },
    limits: {
      emojiMaxInputChars: e['emoji.max_input_chars'],
      signMaxInputChars: e['sign.max_input_chars'],
      signMaxConcurrentJobs: e['sign.max_concurrent_jobs'],
      emojiStyles: e['emoji.styles'],
      signEnabled: e['sign.enabled'],
      historyAvailable: e['history.available'],
    },
  };
}
