import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context';
import { AppError } from '../../lib/errors';
import { body, ok } from '../../lib/http';
import { MINUTE } from '../../lib/time';
import { requireAuth } from '../../middleware';
import { normalizeInput } from '../emoji/engine';
import { requireFlag } from '../flags/service';
import { enforce } from '../ratelimit/service';
import { orgContextFromHeader, resolveBillingContext } from '../usage/entitlements';
import { cancelJob, createSignJob, getJobResult, getOwnedJob, jobView } from './jobs';

export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_\-:.]{8,128}$/);

export function idempotencyKeyFrom(header: string | undefined): string | null {
  if (header === undefined) return null;
  const parsed = IdempotencyKey.safeParse(header);
  if (!parsed.success) throw new AppError('validation_error', { details: { issues: [{ path: 'Idempotency-Key', code: 'invalid_format' }] } });
  return parsed.data;
}

export function orgContext(c: { req: { header(n: string): string | undefined } }): string | null {
  const org = orgContextFromHeader(c.req.header('x-organization-id'));
  if (org === '__invalid__') throw new AppError('not_found');
  return org;
}

const TranslateSchema = z.object({
  text: z.string().max(10_000),
  language: z.literal('he').default('he'),
  outputFormat: z.enum(['avatar_sequence', 'gloss']).default('avatar_sequence'),
});

export const signRoutes = new Hono<AppEnv>();
signRoutes.use('*', requireAuth);

signRoutes.post('/translate', async (c) => {
  const svc = c.get('services');
  const user = c.get('auth')!.user;
  await requireFlag(svc, 'sign_translation');
  const input = await body(c, TranslateSchema);
  const idempotencyKey = idempotencyKeyFrom(c.req.header('idempotency-key'));
  const ctx = await resolveBillingContext(svc, user.id, orgContext(c));
  if (!ctx.entitlements['sign.enabled']) throw new AppError('entitlement_required', { details: { feature: 'sign' } });
  await enforce(svc, 'translate_user', user.id, ctx.entitlements['rate.requests_per_minute'], MINUTE);

  const text = normalizeInput(input.text);
  if (!text) throw new AppError('empty_input');
  const max = ctx.entitlements['sign.max_input_chars'];
  if (text.length > max) throw new AppError('input_too_long', { details: { maxChars: max, length: text.length } });

  const outcome = await createSignJob(svc, user.id, ctx, { text, language: input.language, outputFormat: input.outputFormat, idempotencyKey }, c.get('requestId'));
  const job = outcome.job;
  const finished = job.status !== 'queued' && job.status !== 'processing';
  return ok(
    c,
    { job: jobView(job) },
    { idempotentReplay: outcome.kind === 'existing', processedInline: outcome.kind === 'created' && outcome.processedInline, pollAfterMs: finished ? null : 1000 },
    outcome.kind === 'existing' || finished ? 200 : 202,
  );
});

signRoutes.get('/jobs/:jobId', async (c) => {
  const job = await getOwnedJob(c.get('services'), c.get('auth')!.user.id, c.req.param('jobId'));
  return ok(c, { job: jobView(job) });
});

signRoutes.get('/jobs/:jobId/result', async (c) => {
  const { job, result } = await getJobResult(c.get('services'), c.get('auth')!.user.id, c.req.param('jobId'));
  return ok(c, { job: jobView(job), result });
});

signRoutes.post('/jobs/:jobId/cancel', async (c) => {
  const job = await cancelJob(c.get('services'), c.get('auth')!.user.id, c.req.param('jobId'));
  return ok(c, { job: jobView(job) });
});
