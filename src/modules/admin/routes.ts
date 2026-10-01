import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context';
import { all, first, parseJson, run } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { body, ok, page, PageQuery, query } from '../../lib/http';
import { DAY, hourBucket, iso, utcPeriod } from '../../lib/time';
import { hasPlatformRole, requirePlatformRole, requireRecentAuth } from '../../middleware';
import { audit } from '../audit/service';
import { revokeAllSessions } from '../auth/session';
import { createSubscription, planView, subscriptionView, transitionSubscription, type PlanRow } from '../billing/service';
import type { OrganizationRow } from '../orgs/access';
import { orgView } from '../orgs/routes';
import { ENTITLEMENT_KEYS, effectivePlanId, getLiveSubscription, getPlanEntitlements, type SubscriptionRow } from '../usage/entitlements';
import { toAdminView, type PlatformRole, type UserRow } from '../users/model';

/**
 * Platform administration. Platform roles (support < admin < superadmin) are separate
 * from organization roles. High-risk operations require superadmin AND a recent
 * re-authentication (step-up). All sensitive actions are audited. No endpoint exposes
 * credentials, tokens or translation content (Signa does not store the latter).
 */
export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('*', requirePlatformRole('support'));

const me = (c: Context<AppEnv>) => c.get('auth')!;
const stepUp = (c: Context<AppEnv>) => requireRecentAuth(c.get('services').now(), me(c).session.authenticated_at);
const needRole = (c: Context<AppEnv>, role: PlatformRole) => {
  if (!hasPlatformRole(me(c).user.platform_role, role)) throw new AppError('forbidden');
};
const auditAdmin = (c: Context<AppEnv>, action: string, targetType: string, targetId: string, metadata: Record<string, string | number | boolean | null> = {}, organizationId?: string) =>
  audit(c.get('services'), { action, actorUserId: me(c).user.id, actorRole: me(c).user.platform_role, targetType, targetId, requestId: c.get('requestId'), metadata, organizationId: organizationId ?? null });

// --- Overview --------------------------------------------------------------
adminRoutes.get('/overview', async (c) => {
  const svc = c.get('services');
  const days = query(c, z.object({ days: z.coerce.number().int().min(1).max(90).default(30) })).days;
  const since = svc.now() - days * DAY;
  const [users, subs, perDay, outcomes, latency] = await Promise.all([
    first<{ total: number; recent: number }>(svc.db, `SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent FROM users WHERE status <> 'deleted'`, since),
    first<{ n: number }>(svc.db, `SELECT COUNT(*) AS n FROM subscriptions WHERE status IN ('trialing','active','past_due')`),
    all<{ day: string; feature: string; n: number }>(
      svc.db,
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, feature, COUNT(*) AS n FROM usage_events
        WHERE created_at >= ? AND outcome IN ('succeeded','failed') GROUP BY day, feature ORDER BY day`,
      since,
    ),
    all<{ outcome: string; n: number }>(svc.db, 'SELECT outcome, COUNT(*) AS n FROM usage_events WHERE created_at >= ? GROUP BY outcome', since),
    first<{ count: number; sum_value: number; max_value: number }>(
      svc.db,
      `SELECT SUM(count) AS count, SUM(sum_value) AS sum_value, MAX(max_value) AS max_value FROM ops_metrics WHERE name = 'sign_provider_latency_ms' AND bucket >= ?`,
      hourBucket(since),
    ),
  ]);
  const o = Object.fromEntries(outcomes.map((r) => [r.outcome, r.n]));
  const attempted = (o.succeeded ?? 0) + (o.failed ?? 0);
  return ok(c, {
    windowDays: days,
    registeredUsers: { total: users?.total ?? 0, newInWindow: users?.recent ?? 0 },
    activeSubscriptions: subs?.n ?? 0,
    translations: { succeeded: o.succeeded ?? 0, failed: o.failed ?? 0, rejected: o.rejected ?? 0, failureRate: attempted ? Math.round(((o.failed ?? 0) / attempted) * 1000) / 1000 : 0 },
    requestsPerDay: perDay,
    signProviderLatencyMs: latency?.count ? { avg: Math.round(latency.sum_value / latency.count), max: latency.max_value, samples: latency.count } : null,
    // Infrastructure cost is not computed here: it requires Cloudflare billing data, which this API does not have.
    infraCost: null,
  });
});

// --- Users -----------------------------------------------------------------
adminRoutes.get('/users', async (c) => {
  const svc = c.get('services');
  const q = query(c, PageQuery.extend({ q: z.string().trim().max(100).optional(), status: z.enum(['active', 'suspended', 'deactivated', 'deleted']).optional() }));
  const rows = await all<UserRow>(
    svc.db,
    `SELECT * FROM users WHERE (?1 IS NULL OR id = ?1 OR email_normalized LIKE ?2 ESCAPE '\\' OR instr(lower(name), lower(?1)) > 0)
        AND (?3 IS NULL OR status = ?3) ORDER BY created_at DESC LIMIT ?4 OFFSET ?5`,
    q.q || null, q.q ? `${q.q.toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m)}%` : null, q.status ?? null, q.limit + 1, q.cursor,
  );
  const p = page(rows, q.limit, q.cursor);
  return ok(c, { users: p.items.map(toAdminView), nextCursor: p.nextCursor });
});

adminRoutes.get('/users/:id', async (c) => {
  const svc = c.get('services');
  const u = await first<UserRow>(svc.db, 'SELECT * FROM users WHERE id = ?', c.req.param('id'));
  if (!u) throw new AppError('not_found');
  const sub = await getLiveSubscription(svc, 'user', u.id);
  const usage = await all<{ feature: string; count: number }>(svc.db, `SELECT feature, count FROM usage_counters WHERE subject_type = 'user' AND subject_id = ? AND period = ?`, u.id, utcPeriod(svc.now()));
  const orgs = await all<{ organization_id: string; role: string }>(svc.db, 'SELECT organization_id, role FROM organization_members WHERE user_id = ?', u.id);
  const activeSessions = (await first<{ n: number }>(svc.db, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?', u.id, svc.now()))?.n ?? 0;
  await auditAdmin(c, 'admin.user_viewed', 'user', u.id);
  return ok(c, { user: toAdminView(u), plan: effectivePlanId(sub, svc.now()), subscription: subscriptionView(sub), usageThisPeriod: usage, organizations: orgs, activeSessions });
});

const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();

async function loadManageableUser(c: Context<AppEnv>, id: string): Promise<UserRow> {
  const svc = c.get('services');
  const target = await first<UserRow>(svc.db, 'SELECT * FROM users WHERE id = ?', id);
  if (!target || target.status === 'deleted') throw new AppError('not_found');
  if (target.id === me(c).user.id) throw new AppError('forbidden', { details: { reason: 'cannot_target_self' } });
  // Staff can only act on accounts with a strictly lower platform role (superadmins may act on anyone else).
  const actorRole = me(c).user.platform_role;
  if (actorRole !== 'superadmin' && hasPlatformRole(target.platform_role, actorRole)) throw new AppError('forbidden');
  return target;
}

adminRoutes.post('/users/:id/suspend', async (c) => {
  needRole(c, 'admin');
  const svc = c.get('services');
  const { reason } = await body(c, ReasonSchema);
  const target = await loadManageableUser(c, c.req.param('id'));
  await run(svc.db, `UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ?`, svc.now(), target.id);
  const revoked = await revokeAllSessions(svc, target.id, 'account_suspended');
  await auditAdmin(c, 'admin.user_suspended', 'user', target.id, { reason, sessionsRevoked: revoked });
  return ok(c, { user: toAdminView((await first<UserRow>(svc.db, 'SELECT * FROM users WHERE id = ?', target.id))!) });
});

adminRoutes.post('/users/:id/reactivate', async (c) => {
  needRole(c, 'admin');
  const svc = c.get('services');
  const { reason } = await body(c, ReasonSchema);
  const target = await loadManageableUser(c, c.req.param('id'));
  if (target.status !== 'suspended') throw new AppError('conflict', { details: { reason: 'not_suspended' } });
  await run(svc.db, `UPDATE users SET status = 'active', updated_at = ? WHERE id = ?`, svc.now(), target.id);
  await auditAdmin(c, 'admin.user_reactivated', 'user', target.id, { reason });
  return ok(c, { user: toAdminView((await first<UserRow>(svc.db, 'SELECT * FROM users WHERE id = ?', target.id))!) });
});

/** HIGH RISK: privilege change. Superadmin + step-up; the target's sessions are revoked. */
adminRoutes.put('/users/:id/platform-role', async (c) => {
  needRole(c, 'superadmin');
  stepUp(c);
  const svc = c.get('services');
  const input = await body(c, z.object({ role: z.enum(['user', 'support', 'admin', 'superadmin']), reason: z.string().trim().min(3).max(200) }).strict());
  const target = await loadManageableUser(c, c.req.param('id'));
  await run(svc.db, 'UPDATE users SET platform_role = ?, updated_at = ? WHERE id = ?', input.role, svc.now(), target.id);
  await revokeAllSessions(svc, target.id, 'privilege_changed');
  await auditAdmin(c, 'admin.platform_role_changed', 'user', target.id, { from: target.platform_role, to: input.role, reason: input.reason });
  return ok(c, { user: toAdminView((await first<UserRow>(svc.db, 'SELECT * FROM users WHERE id = ?', target.id))!) });
});

// --- Organizations ---------------------------------------------------------
adminRoutes.get('/organizations', async (c) => {
  const svc = c.get('services');
  const q = query(c, PageQuery.extend({ q: z.string().trim().max(100).optional(), status: z.enum(['active', 'suspended', 'deleted']).optional() }));
  const rows = await all<OrganizationRow & { members: number }>(
    svc.db,
    `SELECT o.*, (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) AS members FROM organizations o
      WHERE (?1 IS NULL OR o.id = ?1 OR instr(lower(o.name), lower(?1)) > 0 OR o.slug = ?1) AND (?2 IS NULL OR o.status = ?2)
      ORDER BY o.created_at DESC LIMIT ?3 OFFSET ?4`,
    q.q || null, q.status ?? null, q.limit + 1, q.cursor,
  );
  const p = page(rows, q.limit, q.cursor);
  return ok(c, { organizations: p.items.map((o) => ({ ...orgView(o), members: o.members, suspendedReason: o.suspended_reason })), nextCursor: p.nextCursor });
});

adminRoutes.get('/organizations/:id', async (c) => {
  const svc = c.get('services');
  const o = await first<OrganizationRow>(svc.db, 'SELECT * FROM organizations WHERE id = ?', c.req.param('id'));
  if (!o) throw new AppError('not_found');
  const sub = await getLiveSubscription(svc, 'organization', o.id);
  const members = await all<{ user_id: string; role: string }>(svc.db, 'SELECT user_id, role FROM organization_members WHERE organization_id = ? LIMIT 500', o.id);
  const usage = await all<{ feature: string; count: number }>(svc.db, `SELECT feature, count FROM usage_counters WHERE subject_type = 'organization' AND subject_id = ? AND period = ?`, o.id, utcPeriod(svc.now()));
  return ok(c, { organization: { ...orgView(o), suspendedReason: o.suspended_reason }, subscription: subscriptionView(sub), members, usageThisPeriod: usage });
});

adminRoutes.post('/organizations/:id/suspend', async (c) => {
  needRole(c, 'admin');
  const svc = c.get('services');
  const { reason } = await body(c, ReasonSchema);
  const changed = await run(svc.db, `UPDATE organizations SET status = 'suspended', suspended_at = ?, suspended_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'`, svc.now(), reason, svc.now(), c.req.param('id'));
  if (!changed) throw new AppError('not_found');
  await auditAdmin(c, 'admin.org_suspended', 'organization', c.req.param('id'), { reason }, c.req.param('id'));
  return ok(c, { status: 'suspended' });
});

adminRoutes.post('/organizations/:id/reactivate', async (c) => {
  needRole(c, 'admin');
  const svc = c.get('services');
  const { reason } = await body(c, ReasonSchema);
  const changed = await run(svc.db, `UPDATE organizations SET status = 'active', suspended_at = NULL, suspended_reason = NULL, updated_at = ? WHERE id = ? AND status = 'suspended'`, svc.now(), c.req.param('id'));
  if (!changed) throw new AppError('not_found');
  await auditAdmin(c, 'admin.org_reactivated', 'organization', c.req.param('id'), { reason }, c.req.param('id'));
  return ok(c, { status: 'active' });
});

// --- Subscriptions ---------------------------------------------------------
adminRoutes.get('/subscriptions', async (c) => {
  const svc = c.get('services');
  const q = query(c, PageQuery.extend({ status: z.enum(['trialing', 'active', 'past_due', 'cancelled', 'expired', 'suspended']).optional(), planId: z.string().max(40).optional() }));
  const rows = await all<SubscriptionRow>(
    svc.db,
    `SELECT * FROM subscriptions WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR plan_id = ?2) ORDER BY updated_at DESC LIMIT ?3 OFFSET ?4`,
    q.status ?? null, q.planId ?? null, q.limit + 1, q.cursor,
  );
  const p = page(rows, q.limit, q.cursor);
  return ok(c, { subscriptions: p.items.map(subscriptionView), nextCursor: p.nextCursor });
});

/** HIGH RISK: manual grant (e.g. a Business contract handled by sales). */
adminRoutes.post('/subscriptions', async (c) => {
  needRole(c, 'superadmin');
  stepUp(c);
  const svc = c.get('services');
  const input = await body(
    c,
    z.object({
      subjectType: z.enum(['user', 'organization']),
      subjectId: z.string().regex(/^(usr|org)_[0-9a-z]{10,40}$/),
      planId: z.string().max(40),
      periodEnd: z.iso.datetime(),
      reason: z.string().trim().min(3).max(200),
    }).strict(),
  );
  const plan = await first<PlanRow>(svc.db, 'SELECT * FROM plans WHERE id = ?', input.planId);
  if (!plan) throw new AppError('not_found');
  const subjectTable = input.subjectType === 'user' ? 'users' : 'organizations';
  if (!(await first(svc.db, `SELECT id FROM ${subjectTable} WHERE id = ? AND status <> 'deleted'`, input.subjectId))) throw new AppError('not_found');
  if (await getLiveSubscription(svc, input.subjectType, input.subjectId)) throw new AppError('conflict', { details: { reason: 'live_subscription_exists' } });
  const id = await createSubscription(svc, {
    subjectType: input.subjectType, subjectId: input.subjectId, planId: plan.id, status: 'active', provider: 'manual',
    providerSubscriptionRef: null, providerCustomerRef: null, periodStart: svc.now(), periodEnd: Date.parse(input.periodEnd), trialEndsAt: null,
    reason: `admin_grant:${input.reason}`, actorType: 'admin', actorId: me(c).user.id,
  });
  await auditAdmin(c, 'admin.subscription_granted', 'subscription', id, { planId: plan.id, subjectType: input.subjectType, reason: input.reason });
  return ok(c, { subscription: subscriptionView(await first<SubscriptionRow>(svc.db, 'SELECT * FROM subscriptions WHERE id = ?', id)) }, {}, 201);
});

adminRoutes.post('/subscriptions/:id/status', async (c) => {
  needRole(c, 'admin');
  stepUp(c);
  const svc = c.get('services');
  const input = await body(c, z.object({ status: z.enum(['active', 'suspended', 'cancelled', 'expired']), reason: z.string().trim().min(3).max(200) }).strict());
  const sub = await first<SubscriptionRow>(svc.db, 'SELECT * FROM subscriptions WHERE id = ?', c.req.param('id'));
  if (!sub) throw new AppError('not_found');
  const okT = await transitionSubscription(svc, sub, input.status, { reason: `admin:${input.reason}`, actorType: 'admin', actorId: me(c).user.id });
  if (!okT) throw new AppError('conflict', { details: { reason: 'invalid_transition', from: sub.status, to: input.status } });
  await auditAdmin(c, 'admin.subscription_status_changed', 'subscription', sub.id, { from: sub.status, to: input.status, reason: input.reason });
  return ok(c, { subscription: subscriptionView(await first<SubscriptionRow>(svc.db, 'SELECT * FROM subscriptions WHERE id = ?', sub.id)) });
});

// --- Plans & entitlements --------------------------------------------------
adminRoutes.get('/plans', async (c) => {
  needRole(c, 'admin');
  const svc = c.get('services');
  const plans = await all<PlanRow & { waitlist: number }>(svc.db, 'SELECT p.*, (SELECT COUNT(*) FROM plan_waitlist w WHERE w.plan_id = p.id) AS waitlist FROM plans p ORDER BY sort_order');
  const out = [];
  for (const p of plans) out.push({ ...planView(p, { ...(await getPlanEntitlements(svc, p.id)) }), isActive: p.is_active === 1, isPublic: p.is_public === 1, waitlistCount: p.waitlist });
  return ok(c, { plans: out });
});

/** HIGH RISK: commercial configuration. */
adminRoutes.patch('/plans/:id', async (c) => {
  needRole(c, 'superadmin');
  stepUp(c);
  const svc = c.get('services');
  const input = await body(
    c,
    z.object({
      nameEn: z.string().trim().min(1).max(60),
      nameHe: z.string().trim().min(1).max(60),
      isActive: z.boolean(),
      isPublic: z.boolean(),
      availability: z.enum(['available', 'waitlist', 'contact_sales']),
      pricing: z.object({ currency: z.string().length(3), monthlyAmountMinor: z.number().int().min(0), yearlyAmountMinor: z.number().int().min(0).optional(), providerPriceRefs: z.record(z.string().max(20), z.string().max(100)).optional() }).strict().nullable(),
      trialDays: z.number().int().min(0).max(90),
      gracePeriodDays: z.number().int().min(0).max(60),
    }).partial().strict(),
  );
  const p = await first<PlanRow>(svc.db, 'SELECT * FROM plans WHERE id = ?', c.req.param('id'));
  if (!p) throw new AppError('not_found');
  await run(
    svc.db,
    `UPDATE plans SET name_en = ?, name_he = ?, is_active = ?, is_public = ?, availability = ?, pricing_json = ?, trial_days = ?, grace_period_days = ?, updated_at = ? WHERE id = ?`,
    input.nameEn ?? p.name_en, input.nameHe ?? p.name_he,
    input.isActive !== undefined ? (input.isActive ? 1 : 0) : p.is_active,
    input.isPublic !== undefined ? (input.isPublic ? 1 : 0) : p.is_public,
    input.availability ?? p.availability,
    input.pricing !== undefined ? (input.pricing ? JSON.stringify(input.pricing) : null) : p.pricing_json,
    input.trialDays ?? p.trial_days, input.gracePeriodDays ?? p.grace_period_days, svc.now(), p.id,
  );
  await auditAdmin(c, 'admin.plan_updated', 'plan', p.id, { fields: Object.keys(input).join(',') });
  return ok(c, { status: 'updated' });
});

const EntitlementValue: Record<string, z.ZodType> = {
  'translations.monthly_limit': z.number().int().min(0).max(10_000_000).nullable(),
  'emoji.monthly_limit': z.number().int().min(0).max(10_000_000).nullable(),
  'emoji.max_input_chars': z.number().int().min(1).max(10_000),
  'emoji.styles': z.array(z.enum(['minimal', 'standard', 'expressive'])).min(1),
  'sign.enabled': z.boolean(),
  'sign.monthly_limit': z.number().int().min(0).max(10_000_000).nullable(),
  'sign.max_input_chars': z.number().int().min(1).max(5000),
  'sign.max_concurrent_jobs': z.number().int().min(1).max(100),
  'history.available': z.boolean(),
  'org.max_members': z.number().int().min(0).max(100_000),
  'rate.requests_per_minute': z.number().int().min(1).max(10_000),
};

adminRoutes.put('/plans/:id/entitlements', async (c) => {
  needRole(c, 'superadmin');
  stepUp(c);
  const svc = c.get('services');
  const p = await first<PlanRow>(svc.db, 'SELECT id FROM plans WHERE id = ?', c.req.param('id'));
  if (!p) throw new AppError('not_found');
  const raw = await body(c, z.partialRecord(z.enum(ENTITLEMENT_KEYS as [string, ...string[]]), z.unknown()));
  const now = svc.now();
  for (const [key, value] of Object.entries(raw)) {
    const parsed = EntitlementValue[key]!.safeParse(value);
    if (!parsed.success) throw new AppError('validation_error', { details: { issues: [{ path: key, code: 'invalid_value' }] } });
    await run(
      svc.db,
      `INSERT INTO plan_entitlements (plan_id, key, value_json, updated_at) VALUES (?,?,?,?)
       ON CONFLICT (plan_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      p.id, key, JSON.stringify(parsed.data), now,
    );
  }
  await auditAdmin(c, 'admin.entitlements_updated', 'plan', p.id, { keys: Object.keys(raw).join(',') });
  return ok(c, { planId: p.id, entitlements: await getPlanEntitlements(svc, p.id) });
});

// --- Aggregate usage -------------------------------------------------------
adminRoutes.get('/usage', async (c) => {
  const svc = c.get('services');
  const { period } = query(c, z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }));
  const p = period ?? utcPeriod(svc.now());
  const byFeature = await all<{ feature: string; outcome: string; n: number; retries: number }>(
    svc.db,
    'SELECT feature, outcome, COUNT(*) AS n, SUM(retry_count) AS retries FROM usage_events WHERE period = ? GROUP BY feature, outcome',
    p,
  );
  const topSubjects = await all<{ subject_type: string; subject_id: string; feature: string; count: number }>(
    svc.db,
    `SELECT subject_type, subject_id, feature, count FROM usage_counters WHERE period = ? AND feature = 'translations' ORDER BY count DESC LIMIT 20`,
    p,
  );
  return ok(c, { period: p, byFeature, topSubjects });
});

// --- Feature flags ---------------------------------------------------------
adminRoutes.get('/feature-flags', async (c) => {
  const rows = await all<{ key: string; enabled: number; description: string | null; updated_by: string | null; updated_at: number }>(c.get('services').db, 'SELECT * FROM feature_flags ORDER BY key');
  return ok(c, { flags: rows.map((r) => ({ key: r.key, enabled: r.enabled === 1, description: r.description, updatedBy: r.updated_by, updatedAt: iso(r.updated_at) })) });
});

adminRoutes.put('/feature-flags/:key', async (c) => {
  needRole(c, 'admin');
  const svc = c.get('services');
  const { enabled } = await body(c, z.object({ enabled: z.boolean() }).strict());
  const changed = await run(svc.db, 'UPDATE feature_flags SET enabled = ?, updated_by = ?, updated_at = ? WHERE key = ?', enabled ? 1 : 0, me(c).user.id, svc.now(), c.req.param('key'));
  if (!changed) throw new AppError('not_found');
  await auditAdmin(c, 'admin.feature_flag_changed', 'feature_flag', c.req.param('key'), { enabled });
  return ok(c, { key: c.req.param('key'), enabled });
});

// --- Audit log -------------------------------------------------------------
adminRoutes.get('/audit-events', async (c) => {
  needRole(c, 'admin');
  const svc = c.get('services');
  const q = query(
    c,
    PageQuery.extend({
      action: z.string().regex(/^[a-z_.]{2,60}$/).optional(),
      actorUserId: z.string().max(40).optional(),
      outcome: z.enum(['success', 'denied', 'failure']).optional(),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
    }),
  );
  const rows = await all<{ id: string; created_at: number; request_id: string | null; actor_user_id: string | null; actor_role: string | null; action: string; target_type: string | null; target_id: string | null; organization_id: string | null; outcome: string; metadata_json: string }>(
    svc.db,
    `SELECT * FROM audit_events WHERE (?1 IS NULL OR action LIKE ?1 || '%') AND (?2 IS NULL OR actor_user_id = ?2) AND (?3 IS NULL OR outcome = ?3)
        AND (?4 IS NULL OR created_at >= ?4) AND (?5 IS NULL OR created_at <= ?5)
      ORDER BY created_at DESC LIMIT ?6 OFFSET ?7`,
    q.action ?? null, q.actorUserId ?? null, q.outcome ?? null, q.from ? Date.parse(q.from) : null, q.to ? Date.parse(q.to) : null, q.limit + 1, q.cursor,
  );
  const p = page(rows, q.limit, q.cursor);
  return ok(c, {
    events: p.items.map((r) => ({ id: r.id, at: iso(r.created_at), requestId: r.request_id, actorUserId: r.actor_user_id, actorRole: r.actor_role, action: r.action, targetType: r.target_type, targetId: r.target_id, organizationId: r.organization_id, outcome: r.outcome, metadata: parseJson(r.metadata_json, {}) })),
    nextCursor: p.nextCursor,
  });
});

// --- Jobs & engine health --------------------------------------------------
adminRoutes.get('/jobs/stats', async (c) => {
  const svc = c.get('services');
  const days = query(c, z.object({ days: z.coerce.number().int().min(1).max(30).default(7) })).days;
  const since = svc.now() - days * DAY;
  const [byStatus, byFailure, byVerification, queueMetrics] = await Promise.all([
    all<{ status: string; n: number }>(svc.db, 'SELECT status, COUNT(*) AS n FROM translation_jobs WHERE created_at >= ? GROUP BY status', since),
    all<{ failure_code: string; n: number }>(svc.db, `SELECT failure_code, COUNT(*) AS n FROM translation_jobs WHERE created_at >= ? AND failure_code IS NOT NULL GROUP BY failure_code ORDER BY n DESC`, since),
    all<{ verification_status: string; n: number }>(svc.db, 'SELECT verification_status, COUNT(*) AS n FROM translation_jobs WHERE created_at >= ? AND verification_status IS NOT NULL GROUP BY verification_status', since),
    all<{ name: string; label: string; n: number }>(
      svc.db,
      `SELECT name, label, SUM(count) AS n FROM ops_metrics WHERE bucket >= ? AND name IN ('queue_send_failure','queue_retry','queue_dead_letter','queue_consumer_error','sign_job_failed','sign_job_expired') GROUP BY name, label`,
      hourBucket(since),
    ),
  ]);
  return ok(c, { windowDays: days, byStatus, byFailureCode: byFailure, byVerificationStatus: byVerification, queue: queueMetrics });
});

adminRoutes.get('/engine/health', async (c) => {
  const svc = c.get('services');
  const since = hourBucket(svc.now() - DAY);
  const metrics = await all<{ name: string; label: string; count: number; sum_value: number; max_value: number }>(
    svc.db,
    `SELECT name, label, SUM(count) AS count, SUM(sum_value) AS sum_value, MAX(max_value) AS max_value FROM ops_metrics
      WHERE bucket >= ? AND name IN ('sign_provider_latency_ms','sign_provider_error','sign_job_completed') GROUP BY name, label`,
    since,
  );
  const health = await svc.signProvider.health().catch(() => ({ status: 'degraded' as const }));
  return ok(c, {
    sign: {
      provider: svc.signProvider.name,
      configuredAs: svc.config.SIGN_PROVIDER,
      linguisticallyValidated: svc.config.SIGN_PROVIDER === 'http' && svc.config.SIGN_PROVIDER_VALIDATED,
      health: health.status,
      last24h: metrics.map((m) => ({ name: m.name, label: m.label, count: m.count, avg: m.count ? Math.round(m.sum_value / m.count) : null, max: m.max_value })),
    },
    emoji: { provider: svc.emojiEngine.name, version: svc.emojiEngine.version, health: 'ok' },
    payment: { provider: svc.payment.name, configured: svc.payment.configured },
    email: { provider: svc.email.name, deliveryEnabled: svc.email.enabled },
  });
});
