import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context';
import { newId } from '../../lib/crypto';
import { all, first, parseJson, run } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { body, ok, page, PageQuery, query } from '../../lib/http';
import { iso } from '../../lib/time';
import { requireAuth } from '../../middleware';
import { audit } from '../audit/service';
import { effectivePlanId, getLiveSubscription, getPlanEntitlements } from '../usage/entitlements';
import type { UserRow } from '../users/model';

/**
 * OPT-IN saved translations ("Translation History" screen).
 * Nothing is saved automatically: the client must call POST /history for a specific
 * translation, AND the user must have enabled history (recorded consent), AND the
 * plan must include `history.available`. Items stay until the user deletes them,
 * clears history, or deletes the account.
 */
export const historyRoutes = new Hono<AppEnv>();
historyRoutes.use('*', requireAuth);

const MAX_ITEMS_PER_USER = 1000;

async function assertHistoryAllowed(c: Context<AppEnv>): Promise<UserRow> {
  const svc = c.get('services');
  const user = (await first<UserRow>(svc.db, 'SELECT * FROM users WHERE id = ?', c.get('auth')!.user.id))!;
  if (user.history_enabled !== 1) throw new AppError('feature_disabled', { details: { feature: 'history', reason: 'not_enabled_by_user' } });
  const planId = effectivePlanId(await getLiveSubscription(svc, 'user', user.id), svc.now());
  if (!(await getPlanEntitlements(svc, planId))['history.available']) throw new AppError('entitlement_required', { details: { feature: 'history' } });
  return user;
}

const SaveSchema = z
  .object({
    kind: z.enum(['emoji', 'sign']),
    sourceText: z.string().trim().min(1).max(5000),
    language: z.enum(['he', 'en']),
    output: z.union([
      z.object({ result: z.string().max(10_000), mode: z.enum(['emoji_only', 'text_and_emoji']), style: z.enum(['minimal', 'standard', 'expressive']) }).strict(),
      z.object({ verificationStatus: z.string().max(30), glosses: z.array(z.string().max(100)).max(500) }).strict(),
    ]),
  })
  .strict();

historyRoutes.post('/', async (c) => {
  const svc = c.get('services');
  const user = await assertHistoryAllowed(c);
  const input = await body(c, SaveSchema);
  const count = (await first<{ n: number }>(svc.db, 'SELECT COUNT(*) AS n FROM saved_translations WHERE user_id = ?', user.id))?.n ?? 0;
  if (count >= MAX_ITEMS_PER_USER) throw new AppError('quota_exceeded', { details: { limitType: 'saved_history_items', limit: MAX_ITEMS_PER_USER } });
  const id = newId('svd');
  await run(
    svc.db,
    'INSERT INTO saved_translations (id, user_id, kind, source_text, output_json, language, created_at) VALUES (?,?,?,?,?,?,?)',
    id, user.id, input.kind, input.sourceText, JSON.stringify(input.output), input.language, svc.now(),
  );
  return ok(c, { id }, {}, 201);
});

historyRoutes.get('/', async (c) => {
  const svc = c.get('services');
  const userId = c.get('auth')!.user.id;
  const q = query(
    c,
    PageQuery.extend({
      q: z.string().trim().max(100).optional(),
      kind: z.enum(['emoji', 'sign']).optional(),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
    }),
  );
  // Listing is always allowed (even if history was later disabled) so users can see and delete their data.
  const rows = await all<{ id: string; kind: string; source_text: string; output_json: string; language: string; created_at: number }>(
    svc.db,
    `SELECT id, kind, source_text, output_json, language, created_at FROM saved_translations
      WHERE user_id = ?1
        AND (?2 IS NULL OR kind = ?2)
        AND (?3 IS NULL OR instr(lower(source_text), lower(?3)) > 0)
        AND (?4 IS NULL OR created_at >= ?4) AND (?5 IS NULL OR created_at <= ?5)
      ORDER BY created_at DESC LIMIT ?6 OFFSET ?7`,
    userId, q.kind ?? null, q.q || null, q.from ? Date.parse(q.from) : null, q.to ? Date.parse(q.to) : null, q.limit + 1, q.cursor,
  );
  const p = page(rows, q.limit, q.cursor);
  return ok(c, {
    items: p.items.map((r) => ({ id: r.id, kind: r.kind, sourceText: r.source_text, output: parseJson(r.output_json, {}), language: r.language, createdAt: iso(r.created_at) })),
    nextCursor: p.nextCursor,
  });
});

historyRoutes.delete('/:id', async (c) => {
  const svc = c.get('services');
  const changed = await run(svc.db, 'DELETE FROM saved_translations WHERE id = ? AND user_id = ?', c.req.param('id'), c.get('auth')!.user.id);
  if (!changed) throw new AppError('not_found');
  return ok(c, { status: 'deleted' });
});

historyRoutes.delete('/', async (c) => {
  const svc = c.get('services');
  const userId = c.get('auth')!.user.id;
  const deleted = await run(svc.db, 'DELETE FROM saved_translations WHERE user_id = ?', userId);
  await audit(svc, { action: 'privacy.history_cleared', actorUserId: userId, requestId: c.get('requestId'), metadata: { deleted } });
  return ok(c, { deleted });
});
