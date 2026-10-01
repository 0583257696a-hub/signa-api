import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context';
import { all, first, run } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { body, ok } from '../../lib/http';
import { iso } from '../../lib/time';
import { requireAuth, requireRecentAuth } from '../../middleware';
import { audit } from '../audit/service';
import { checkPassword, notifySecurityEvent } from '../auth/service';
import { clearSessionCookie, revokeAllSessions, revokeSession } from '../auth/session';
import { deleteAccount, exportAccount } from '../privacy/service';
import { getPlanEntitlements, getLiveSubscription, effectivePlanId } from '../usage/entitlements';
import { toSelfView, type UserRow } from './model';

const TimeZone = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'invalid_time_zone');

const UpdateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    locale: z.enum(['he', 'en']),
    direction: z.enum(['ltr', 'rtl']).nullable(), // null = derive from locale
    timeZone: TimeZone,
    accessibility: z
      .object({ reduceMotion: z.boolean(), highContrast: z.boolean(), largeText: z.boolean(), captions: z.boolean() })
      .partial()
      .strict(),
    preferences: z
      .object({
        defaultMode: z.enum(['sign', 'emoji']),
        playbackSpeed: z.union([z.literal(0.5), z.literal(0.75), z.literal(1), z.literal(1.25), z.literal(1.5)]),
        emojiStyle: z.enum(['minimal', 'standard', 'expressive']),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict(); // unknown fields (e.g. status, platform_role, email) are rejected: no mass assignment

/** Current version of the saved-history disclosure the user agrees to. */
export const HISTORY_DISCLOSURE_VERSION = '2026-10-01';

export const meRoutes = new Hono<AppEnv>();
meRoutes.use('*', requireAuth);

async function loadMe(c: Context<AppEnv>) {
  const svc = c.get('services');
  const user = (await first<UserRow>(svc.db, 'SELECT * FROM users WHERE id = ?', c.get('auth')!.user.id))!;
  const orgs = await all<{ id: string; name: string; slug: string; status: string; role: string }>(
    svc.db,
    `SELECT o.id, o.name, o.slug, o.status, m.role FROM organization_members m
       JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? AND o.status <> 'deleted' ORDER BY o.name`,
    user.id,
  );
  const sub = await getLiveSubscription(svc, 'user', user.id);
  const planId = effectivePlanId(sub, svc.now());
  return {
    user: toSelfView(user),
    organizations: orgs,
    plan: { id: planId, subscriptionStatus: sub?.status ?? null, historyAvailable: (await getPlanEntitlements(svc, planId))['history.available'] },
  };
}

meRoutes.get('/', async (c) => ok(c, await loadMe(c)));

meRoutes.patch('/', async (c) => {
  const svc = c.get('services');
  const user = c.get('auth')!.user;
  const input = await body(c, UpdateMeSchema);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (input.name !== undefined) (sets.push('name = ?'), params.push(input.name));
  if (input.locale !== undefined) (sets.push('locale = ?'), params.push(input.locale));
  if (input.direction !== undefined) (sets.push('direction = ?'), params.push(input.direction));
  if (input.timeZone !== undefined) (sets.push('time_zone = ?'), params.push(input.timeZone));
  if (input.accessibility !== undefined) {
    const merged = { ...JSON.parse(user.accessibility_json || '{}'), ...input.accessibility };
    sets.push('accessibility_json = ?');
    params.push(JSON.stringify(merged));
  }
  if (input.preferences !== undefined) {
    const merged = { ...JSON.parse(user.preferences_json || '{}'), ...input.preferences };
    sets.push('preferences_json = ?');
    params.push(JSON.stringify(merged));
  }
  if (sets.length) {
    await run(svc.db, `UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, svc.now(), user.id);
  }
  return ok(c, await loadMe(c));
});

/** Explicit opt-in / opt-out for saved history. Enabling records consent and requires the entitlement. */
meRoutes.put('/privacy/history', async (c) => {
  const svc = c.get('services');
  const user = c.get('auth')!.user;
  const input = await body(c, z.object({ enabled: z.boolean(), consentVersion: z.string().max(20).optional() }).strict());
  if (input.enabled) {
    if (input.consentVersion !== HISTORY_DISCLOSURE_VERSION) {
      throw new AppError('validation_error', { details: { issues: [{ path: 'consentVersion', code: 'must_accept_current_disclosure' }], currentVersion: HISTORY_DISCLOSURE_VERSION } });
    }
    const planId = effectivePlanId(await getLiveSubscription(svc, 'user', user.id), svc.now());
    if (!(await getPlanEntitlements(svc, planId))['history.available']) throw new AppError('entitlement_required', { details: { feature: 'history' } });
    await run(svc.db, 'UPDATE users SET history_enabled = 1, history_consent_at = ?, history_consent_version = ?, updated_at = ? WHERE id = ?', svc.now(), input.consentVersion, svc.now(), user.id);
  } else {
    await run(svc.db, 'UPDATE users SET history_enabled = 0, updated_at = ? WHERE id = ?', svc.now(), user.id);
  }
  await audit(svc, { action: input.enabled ? 'privacy.history_enabled' : 'privacy.history_disabled', actorUserId: user.id, requestId: c.get('requestId') });
  return ok(c, await loadMe(c));
});

meRoutes.get('/export', async (c) => {
  const svc = c.get('services');
  const user = (await first<UserRow>(svc.db, 'SELECT * FROM users WHERE id = ?', c.get('auth')!.user.id))!;
  await audit(svc, { action: 'privacy.export', actorUserId: user.id, requestId: c.get('requestId') });
  return ok(c, await exportAccount(svc, user));
});

const ConfirmSchema = z.object({ password: z.string().max(128).optional(), confirm: z.string().max(20).optional() }).strict();

/** Identity check: password if the account has one, otherwise a recent re-authentication. */
async function verifyIdentity(c: Context<AppEnv>, password: string | undefined) {
  const svc = c.get('services');
  const auth = c.get('auth')!;
  const hasPassword = await first<{ user_id: string }>(svc.db, 'SELECT user_id FROM user_credentials WHERE user_id = ?', auth.user.id);
  if (hasPassword) {
    if (!password || !(await checkPassword(svc, auth.user.id, password))) throw new AppError('invalid_credentials');
  } else {
    requireRecentAuth(svc.now(), auth.session.authenticated_at);
  }
}

meRoutes.post('/deactivate', async (c) => {
  const svc = c.get('services');
  const auth = c.get('auth')!;
  const input = await body(c, ConfirmSchema);
  await verifyIdentity(c, input.password);
  await run(svc.db, `UPDATE users SET status = 'deactivated', updated_at = ? WHERE id = ?`, svc.now(), auth.user.id);
  await revokeAllSessions(svc, auth.user.id, 'account_deactivated');
  clearSessionCookie(c);
  await audit(svc, { action: 'account.deactivated', actorUserId: auth.user.id, requestId: c.get('requestId') });
  await notifySecurityEvent(svc, auth.user.id, 'account_deactivated');
  return ok(c, { status: 'deactivated', reactivation: 'sign_in_again' });
});

meRoutes.delete('/', async (c) => {
  const svc = c.get('services');
  const auth = c.get('auth')!;
  const input = await body(c, ConfirmSchema);
  if (input.confirm !== 'DELETE') {
    throw new AppError('validation_error', { details: { issues: [{ path: 'confirm', code: 'must_equal_DELETE' }] } });
  }
  await verifyIdentity(c, input.password);
  await deleteAccount(svc, auth.user, c.get('requestId'));
  clearSessionCookie(c);
  return ok(c, { status: 'deleted' });
});

meRoutes.get('/sessions', async (c) => {
  const svc = c.get('services');
  const auth = c.get('auth')!;
  const rows = await all<{ id: string; auth_method: string; user_agent: string | null; created_at: number; last_seen_at: number; expires_at: number }>(
    svc.db,
    `SELECT id, auth_method, user_agent, created_at, last_seen_at, expires_at FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 50`,
    auth.user.id,
    svc.now(),
  );
  return ok(c, {
    sessions: rows.map((s) => ({
      id: s.id,
      current: s.id === auth.session.id,
      method: s.auth_method,
      userAgent: s.user_agent,
      createdAt: iso(s.created_at),
      lastSeenAt: iso(s.last_seen_at),
      expiresAt: iso(s.expires_at),
    })),
  });
});

meRoutes.delete('/sessions/:id', async (c) => {
  const svc = c.get('services');
  const auth = c.get('auth')!;
  const id = c.req.param('id');
  // Ownership enforced in the query itself.
  const target = await first<{ id: string }>(svc.db, 'SELECT id FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL', id, auth.user.id);
  if (!target) throw new AppError('not_found');
  await revokeSession(svc, id, 'revoked_by_user');
  if (id === auth.session.id) clearSessionCookie(c);
  await audit(svc, { action: 'auth.session_revoked', actorUserId: auth.user.id, targetType: 'session', targetId: id, requestId: c.get('requestId') });
  return ok(c, { status: 'revoked', current: id === auth.session.id });
});

meRoutes.post('/sessions/revoke-others', async (c) => {
  const svc = c.get('services');
  const auth = c.get('auth')!;
  const count = await revokeAllSessions(svc, auth.user.id, 'revoked_by_user', auth.session.id);
  await audit(svc, { action: 'auth.sessions_revoked', actorUserId: auth.user.id, requestId: c.get('requestId'), metadata: { count } });
  if (count) await notifySecurityEvent(svc, auth.user.id, 'sessions_revoked');
  return ok(c, { revoked: count });
});
