import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context';
import { newId } from '../../lib/crypto';
import { all, first, run } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { body, ok } from '../../lib/http';
import { requireAuth } from '../../middleware';
import { audit } from '../audit/service';
import { requireMembership } from '../orgs/access';
import { orgContext } from '../sign/routes';
import { getLiveSubscription, getPlanEntitlements, resolveBillingContext } from '../usage/entitlements';
import { usageSummary } from '../usage/service';
import { planView, processWebhookEvent, subscriptionView, transitionSubscription, type PlanRow } from './service';

// ---------------------------------------------------------------------------
// Plans (public)
// ---------------------------------------------------------------------------
export const planRoutes = new Hono<AppEnv>();

planRoutes.get('/', async (c) => {
  const svc = c.get('services');
  const plans = await all<PlanRow>(svc.db, 'SELECT * FROM plans WHERE is_active = 1 AND is_public = 1 ORDER BY sort_order');
  const items = [];
  for (const p of plans) items.push(planView(p, { ...(await getPlanEntitlements(svc, p.id)) }));
  c.header('Cache-Control', 'public, max-age=300');
  return ok(c, { plans: items });
});

planRoutes.post('/:planId/waitlist', requireAuth, async (c) => {
  const svc = c.get('services');
  const plan = await first<PlanRow>(svc.db, `SELECT * FROM plans WHERE id = ? AND is_active = 1 AND is_public = 1`, c.req.param('planId'));
  if (!plan) throw new AppError('not_found');
  if (plan.availability !== 'waitlist') throw new AppError('conflict', { details: { reason: 'plan_not_on_waitlist', availability: plan.availability } });
  await run(svc.db, 'INSERT INTO plan_waitlist (plan_id, user_id, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING', plan.id, c.get('auth')!.user.id, svc.now());
  return ok(c, { status: 'on_waitlist', planId: plan.id });
});

// ---------------------------------------------------------------------------
// Usage (personal or organization context via X-Organization-Id)
// ---------------------------------------------------------------------------
export const usageRoutes = new Hono<AppEnv>();
usageRoutes.get('/', requireAuth, async (c) => {
  const svc = c.get('services');
  const ctx = await resolveBillingContext(svc, c.get('auth')!.user.id, orgContext(c));
  return ok(c, await usageSummary(svc, ctx));
});

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------
export const billingRoutes = new Hono<AppEnv>();

const SubjectSchema = z.object({ organizationId: z.string().regex(/^org_[0-9a-z]{10,40}$/).optional() });

/** Resolves and authorizes the billing subject: self, or an organization the caller owns. */
async function billingSubject(c: Context<AppEnv>, organizationId: string | undefined) {
  const svc = c.get('services');
  const user = c.get('auth')!.user;
  if (organizationId) {
    await requireMembership(svc, user.id, organizationId, 'owner', { allowSuspended: true });
    return { type: 'organization' as const, id: organizationId };
  }
  return { type: 'user' as const, id: user.id };
}

billingRoutes.get('/subscription', requireAuth, async (c) => {
  const svc = c.get('services');
  const orgId = c.req.query('organizationId');
  const user = c.get('auth')!.user;
  if (orgId) await requireMembership(svc, user.id, orgId, 'admin', { allowSuspended: true });
  const sub = await getLiveSubscription(svc, orgId ? 'organization' : 'user', orgId ?? user.id);
  const ctx = await resolveBillingContext(svc, user.id, orgId ?? null).catch(() => null);
  return ok(c, { subscription: subscriptionView(sub), effectivePlanId: ctx?.planId ?? 'free' });
});

billingRoutes.post('/checkout', requireAuth, async (c) => {
  const svc = c.get('services');
  const user = c.get('auth')!.user;
  const input = await body(c, SubjectSchema.extend({ planId: z.string().max(40) }).strict());
  if (user.email_verified_at === null) throw new AppError('email_not_verified');
  const subject = await billingSubject(c, input.organizationId);
  const plan = await first<PlanRow>(svc.db, 'SELECT * FROM plans WHERE id = ? AND is_active = 1', input.planId);
  if (!plan || plan.id === 'free') throw new AppError('not_found');
  if (plan.availability !== 'available' || !plan.pricing_json) {
    throw new AppError('conflict', { details: { reason: 'plan_not_purchasable', availability: plan.availability } });
  }
  if (!svc.payment.configured) throw new AppError('provider_not_configured');
  const checkoutId = newId('chk');
  const session = await svc.payment.createCheckoutSession({
    checkoutId,
    planId: plan.id,
    subject,
    customerEmail: user.email,
    successUrl: `${svc.config.APP_BASE_URL}/billing/success?checkout=${checkoutId}`,
    cancelUrl: `${svc.config.APP_BASE_URL}/billing/cancelled`,
    trialDays: plan.trial_days,
  });
  await run(
    svc.db,
    `INSERT INTO checkout_sessions (id, provider, provider_session_ref, subject_type, subject_id, plan_id, created_by, status, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?, 'open', ?, ?)`,
    checkoutId, svc.payment.name, session.providerSessionRef, subject.type, subject.id, plan.id, user.id, svc.now(), session.expiresAt,
  );
  await audit(svc, { action: 'billing.checkout_created', actorUserId: user.id, targetType: subject.type, targetId: subject.id, requestId: c.get('requestId'), metadata: { planId: plan.id } });
  // NOTE: the subscription is created only when the provider's signed webhook confirms payment.
  return ok(c, { checkoutId, url: session.url }, {}, 201);
});

billingRoutes.post('/subscription/cancel', requireAuth, async (c) => {
  const svc = c.get('services');
  const user = c.get('auth')!.user;
  const input = await body(c, SubjectSchema.strict());
  const subject = await billingSubject(c, input.organizationId);
  const sub = await getLiveSubscription(svc, subject.type, subject.id);
  if (!sub || (sub.status !== 'active' && sub.status !== 'trialing')) throw new AppError('not_found');
  if (sub.provider_subscription_ref && sub.provider === svc.payment.name) {
    await svc.payment.cancelSubscription(sub.provider_subscription_ref, { atPeriodEnd: true });
  }
  if (sub.status === 'trialing') {
    await transitionSubscription(svc, sub, 'cancelled', { reason: 'cancelled_during_trial', actorType: 'user', actorId: user.id });
  } else {
    await run(svc.db, 'UPDATE subscriptions SET cancel_at_period_end = 1, updated_at = ? WHERE id = ?', svc.now(), sub.id);
  }
  await audit(svc, { action: 'billing.subscription_cancel_requested', actorUserId: user.id, targetType: 'subscription', targetId: sub.id, requestId: c.get('requestId') });
  return ok(c, { subscription: subscriptionView(await getLiveSubscription(svc, subject.type, subject.id) ?? (await first(svc.db, 'SELECT * FROM subscriptions WHERE id = ?', sub.id))) });
});

billingRoutes.get('/subscription/history', requireAuth, async (c) => {
  const svc = c.get('services');
  const user = c.get('auth')!.user;
  const orgId = c.req.query('organizationId');
  if (orgId) await requireMembership(svc, user.id, orgId, 'owner', { allowSuspended: true });
  const rows = await all<{ from_status: string | null; to_status: string; from_plan_id: string | null; to_plan_id: string; reason: string; created_at: number }>(
    svc.db,
    `SELECT h.from_status, h.to_status, h.from_plan_id, h.to_plan_id, h.reason, h.created_at FROM subscription_history h
       JOIN subscriptions s ON s.id = h.subscription_id
      WHERE s.subject_type = ? AND s.subject_id = ? ORDER BY h.created_at DESC LIMIT 100`,
    orgId ? 'organization' : 'user', orgId ?? user.id,
  );
  return ok(c, { history: rows.map((r) => ({ fromStatus: r.from_status, toStatus: r.to_status, fromPlanId: r.from_plan_id, toPlanId: r.to_plan_id, reason: r.reason, at: new Date(r.created_at).toISOString() })) });
});

/** Provider webhooks: authenticated by signature (not by session/CSRF). */
billingRoutes.post('/webhooks/:provider', async (c) => {
  const svc = c.get('services');
  if (c.req.param('provider') !== svc.payment.name || !svc.payment.configured) throw new AppError('not_found');
  const raw = await c.req.text();
  if (raw.length > 256 * 1024) throw new AppError('payload_too_large');
  const event = await svc.payment.parseWebhook(c.req.raw.headers, raw, svc.now());
  const outcome = await processWebhookEvent(svc, svc.payment.name, event);
  svc.logger.log('info', 'payment_webhook', { provider: svc.payment.name, eventType: event.type, outcome, requestId: c.get('requestId') });
  return ok(c, { received: true, outcome });
});
