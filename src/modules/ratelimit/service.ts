import type { Services } from '../../context';
import { first } from '../../lib/db';
import { hmacHex } from '../../lib/crypto';
import { AppError } from '../../lib/errors';

/**
 * Fixed-window rate limiter backed by D1. The increment is a single atomic
 * UPSERT, so concurrent requests cannot both observe a stale count.
 * Identifiers (IP, email) are stored only as keyed HMACs.
 */
export async function hit(
  svc: Services,
  bucket: string,
  identifier: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const now = svc.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = `${bucket}:${(await hmacHex(svc.config.APP_SECRET, `${bucket}|${identifier}`)).slice(0, 32)}`;
  const row = await first<{ count: number }>(
    svc.db,
    `INSERT INTO rate_limits (key, window_start, count, expires_at) VALUES (?,?,1,?)
     ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
    key,
    windowStart,
    windowStart + windowMs,
  );
  const count = row?.count ?? 1;
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt: windowStart + windowMs };
}

export async function enforce(
  svc: Services,
  bucket: string,
  identifier: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const r = await hit(svc, bucket, identifier, limit, windowMs);
  if (!r.allowed) {
    const retryAfter = Math.max(1, Math.ceil((r.resetAt - svc.now()) / 1000));
    throw new AppError('rate_limited', { headers: { 'Retry-After': String(retryAfter) }, details: { retryAfterSeconds: retryAfter } });
  }
}
