import type { Services } from '../../context';
import { newId } from '../../lib/crypto';
import { all, first, parseJson, run } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { DAY, iso } from '../../lib/time';
import { sendTemplatedEmail } from '../email/service';
import type { SubjectType, SubscriptionRow } from '../usage/entitlements';
import type { UserRow } from '../users/model';
import type { NormalizedWebhookEvent } from './provider';

export type SubscriptionStatus = SubscriptionRow['status'];

export interface PlanRow {
  id: string;
  name_en: string;
  name_he: string;
  is_active: number;
  is_public: number;
  availability: 'available' | 'waitlist' | 'contact_sales';
  sort_order: number;
  pricing_json: string | null;
  trial_days: number;
  grace_period_days: number;
}

export function subscriptionView(s: SubscriptionRow | null) {
  if (!s) return null;
  return {
    id: s.id,
    subjectType: s.subject_type,
    subjectId: s.subject_id,
    planId: s.plan_id,
    status: s.status,
    provider: s.provider,
    trialEndsAt: iso(s.trial_ends_at),
    currentPeriodStart: iso(s.current_period_start),
    currentPeriodEnd: iso(s.current_period_end),
    cancelAtPeriodEnd: s.cancel_at_period_end === 1,
    cancelledAt: iso(s.cancelled_at),
    graceUntil: iso(s.grace_until),
  };
}

/** Allowed state machine transitions. Terminal states (cancelled, expired) never re-open. */
const TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  trialing: ['active', 'past_due', 'cancelled', 'expired', 'suspended'],
  active: ['past_due', 'cancelled', 'expired', 'suspended'],
  past_due: ['active', 'cancelled', 'expired', 'suspended'],
  suspended: ['active', 'past_due', 'cancelled', 'expired'],
  cancelled: [],
  expired: [],
};

export async function transitionSubscription(
  svc: Services,
  sub: SubscriptionRow,
  to: SubscriptionStatus,
  args: {
    reason: string;
    actorType: 'system' | 'user' | 'admin' | 'provider';
    actorId?: string | null;
    planId?: string;
    periodStart?: number | null;
    periodEnd?: number | null;
    graceUntil?: number | null;
    cancelAtPeriodEnd?: boolean;
    trialEndsAt?: number | null;
  },
): Promise<boolean> {
  if (to !== sub.status && !TRANSITIONS[sub.status].includes(to)) return false;
  const now = svc.now();
  const planId = args.planId ?? sub.plan_id;
  const changed = await run(
    svc.db,
    `UPDATE subscriptions SET status = ?, plan_id = ?, current_period_start = ?, current_period_end = ?, grace_until = ?,
       cancel_at_period_end = ?, trial_ends_at = ?, cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
       updated_at = ?
     WHERE id = ? AND status = ?`,
    to,
    planId,
    args.periodStart !== undefined ? args.periodStart : sub.current_period_start,
    args.periodEnd !== undefined ? args.periodEnd : sub.current_period_end,
    args.graceUntil !== undefined ? args.graceUntil : to === 'past_due' ? sub.grace_until : null,
    args.cancelAtPeriodEnd !== undefined ? (args.cancelAtPeriodEnd ? 1 : 0) : sub.cancel_at_period_end,
    args.trialEndsAt !== undefined ? args.trialEndsAt : sub.trial_ends_at,
    to,
    now,
    now,
    sub.id,
    sub.status, // optimistic concurrency
  );
  if (!changed) return false;
  if (to !== sub.status || planId !== sub.plan_id) {
    await run(
      svc.db,
      `INSERT INTO subscription_history (id, subscription_id, from_status, to_status, from_plan_id, to_plan_id, reason, actor_type, actor_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newId('sbh'), sub.id, sub.status, to, sub.plan_id, planId, args.reason, args.actorType, args.actorId ?? null, now,
    );
    if (to !== sub.status) await notifySubscriptionChange(svc, sub.subject_type, sub.subject_id, to, sub.id);
  }
  return true;
}

export async function createSubscription(
  svc: Services,
  args: {
    subjectType: SubjectType;
    subjectId: string;
    planId: string;
    status: SubscriptionStatus;
    provider: string;
    providerSubscriptionRef: string | null;
    providerCustomerRef: string | null;
    periodStart: number | null;
    periodEnd: number | null;
    trialEndsAt: number | null;
    reason: string;
    actorType: 'system' | 'user' | 'admin' | 'provider';
    actorId?: string | null;
  },
): Promise<string> {
  const now = svc.now();
  const id = newId('sub');
  await run(
    svc.db,
    `INSERT INTO subscriptions (id, subject_type, subject_id, plan_id, status, provider, provider_customer_ref, provider_subscription_ref,
       trial_ends_at, current_period_start, current_period_end, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, args.subjectType, args.subjectId, args.planId, args.status, args.provider, args.providerCustomerRef, args.providerSubscriptionRef,
    args.trialEndsAt, args.periodStart, args.periodEnd, now, now,
  );
  await run(
    svc.db,
    `INSERT INTO subscription_history (id, subscription_id, from_status, to_status, from_plan_id, to_plan_id, reason, actor_type, actor_id, created_at)
     VALUES (?,?,NULL,?,NULL,?,?,?,?,?)`,
    newId('sbh'), id, args.status, args.planId, args.reason, args.actorType, args.actorId ?? null, now,
  );
  await notifySubscriptionChange(svc, args.subjectType, args.subjectId, args.status, id);
  return id;
}

async function notifySubscriptionChange(svc: Services, subjectType: SubjectType, subjectId: string, status: string, subscriptionId: string) {
  const recipients =
    subjectType === 'user'
      ? await all<UserRow>(svc.db, `SELECT * FROM users WHERE id = ? AND status = 'active'`, subjectId)
      : await all<UserRow>(
          svc.db,
          `SELECT u.* FROM users u JOIN organization_members m ON m.user_id = u.id
            WHERE m.organization_id = ? AND m.role = 'owner' AND u.status = 'active'`,
          subjectId,
        );
  for (const u of recipients) {
    await sendTemplatedEmail(svc, {
      to: u.email,
      template: 'subscription_status',
      locale: u.locale,
      vars: { status },
      idempotencyKey: `sub-status:${subscriptionId}:${status}:${u.id}`,
    });
  }
}

async function graceUntil(svc: Services, planId: string, from: number): Promise<number> {
  const plan = await first<PlanRow>(svc.db, 'SELECT * FROM plans WHERE id = ?', planId);
  return from + (plan?.grace_period_days ?? 0) * DAY;
}

/**
 * Idempotent webhook processing. Each provider event ID is recorded once; replays of
 * processed events are acknowledged without side effects; failed events can be retried.
 */
export async function processWebhookEvent(svc: Services, provider: string, event: NormalizedWebhookEvent): Promise<'processed' | 'duplicate' | 'ignored'> {
  const now = svc.now();
  const inserted = await run(
    svc.db,
    `INSERT INTO payment_webhook_events (id, provider, provider_event_id, event_type, status, received_at)
     VALUES (?,?,?,?, 'processing', ?) ON CONFLICT (provider, provider_event_id) DO NOTHING`,
    newId('whe'), provider, event.eventId, event.type, now,
  );
  if (!inserted) {
    const retried = await run(
      svc.db,
      `UPDATE payment_webhook_events SET status = 'processing', error_code = NULL WHERE provider = ? AND provider_event_id = ? AND status = 'failed'`,
      provider, event.eventId,
    );
    if (!retried) {
      const existing = await first<{ status: string }>(svc.db, 'SELECT status FROM payment_webhook_events WHERE provider = ? AND provider_event_id = ?', provider, event.eventId);
      if (existing?.status === 'processing') throw new AppError('conflict', { details: { reason: 'event_in_progress' } });
      return 'duplicate';
    }
  }

  try {
    const outcome = await applyEvent(svc, provider, event);
    await run(
      svc.db,
      `UPDATE payment_webhook_events SET status = ?, processed_at = ? WHERE provider = ? AND provider_event_id = ?`,
      outcome, svc.now(), provider, event.eventId,
    );
    return outcome;
  } catch (e) {
    await run(
      svc.db,
      `UPDATE payment_webhook_events SET status = 'failed', error_code = ? WHERE provider = ? AND provider_event_id = ?`,
      e instanceof AppError ? e.code : 'internal_error', provider, event.eventId,
    );
    throw e;
  }
}

async function applyEvent(svc: Services, provider: string, e: NormalizedWebhookEvent): Promise<'processed' | 'ignored'> {
  const now = svc.now();
  if (e.type === 'checkout.completed') {
    if (!e.checkoutRef || !e.subscriptionRef) return 'ignored';
    const checkout = await first<{ id: string; subject_type: SubjectType; subject_id: string; plan_id: string; status: string }>(
      svc.db,
      'SELECT id, subject_type, subject_id, plan_id, status FROM checkout_sessions WHERE provider = ? AND provider_session_ref = ?',
      provider, e.checkoutRef,
    );
    if (!checkout || checkout.status !== 'open') return 'ignored';
    const status = e.status === 'trialing' ? 'trialing' : 'active';
    const live = await first<SubscriptionRow>(
      svc.db,
      `SELECT * FROM subscriptions WHERE subject_type = ? AND subject_id = ? AND status IN ('trialing','active','past_due','suspended')`,
      checkout.subject_type, checkout.subject_id,
    );
    if (live) {
      await run(svc.db, 'UPDATE subscriptions SET provider = ?, provider_subscription_ref = ?, provider_customer_ref = COALESCE(?, provider_customer_ref) WHERE id = ?', provider, e.subscriptionRef, e.customerRef ?? null, live.id);
      await transitionSubscription(svc, { ...live, provider }, status, {
        reason: 'checkout_completed', actorType: 'provider', planId: checkout.plan_id,
        periodStart: e.periodStart ?? now, periodEnd: e.periodEnd ?? null, trialEndsAt: e.trialEndsAt ?? null, graceUntil: null,
      });
    } else {
      await createSubscription(svc, {
        subjectType: checkout.subject_type, subjectId: checkout.subject_id, planId: checkout.plan_id, status, provider,
        providerSubscriptionRef: e.subscriptionRef, providerCustomerRef: e.customerRef ?? null,
        periodStart: e.periodStart ?? now, periodEnd: e.periodEnd ?? null, trialEndsAt: e.trialEndsAt ?? null,
        reason: 'checkout_completed', actorType: 'provider',
      });
    }
    await run(svc.db, `UPDATE checkout_sessions SET status = 'completed' WHERE id = ?`, checkout.id);
    return 'processed';
  }

  if (!e.subscriptionRef) return 'ignored';
  const sub = await first<SubscriptionRow>(svc.db, 'SELECT * FROM subscriptions WHERE provider = ? AND provider_subscription_ref = ?', provider, e.subscriptionRef);
  if (!sub) return 'ignored';

  switch (e.type) {
    case 'subscription.updated': {
      const planOk = e.planId ? await first(svc.db, 'SELECT id FROM plans WHERE id = ?', e.planId) : null;
      const to = e.status ?? sub.status;
      const ok = await transitionSubscription(svc, sub, to, {
        reason: 'provider_update', actorType: 'provider',
        ...(planOk && e.planId ? { planId: e.planId } : {}),
        ...(e.periodStart !== undefined ? { periodStart: e.periodStart } : {}),
        ...(e.periodEnd !== undefined ? { periodEnd: e.periodEnd } : {}),
        ...(e.cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd: e.cancelAtPeriodEnd } : {}),
        ...(e.trialEndsAt !== undefined ? { trialEndsAt: e.trialEndsAt } : {}),
        ...(to === 'past_due' ? { graceUntil: sub.grace_until ?? (await graceUntil(svc, sub.plan_id, now)) } : {}),
      });
      return ok ? 'processed' : 'ignored';
    }
    case 'subscription.cancelled':
      return (await transitionSubscription(svc, sub, 'cancelled', { reason: 'provider_cancelled', actorType: 'provider' })) ? 'processed' : 'ignored';
    case 'payment.failed':
      return (await transitionSubscription(svc, sub, 'past_due', {
        reason: 'payment_failed', actorType: 'provider', graceUntil: sub.grace_until ?? (await graceUntil(svc, sub.plan_id, now)),
      }))
        ? 'processed'
        : 'ignored';
    case 'payment.succeeded':
      return (await transitionSubscription(svc, sub, 'active', {
        reason: 'payment_succeeded', actorType: 'provider', graceUntil: null,
        ...(e.periodStart !== undefined ? { periodStart: e.periodStart } : {}),
        ...(e.periodEnd !== undefined ? { periodEnd: e.periodEnd } : {}),
      }))
        ? 'processed'
        : 'ignored';
    default:
      return 'ignored';
  }
}

/**
 * Cron reconciliation: applies time-based transitions the provider may not push
 * (trial end, period end with cancel_at_period_end, grace expiry) and refreshes
 * state from the provider where it exposes it.
 */
export async function reconcileSubscriptions(svc: Services): Promise<{ transitioned: number }> {
  const now = svc.now();
  let transitioned = 0;
  const due = await all<SubscriptionRow>(
    svc.db,
    `SELECT * FROM subscriptions WHERE
        (status = 'trialing' AND trial_ends_at IS NOT NULL AND trial_ends_at < ?1)
     OR (status = 'active' AND current_period_end IS NOT NULL AND current_period_end < ?1)
     OR (status = 'past_due' AND (grace_until IS NULL OR grace_until < ?1))
     LIMIT 200`,
    now,
  );
  for (const sub of due) {
    const remote = sub.provider_subscription_ref && sub.provider === svc.payment.name ? await svc.payment.getSubscription(sub.provider_subscription_ref).catch(() => null) : null;
    let ok = false;
    if (remote && remote.status !== sub.status && (remote.currentPeriodEnd ?? 0) > now) {
      ok = await transitionSubscription(svc, sub, remote.status, {
        reason: 'reconciled_with_provider', actorType: 'system',
        periodStart: remote.currentPeriodStart, periodEnd: remote.currentPeriodEnd, cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
      });
    } else if (sub.status === 'active' && sub.cancel_at_period_end) {
      ok = await transitionSubscription(svc, sub, 'cancelled', { reason: 'period_ended_after_cancellation', actorType: 'system' });
    } else if (sub.status === 'active' && sub.provider !== 'manual') {
      ok = await transitionSubscription(svc, sub, 'past_due', { reason: 'period_ended_unpaid', actorType: 'system', graceUntil: await graceUntil(svc, sub.plan_id, sub.current_period_end ?? now) });
    } else if (sub.status === 'active') {
      ok = await transitionSubscription(svc, sub, 'expired', { reason: 'manual_term_ended', actorType: 'system' });
    } else if (sub.status === 'trialing') {
      ok = await transitionSubscription(svc, sub, 'expired', { reason: 'trial_ended', actorType: 'system' });
    } else if (sub.status === 'past_due') {
      ok = await transitionSubscription(svc, sub, 'expired', { reason: 'grace_period_ended', actorType: 'system' });
    }
    if (ok) transitioned++;
  }
  await run(svc.db, `UPDATE checkout_sessions SET status = 'expired' WHERE status = 'open' AND expires_at < ?`, now);
  return { transitioned };
}

export function planView(p: PlanRow, entitlements: Record<string, unknown>) {
  const pricing = parseJson<Record<string, unknown> | null>(p.pricing_json, null);
  return {
    id: p.id,
    name: { en: p.name_en, he: p.name_he },
    availability: p.availability,
    pricing,
    pricingStatus: pricing ? 'configured' : 'to_be_announced',
    trialDays: p.trial_days,
    gracePeriodDays: p.grace_period_days,
    entitlements,
  };
}
