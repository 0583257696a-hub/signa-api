import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context';
import { newId, randomToken, sha256Hex } from '../../lib/crypto';
import { all, batch, first, isUniqueViolation, parseJson, run, stmt } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { body, ok } from '../../lib/http';
import { DAY, iso, utcPeriod } from '../../lib/time';
import { requireAuth, requireRecentAuth } from '../../middleware';
import { audit } from '../audit/service';
import { sendTemplatedEmail } from '../email/service';
import { subscriptionView } from '../billing/service';
import { getLiveSubscription, resolveBillingContext } from '../usage/entitlements';
import { usageSummary } from '../usage/service';
import { normalizeEmail } from '../users/model';
import { requireMembership, roleAtLeast, type OrganizationRow, type OrgRole } from './access';

export const INVITATION_TTL = 7 * DAY;

const OrgSettingsSchema = z
  .object({
    defaultTranslationMode: z.enum(['sign', 'emoji']),
    allowMemberEmojiExpressive: z.boolean(),
  })
  .partial()
  .strict();

export function orgView(o: OrganizationRow, role?: OrgRole) {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    status: o.status,
    defaultLocale: o.default_locale,
    settings: parseJson(o.settings_json, {}),
    suspendedAt: iso(o.suspended_at),
    createdAt: iso(o.created_at),
    ...(role ? { role } : {}),
  };
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export const orgRoutes = new Hono<AppEnv>();
orgRoutes.use('*', requireAuth);

orgRoutes.post('/', async (c) => {
  const svc = c.get('services');
  const user = c.get('auth')!.user;
  if (user.email_verified_at === null) throw new AppError('email_not_verified');
  const input = await body(
    c,
    z.object({ name: z.string().trim().min(2).max(100), slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/).optional(), defaultLocale: z.enum(['he', 'en']).default('he') }).strict(),
  );
  const owned = (await first<{ n: number }>(svc.db, `SELECT COUNT(*) AS n FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? AND m.role = 'owner' AND o.status <> 'deleted'`, user.id))?.n ?? 0;
  if (owned >= 10) throw new AppError('quota_exceeded', { details: { limitType: 'owned_organizations', limit: 10 } });
  const id = newId('org');
  const now = svc.now();
  const slug = input.slug ?? (slugify(input.name) || 'org') + '-' + id.slice(-6);
  try {
    await batch(svc.db, [
      stmt(svc.db, `INSERT INTO organizations (id, name, slug, status, default_locale, created_by, created_at, updated_at) VALUES (?,?,?, 'active', ?,?,?,?)`, id, input.name, slug, input.defaultLocale, user.id, now, now),
      stmt(svc.db, `INSERT INTO organization_members (organization_id, user_id, role, created_at, updated_at) VALUES (?,?, 'owner', ?, ?)`, id, user.id, now, now),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('conflict', { details: { reason: 'slug_taken' } });
    throw e;
  }
  await audit(svc, { action: 'org.created', actorUserId: user.id, organizationId: id, targetType: 'organization', targetId: id, requestId: c.get('requestId') });
  const org = (await first<OrganizationRow>(svc.db, 'SELECT * FROM organizations WHERE id = ?', id))!;
  return ok(c, { organization: orgView(org, 'owner') }, {}, 201);
});

orgRoutes.get('/', async (c) => {
  const svc = c.get('services');
  const rows = await all<OrganizationRow & { role: OrgRole }>(
    svc.db,
    `SELECT o.*, m.role FROM organizations o JOIN organization_members m ON m.organization_id = o.id
      WHERE m.user_id = ? AND o.status <> 'deleted' ORDER BY o.name LIMIT 100`,
    c.get('auth')!.user.id,
  );
  return ok(c, { organizations: rows.map((r) => orgView(r, r.role)) });
});

/** Invitation acceptance (registered before /:organizationId routes). */
orgRoutes.post('/invitations/accept', async (c) => {
  const svc = c.get('services');
  const user = c.get('auth')!.user;
  const { token } = await body(c, z.object({ token: z.string().min(20).max(100) }).strict());
  const now = svc.now();
  const inv = await first<{ id: string; organization_id: string; email_normalized: string; role: OrgRole; expires_at: number; accepted_at: number | null; revoked_at: number | null }>(
    svc.db,
    'SELECT * FROM organization_invitations WHERE token_hash = ?',
    await sha256Hex(token),
  );
  if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at <= now) throw new AppError('invalid_token');
  // The invitation is bound to the invited address, which the user must have verified.
  if (inv.email_normalized !== user.email_normalized) throw new AppError('forbidden', { details: { reason: 'invitation_for_different_email' } });
  if (user.email_verified_at === null) throw new AppError('email_not_verified');
  const org = await first<OrganizationRow>(svc.db, `SELECT * FROM organizations WHERE id = ? AND status = 'active'`, inv.organization_id);
  if (!org) throw new AppError('invalid_token');
  const claimed = await run(svc.db, 'UPDATE organization_invitations SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL', now, user.id, inv.id);
  if (!claimed) throw new AppError('invalid_token');
  await run(
    svc.db,
    `INSERT INTO organization_members (organization_id, user_id, role, created_at, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT (organization_id, user_id) DO NOTHING`,
    inv.organization_id, user.id, inv.role, now, now,
  );
  await audit(svc, { action: 'org.invitation_accepted', actorUserId: user.id, organizationId: inv.organization_id, targetType: 'invitation', targetId: inv.id, requestId: c.get('requestId') });
  const m = await requireMembership(svc, user.id, inv.organization_id);
  return ok(c, { organization: orgView(m.organization, m.role) });
});

orgRoutes.get('/:organizationId', async (c) => {
  const svc = c.get('services');
  const m = await requireMembership(svc, c.get('auth')!.user.id, c.req.param('organizationId'), 'member', { allowSuspended: true });
  const data: Record<string, unknown> = { organization: orgView(m.organization, m.role) };
  if (roleAtLeast(m.role, 'admin')) data.subscription = subscriptionView(await getLiveSubscription(svc, 'organization', m.organization.id));
  return ok(c, data);
});

orgRoutes.patch('/:organizationId', async (c) => {
  const svc = c.get('services');
  const user = c.get('auth')!.user;
  const input = await body(c, z.object({ name: z.string().trim().min(2).max(100), defaultLocale: z.enum(['he', 'en']), settings: OrgSettingsSchema }).partial().strict());
  // Admins manage operational fields; organization-wide settings are owner-only.
  const m = await requireMembership(svc, user.id, c.req.param('organizationId'), input.settings ? 'owner' : 'admin');
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (input.name) (sets.push('name = ?'), params.push(input.name));
  if (input.defaultLocale) (sets.push('default_locale = ?'), params.push(input.defaultLocale));
  if (input.settings) (sets.push('settings_json = ?'), params.push(JSON.stringify({ ...parseJson(m.organization.settings_json, {}), ...input.settings })));
  if (sets.length) await run(svc.db, `UPDATE organizations SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, svc.now(), m.organization.id);
  await audit(svc, { action: 'org.updated', actorUserId: user.id, organizationId: m.organization.id, requestId: c.get('requestId'), metadata: { fields: Object.keys(input).join(',') } });
  const org = (await first<OrganizationRow>(svc.db, 'SELECT * FROM organizations WHERE id = ?', m.organization.id))!;
  return ok(c, { organization: orgView(org, m.role) });
});

orgRoutes.delete('/:organizationId', async (c) => {
  const svc = c.get('services');
  const auth = c.get('auth')!;
  const m = await requireMembership(svc, auth.user.id, c.req.param('organizationId'), 'owner', { allowSuspended: true });
  requireRecentAuth(svc.now(), auth.session.authenticated_at);
  const sub = await getLiveSubscription(svc, 'organization', m.organization.id);
  if (sub?.provider_subscription_ref && sub.provider === svc.payment.name) await svc.payment.cancelSubscription(sub.provider_subscription_ref, { atPeriodEnd: false });
  const now = svc.now();
  await batch(svc.db, [
    stmt(svc.db, `UPDATE organizations SET status = 'deleted', updated_at = ? WHERE id = ?`, now, m.organization.id),
    stmt(svc.db, `UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE subject_type = 'organization' AND subject_id = ? AND status IN ('trialing','active','past_due','suspended')`, now, now, m.organization.id),
    stmt(svc.db, 'DELETE FROM organization_invitations WHERE organization_id = ? AND accepted_at IS NULL', m.organization.id),
    stmt(svc.db, 'DELETE FROM organization_members WHERE organization_id = ?', m.organization.id),
  ]);
  await audit(svc, { action: 'org.deleted', actorUserId: auth.user.id, organizationId: m.organization.id, requestId: c.get('requestId') });
  return ok(c, { status: 'deleted' });
});

// --- Members ---------------------------------------------------------------
orgRoutes.get('/:organizationId/members', async (c) => {
  const svc = c.get('services');
  const m = await requireMembership(svc, c.get('auth')!.user.id, c.req.param('organizationId'), 'member', { allowSuspended: true });
  const rows = await all<{ user_id: string; role: OrgRole; name: string; email: string; created_at: number }>(
    svc.db,
    `SELECT m.user_id, m.role, u.name, u.email, m.created_at FROM organization_members m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ? ORDER BY m.created_at LIMIT 500`,
    m.organization.id,
  );
  const showEmail = roleAtLeast(m.role, 'admin');
  return ok(c, { members: rows.map((r) => ({ userId: r.user_id, name: r.name, role: r.role, joinedAt: iso(r.created_at), ...(showEmail ? { email: r.email } : {}) })) });
});

async function ownerCount(db: D1Database, orgId: string): Promise<number> {
  return (await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND role = 'owner'`, orgId))?.n ?? 0;
}

orgRoutes.patch('/:organizationId/members/:userId', async (c) => {
  const svc = c.get('services');
  const actor = c.get('auth')!.user;
  const { role } = await body(c, z.object({ role: z.enum(['owner', 'admin', 'member']) }).strict());
  const m = await requireMembership(svc, actor.id, c.req.param('organizationId'), 'admin');
  const targetId = c.req.param('userId');
  const target = await first<{ role: OrgRole }>(svc.db, 'SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?', m.organization.id, targetId);
  if (!target) throw new AppError('not_found');
  // Admins may only move people between member/admin; anything touching ownership is owner-only.
  if ((role === 'owner' || target.role === 'owner') && m.role !== 'owner') throw new AppError('forbidden');
  if (target.role === 'owner' && role !== 'owner' && (await ownerCount(svc.db, m.organization.id)) <= 1) {
    throw new AppError('conflict', { details: { reason: 'last_owner' } });
  }
  await run(svc.db, 'UPDATE organization_members SET role = ?, updated_at = ? WHERE organization_id = ? AND user_id = ?', role, svc.now(), m.organization.id, targetId);
  await audit(svc, { action: 'org.member_role_changed', actorUserId: actor.id, organizationId: m.organization.id, targetType: 'user', targetId, requestId: c.get('requestId'), metadata: { from: target.role, to: role } });
  return ok(c, { userId: targetId, role });
});

orgRoutes.delete('/:organizationId/members/:userId', async (c) => {
  const svc = c.get('services');
  const actor = c.get('auth')!.user;
  const targetId = c.req.param('userId');
  const self = targetId === actor.id;
  const m = await requireMembership(svc, actor.id, c.req.param('organizationId'), self ? 'member' : 'admin', { allowSuspended: true });
  const target = await first<{ role: OrgRole }>(svc.db, 'SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?', m.organization.id, targetId);
  if (!target) throw new AppError('not_found');
  if (!self && target.role === 'owner' && m.role !== 'owner') throw new AppError('forbidden');
  if (!self && target.role === 'admin' && m.role === 'admin') throw new AppError('forbidden');
  if (target.role === 'owner' && (await ownerCount(svc.db, m.organization.id)) <= 1) throw new AppError('conflict', { details: { reason: 'last_owner' } });
  await run(svc.db, 'DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?', m.organization.id, targetId);
  await audit(svc, { action: self ? 'org.member_left' : 'org.member_removed', actorUserId: actor.id, organizationId: m.organization.id, targetType: 'user', targetId, requestId: c.get('requestId') });
  return ok(c, { status: 'removed' });
});

// --- Invitations -----------------------------------------------------------
orgRoutes.post('/:organizationId/invitations', async (c) => {
  const svc = c.get('services');
  const actor = c.get('auth')!.user;
  const input = await body(c, z.object({ email: z.email().max(254), role: z.enum(['admin', 'member']).default('member') }).strict());
  const m = await requireMembership(svc, actor.id, c.req.param('organizationId'), 'admin');
  const ctx = await resolveBillingContext(svc, actor.id, m.organization.id);
  const seats = ctx.entitlements['org.max_members'];
  const now = svc.now();
  const used = (await first<{ n: number }>(
    svc.db,
    `SELECT (SELECT COUNT(*) FROM organization_members WHERE organization_id = ?1)
          + (SELECT COUNT(*) FROM organization_invitations WHERE organization_id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2) AS n`,
    m.organization.id, now,
  ))?.n ?? 0;
  if (used >= seats) throw new AppError('entitlement_required', { details: { feature: 'org.max_members', limit: seats } });
  const emailNorm = normalizeEmail(input.email);
  const already = await first(svc.db, `SELECT 1 AS x FROM organization_members om JOIN users u ON u.id = om.user_id WHERE om.organization_id = ? AND u.email_normalized = ?`, m.organization.id, emailNorm);
  if (already) throw new AppError('conflict', { details: { reason: 'already_member' } });
  const token = randomToken();
  const id = newId('inv');
  await batch(svc.db, [
    stmt(svc.db, 'UPDATE organization_invitations SET revoked_at = ? WHERE organization_id = ? AND email_normalized = ? AND accepted_at IS NULL AND revoked_at IS NULL', now, m.organization.id, emailNorm),
    stmt(
      svc.db,
      'INSERT INTO organization_invitations (id, organization_id, email_normalized, role, token_hash, invited_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
      id, m.organization.id, emailNorm, input.role, await sha256Hex(token), actor.id, now, now + INVITATION_TTL,
    ),
  ]);
  await sendTemplatedEmail(svc, {
    to: input.email,
    template: 'org_invitation',
    locale: m.organization.default_locale,
    vars: { organizationName: m.organization.name, link: `${svc.config.APP_BASE_URL}/invitations/accept#token=${token}` },
    idempotencyKey: `invite:${id}`,
  });
  await audit(svc, { action: 'org.invitation_created', actorUserId: actor.id, organizationId: m.organization.id, targetType: 'invitation', targetId: id, requestId: c.get('requestId'), metadata: { role: input.role } });
  return ok(c, { invitation: { id, email: emailNorm, role: input.role, expiresAt: iso(now + INVITATION_TTL) } }, {}, 201);
});

orgRoutes.get('/:organizationId/invitations', async (c) => {
  const svc = c.get('services');
  const m = await requireMembership(svc, c.get('auth')!.user.id, c.req.param('organizationId'), 'admin', { allowSuspended: true });
  const rows = await all<{ id: string; email_normalized: string; role: string; created_at: number; expires_at: number }>(
    svc.db,
    `SELECT id, email_normalized, role, created_at, expires_at FROM organization_invitations
      WHERE organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 200`,
    m.organization.id, svc.now(),
  );
  return ok(c, { invitations: rows.map((r) => ({ id: r.id, email: r.email_normalized, role: r.role, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at) })) });
});

orgRoutes.delete('/:organizationId/invitations/:invitationId', async (c) => {
  const svc = c.get('services');
  const actor = c.get('auth')!.user;
  const m = await requireMembership(svc, actor.id, c.req.param('organizationId'), 'admin', { allowSuspended: true });
  const changed = await run(
    svc.db,
    'UPDATE organization_invitations SET revoked_at = ? WHERE id = ? AND organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL',
    svc.now(), c.req.param('invitationId'), m.organization.id,
  );
  if (!changed) throw new AppError('not_found');
  await audit(svc, { action: 'org.invitation_revoked', actorUserId: actor.id, organizationId: m.organization.id, targetId: c.req.param('invitationId'), requestId: c.get('requestId') });
  return ok(c, { status: 'revoked' });
});

// --- Usage -----------------------------------------------------------------
orgRoutes.get('/:organizationId/usage', async (c) => {
  const svc = c.get('services');
  const user = c.get('auth')!.user;
  const m = await requireMembership(svc, user.id, c.req.param('organizationId'), 'admin', { allowSuspended: true });
  const ctx = await resolveBillingContext(svc, user.id, m.organization.id).catch(async (e) => {
    if (e instanceof AppError && e.code === 'organization_suspended') return null;
    throw e;
  });
  const summary = ctx ? await usageSummary(svc, ctx) : null;
  // Aggregate per-member counts only (no content exists to show).
  const perMember = await all<{ user_id: string; feature: string; n: number }>(
    svc.db,
    `SELECT user_id, feature, COUNT(*) AS n FROM usage_events
      WHERE subject_type = 'organization' AND subject_id = ? AND period = ? AND outcome = 'succeeded'
      GROUP BY user_id, feature`,
    m.organization.id, utcPeriod(svc.now()),
  );
  return ok(c, { usage: summary, organizationStatus: m.organization.status, members: perMember.map((r) => ({ userId: r.user_id, feature: r.feature, successfulRequests: r.n })) });
});
