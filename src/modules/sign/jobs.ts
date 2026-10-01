import type { Services } from '../../context';
import { hmacHex, newId } from '../../lib/crypto';
import { batch, first, parseJson, run, stmt } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { iso, DAY, MINUTE } from '../../lib/time';
import { recordMetric } from '../metrics/service';
import type { BillingContext } from '../usage/entitlements';
import { commitUsage, releaseUsage, reserveUsage } from '../usage/service';
import { currentDictionaryVersion, validateProposal } from './validator';
import type { JobStatus, NormalizedSignResult, OutputFormat } from './types';

export const MAX_ATTEMPTS = 3;
/** A job must finish within this window from creation, otherwise it expires. */
export const JOB_DEADLINE = 10 * MINUTE;
/** Per-attempt processing lease; a crashed worker's job becomes claimable again after it. */
export const PROCESSING_LEASE = 2 * MINUTE;
/** Job metadata (no text) is kept for operational statistics, then deleted. */
export const JOB_METADATA_RETENTION = 30 * DAY;

export interface JobRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  status: JobStatus;
  idempotency_key: string | null;
  request_fingerprint: string;
  language: string;
  output_format: OutputFormat;
  provider: string | null;
  verification_status: string | null;
  attempts: number;
  max_attempts: number;
  failure_code: string | null;
  usage_event_id: string | null;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  deadline_at: number;
  expires_at: number;
}

export class RetryableJobError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RetryableJobError';
  }
}

export function jobView(j: JobRow) {
  return {
    id: j.id,
    status: j.status,
    organizationId: j.organization_id,
    language: j.language,
    outputFormat: j.output_format,
    verificationStatus: j.verification_status,
    attempts: j.attempts,
    failureCode: j.failure_code,
    createdAt: iso(j.created_at),
    updatedAt: iso(j.updated_at),
    completedAt: iso(j.completed_at),
    deadlineAt: iso(j.deadline_at),
    resultAvailable: j.status === 'completed' || j.status === 'partially_completed',
  };
}

export interface CreateJobInput {
  text: string;
  language: 'he';
  outputFormat: OutputFormat;
  idempotencyKey: string | null;
}

export type CreateJobOutcome =
  | { kind: 'created'; job: JobRow; processedInline: boolean }
  | { kind: 'existing'; job: JobRow };

/**
 * Creates a sign translation job: idempotency → quota reservation → atomic
 * concurrency-limited insert → enqueue (or documented synchronous fallback).
 */
export async function createSignJob(
  svc: Services,
  userId: string,
  ctx: BillingContext,
  input: CreateJobInput,
  requestId: string,
): Promise<CreateJobOutcome> {
  const now = svc.now();
  const fingerprint = await hmacHex(svc.config.APP_SECRET, `sign|${userId}|${input.language}|${input.outputFormat}|${input.text}`);

  if (input.idempotencyKey) {
    const existing = await first<JobRow>(svc.db, 'SELECT * FROM translation_jobs WHERE user_id = ? AND idempotency_key = ?', userId, input.idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) throw new AppError('idempotency_conflict');
      return { kind: 'existing', job: existing };
    }
  }

  const reservation = await reserveUsage(svc, ctx, { feature: 'sign', userId, requestId, idempotencyKey: input.idempotencyKey });
  if (reservation.replay) {
    // Concurrent duplicate with the same idempotency key: return the winner's job if visible.
    const job = input.idempotencyKey
      ? await first<JobRow>(svc.db, 'SELECT * FROM translation_jobs WHERE user_id = ? AND idempotency_key = ?', userId, input.idempotencyKey)
      : null;
    if (job) return { kind: 'existing', job };
    throw new AppError('conflict', { details: { reason: 'duplicate_request_in_progress' } });
  }

  const jobId = newId('job');
  const maxConcurrent = ctx.entitlements['sign.max_concurrent_jobs'];
  const resultTtl = svc.config.SIGN_RESULT_TTL_SECONDS * 1000;
  let inserted: number[];
  try {
    inserted = await batch(svc.db, [
      // Atomic concurrency limit: the INSERT only happens if fewer than N active jobs exist.
      stmt(
        svc.db,
        `INSERT INTO translation_jobs (id, user_id, organization_id, kind, status, idempotency_key, request_fingerprint, language,
           output_format, attempts, max_attempts, usage_event_id, created_at, updated_at, deadline_at, expires_at)
         SELECT ?, ?, ?, 'sign', 'queued', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM translation_jobs WHERE user_id = ? AND status IN ('queued','processing')) < ?`,
        jobId, userId, ctx.organizationId, input.idempotencyKey, fingerprint, input.language, input.outputFormat, MAX_ATTEMPTS,
        reservation.eventId, now, now, now + JOB_DEADLINE, now + JOB_DEADLINE + resultTtl, userId, maxConcurrent,
      ),
      // EPHEMERAL source text; only inserted if the job row exists.
      stmt(
        svc.db,
        `INSERT INTO translation_job_inputs (job_id, source_text, expires_at)
         SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM translation_jobs WHERE id = ?)`,
        jobId, input.text, now + JOB_DEADLINE, jobId,
      ),
    ]);
  } catch (e) {
    await releaseUsage(svc, reservation.eventId, 'job_create_failed');
    throw e;
  }
  if (!inserted[0]) {
    await releaseUsage(svc, reservation.eventId, 'concurrency_limit');
    throw new AppError('rate_limited', { details: { reason: 'concurrent_jobs_limit', limit: maxConcurrent } });
  }

  const job = (await first<JobRow>(svc.db, 'SELECT * FROM translation_jobs WHERE id = ?', jobId))!;
  if (svc.jobQueue) {
    try {
      await svc.jobQueue.send({ jobId, enqueuedAt: now });
      await recordMetric(svc, 'sign_job_enqueued');
      return { kind: 'created', job, processedInline: false };
    } catch {
      await recordMetric(svc, 'queue_send_failure', 'sign_jobs');
      svc.logger.log('warn', 'queue_send_failed', { jobId, requestId });
    }
  }
  // Documented synchronous fallback for short inputs when the queue is absent or failing.
  if (input.text.length <= svc.config.SIGN_SYNC_FALLBACK_MAX_CHARS) {
    await processSignJob(svc, jobId).catch(() => undefined);
    const after = (await first<JobRow>(svc.db, 'SELECT * FROM translation_jobs WHERE id = ?', jobId))!;
    // A retryable failure inline leaves the job queued; fail it explicitly instead of leaving it orphaned.
    if (after.status === 'queued') await failJob(svc, after, 'provider_error');
    return { kind: 'created', job: (await first<JobRow>(svc.db, 'SELECT * FROM translation_jobs WHERE id = ?', jobId))!, processedInline: true };
  }
  await failJob(svc, job, 'queue_unavailable');
  throw new AppError('queue_unavailable');
}

async function purgeEphemeralInput(svc: Services, jobId: string): Promise<void> {
  await run(svc.db, 'DELETE FROM translation_job_inputs WHERE job_id = ?', jobId);
}

async function failJob(svc: Services, job: Pick<JobRow, 'id' | 'usage_event_id'>, code: string): Promise<void> {
  const now = svc.now();
  const changed = await run(
    svc.db,
    `UPDATE translation_jobs SET status = 'failed', failure_code = ?, lease_until = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued','processing')`,
    code, now, now, job.id,
  );
  await purgeEphemeralInput(svc, job.id);
  if (changed && job.usage_event_id) await releaseUsage(svc, job.usage_event_id, code);
  if (changed) await recordMetric(svc, 'sign_job_failed', code);
}

/**
 * Processes one job. Safe under duplicate queue delivery: a job is claimed with a
 * conditional UPDATE, so only one worker processes it at a time, and terminal jobs
 * are skipped. Throws RetryableJobError for transient provider failures while
 * attempts remain.
 */
export async function processSignJob(svc: Services, jobId: string): Promise<void> {
  const now = svc.now();
  const job = await first<JobRow>(
    svc.db,
    `UPDATE translation_jobs
        SET status = 'processing', attempts = attempts + 1, started_at = COALESCE(started_at, ?1),
            lease_until = ?2, updated_at = ?1
      WHERE id = ?3
        AND (status = 'queued' OR (status = 'processing' AND lease_until < ?1))
        AND attempts < max_attempts
      RETURNING *`,
    now, now + PROCESSING_LEASE, jobId,
  );
  if (!job) {
    // Already processing elsewhere, already terminal, or attempts exhausted.
    const current = await first<JobRow>(svc.db, 'SELECT * FROM translation_jobs WHERE id = ?', jobId);
    if (current && (current.status === 'queued' || current.status === 'processing') && current.attempts >= current.max_attempts) {
      await failJob(svc, current, 'max_attempts_exceeded');
    }
    return;
  }
  if (now > job.deadline_at) {
    await expireJob(svc, job);
    return;
  }

  const input = await first<{ source_text: string }>(svc.db, 'SELECT source_text FROM translation_job_inputs WHERE job_id = ?', jobId);
  if (!input) {
    await failJob(svc, job, 'input_unavailable');
    return;
  }

  const started = Date.now();
  let result: NormalizedSignResult;
  try {
    const dictionaryVersion = await currentDictionaryVersion(svc);
    const proposal = await svc.signProvider.translate({
      jobId,
      text: input.source_text,
      language: 'he',
      outputFormat: job.output_format,
      dictionaryVersion,
    });
    await recordMetric(svc, 'sign_provider_latency_ms', svc.signProvider.name, Date.now() - started);
    result = await validateProposal(svc, {
      jobId,
      text: input.source_text,
      outputFormat: job.output_format,
      dictionaryVersion,
      proposal,
      urlTtlMs: svc.config.SIGN_RESULT_TTL_SECONDS * 1000,
    });
  } catch (e) {
    await recordMetric(svc, 'sign_provider_error', svc.signProvider.name, Date.now() - started);
    const code = e instanceof AppError ? e.code : 'internal_error';
    svc.logger.log('warn', 'sign_job_attempt_failed', { jobId, attempt: job.attempts, errorCode: code });
    if (job.attempts < job.max_attempts && code === 'provider_error') {
      await run(svc.db, `UPDATE translation_jobs SET status = 'queued', lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'processing'`, svc.now(), jobId);
      throw new RetryableJobError(code);
    }
    await failJob(svc, job, code);
    return;
  }

  const done = svc.now();
  const anyRenderable = result.segments.some((s) => s.renderable && s.status !== 'pause');
  const status: JobStatus =
    result.verificationStatus === 'unsupported' || result.quality.renderable || !anyRenderable ? 'completed' : 'partially_completed';
  const resultTtl = svc.config.SIGN_RESULT_TTL_SECONDS * 1000;
  // Only a still-processing job is completed (a cancellation in the meantime wins).
  const changed = await batch(svc.db, [
    stmt(
      svc.db,
      `UPDATE translation_jobs SET status = ?, verification_status = ?, provider = ?, lease_until = NULL,
         completed_at = ?, updated_at = ?, expires_at = ? WHERE id = ? AND status = 'processing'`,
      status, result.verificationStatus, `${result.engine.name}@${result.engine.version}`, done, done, done + resultTtl, jobId,
    ),
    stmt(
      svc.db,
      `INSERT INTO translation_job_results (job_id, result_json, expires_at)
       SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM translation_jobs WHERE id = ? AND status IN ('completed','partially_completed'))`,
      jobId, JSON.stringify(result), done + resultTtl, jobId,
    ),
    stmt(svc.db, 'DELETE FROM translation_job_inputs WHERE job_id = ?', jobId),
  ]);
  if (!changed[0]) return; // cancelled or expired concurrently; usage already released there

  // Billing policy: an `unsupported` result produced no usable translation and is not counted.
  if (job.usage_event_id) {
    if (result.verificationStatus === 'unsupported') await releaseUsage(svc, job.usage_event_id, 'unsupported');
    else await commitUsage(svc, job.usage_event_id);
  }
  await recordMetric(svc, 'sign_job_completed', result.verificationStatus);
}

async function expireJob(svc: Services, job: Pick<JobRow, 'id' | 'usage_event_id'>): Promise<void> {
  const now = svc.now();
  const changed = await run(
    svc.db,
    `UPDATE translation_jobs SET status = 'expired', failure_code = 'deadline_exceeded', lease_until = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued','processing')`,
    now, now, job.id,
  );
  await purgeEphemeralInput(svc, job.id);
  if (changed && job.usage_event_id) await releaseUsage(svc, job.usage_event_id, 'deadline_exceeded');
  if (changed) await recordMetric(svc, 'sign_job_expired');
}

/** Called for messages that exhausted queue retries (dead-letter queue). */
export async function deadLetterJob(svc: Services, jobId: string): Promise<void> {
  const job = await first<JobRow>(svc.db, 'SELECT * FROM translation_jobs WHERE id = ?', jobId);
  if (job) await failJob(svc, job, 'dead_lettered');
  await recordMetric(svc, 'queue_dead_letter', 'sign_jobs');
}

/** Ownership-scoped lookup: a job is visible only to the user who created it. */
export async function getOwnedJob(svc: Services, userId: string, jobId: string): Promise<JobRow> {
  const job = await first<JobRow>(svc.db, 'SELECT * FROM translation_jobs WHERE id = ? AND user_id = ?', jobId, userId);
  if (!job) throw new AppError('not_found');
  return job;
}

export async function getJobResult(svc: Services, userId: string, jobId: string): Promise<{ job: JobRow; result: NormalizedSignResult }> {
  const job = await getOwnedJob(svc, userId, jobId);
  if (job.status === 'queued' || job.status === 'processing') throw new AppError('job_not_ready', { details: { status: job.status } });
  if (job.status !== 'completed' && job.status !== 'partially_completed') {
    throw new AppError('not_found', { details: { reason: 'no_result', status: job.status, failureCode: job.failure_code } });
  }
  const row = await first<{ result_json: string; expires_at: number }>(svc.db, 'SELECT result_json, expires_at FROM translation_job_results WHERE job_id = ?', jobId);
  if (!row || row.expires_at <= svc.now()) throw new AppError('not_found', { details: { reason: 'result_expired' } });
  return { job, result: parseJson<NormalizedSignResult>(row.result_json, null as unknown as NormalizedSignResult) };
}

export async function cancelJob(svc: Services, userId: string, jobId: string): Promise<JobRow> {
  const job = await getOwnedJob(svc, userId, jobId);
  const now = svc.now();
  const changed = await run(
    svc.db,
    `UPDATE translation_jobs SET status = 'cancelled', failure_code = 'cancelled_by_user', lease_until = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status IN ('queued','processing')`,
    now, now, jobId, userId,
  );
  if (!changed) throw new AppError('job_not_cancellable', { details: { status: job.status } });
  await purgeEphemeralInput(svc, jobId);
  if (job.usage_event_id) await releaseUsage(svc, job.usage_event_id, 'cancelled');
  return (await first<JobRow>(svc.db, 'SELECT * FROM translation_jobs WHERE id = ?', jobId))!;
}

/** Scheduled maintenance: expire overdue jobs, purge ephemeral data and old metadata. */
export async function sweepJobs(svc: Services): Promise<{ expired: number; purgedInputs: number; purgedResults: number; deletedJobs: number }> {
  const now = svc.now();
  const overdue = await svc.db
    .prepare(`SELECT id, usage_event_id FROM translation_jobs WHERE status IN ('queued','processing') AND deadline_at < ? LIMIT 500`)
    .bind(now)
    .all<{ id: string; usage_event_id: string | null }>();
  for (const j of overdue.results ?? []) await expireJob(svc, j);
  const purgedInputs = await run(
    svc.db,
    `DELETE FROM translation_job_inputs WHERE expires_at < ?
        OR job_id IN (SELECT id FROM translation_jobs WHERE status NOT IN ('queued','processing'))`,
    now,
  );
  const purgedResults = await run(svc.db, 'DELETE FROM translation_job_results WHERE expires_at < ?', now);
  const deletedJobs = await run(svc.db, 'DELETE FROM translation_jobs WHERE created_at < ? AND status NOT IN (\'queued\',\'processing\')', now - JOB_METADATA_RETENTION);
  return { expired: overdue.results?.length ?? 0, purgedInputs, purgedResults, deletedJobs };
}
