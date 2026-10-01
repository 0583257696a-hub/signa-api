import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from '../context';
import { AppError } from './errors';

/** Standard success envelope: `{ data, meta: { requestId, ... } }`. */
export function ok<T>(c: Context<AppEnv>, data: T, meta: Record<string, unknown> = {}, status: ContentfulStatusCode = 200) {
  return c.json({ data, meta: { requestId: c.get('requestId'), ...meta } }, status);
}

const MAX_JSON_BYTES = 64 * 1024;

/** Parses and validates a JSON body. Unknown keys are stripped (prevents mass assignment). */
export async function body<S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.infer<S>> {
  const len = Number(c.req.header('content-length') ?? '0');
  if (len > MAX_JSON_BYTES) throw new AppError('payload_too_large');
  const ct = c.req.header('content-type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) throw new AppError('unsupported_media_type');
  let raw: unknown;
  try {
    const text = await c.req.text();
    if (text.length > MAX_JSON_BYTES) throw new AppError('payload_too_large');
    raw = text.length ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('bad_request', { details: { reason: 'malformed_json' } });
  }
  return validate(schema, raw);
}

export function query<S extends z.ZodType>(c: Context<AppEnv>, schema: S): z.infer<S> {
  return validate(schema, c.req.query());
}

export function validate<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('validation_error', {
      details: {
        // Field paths and issue codes only; never echo submitted values.
        issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), code: i.code })),
      },
    });
  }
  return parsed.data;
}

/** Bounded pagination: limit ∈ [1, 100], opaque offset cursor. */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z
    .string()
    .regex(/^\d{1,7}$/)
    .optional()
    .transform((v) => (v ? Number(v) : 0)),
});

export function page<T>(rows: T[], limit: number, offset: number) {
  const hasMore = rows.length > limit;
  return {
    items: hasMore ? rows.slice(0, limit) : rows,
    nextCursor: hasMore ? String(offset + limit) : null,
  };
}
