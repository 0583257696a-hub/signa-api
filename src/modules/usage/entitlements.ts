import type { Services } from '../../context';
import { all, first, parseJson } from '../../lib/db';
import { requireMembership } from '../orgs/access';

export type SubjectType = 'user' | 'organization';
export type MeteredFeature = 'emoji' | 'sign';

export interface Entitlements {
  'translations.monthly_limit': number | null;
  'emoji.monthly_limit': number | null;
  'emoji.max_input_chars': number;
  'emoji.styles': string[];
  'sign.enabled': boolean;
  'sign.monthly_limit': number | null;
  'sign.max_input_chars': number;
  'sign.max_concurrent_jobs': number;
  'history.available': boolean;
  'org.max_members': number;
  'rate.requests_per_minute': number;
}

/** Safe defaults if a plan is missing a key: the most restrictive reasonable value. */
const DEFAULTS: Entitlements = {
  'translations.monthly_limit': 0,
  'emoji.monthly_limit': 0,
  'emoji.max_input_chars': 200,
  'emoji.styles': ['standard'],
  'sign.enabled': false,
  'sign.monthly_limit': 0,
  'sign.max_input_chars': 200,
  'sign.max_concurrent_jobs': 1,
  'history.available': false,
  'org.max_members': 0,
  'rate.requests_per_minute': 10,
};

export const ENTITLEMENT_KEYS = Object.keys(DEFAULTS) as (keyof Entitlements)[];

export async function getPlanEntitlements(svc: Services, planId: string): Promise<Entitlements> {
  const rows = await all<{ key: string; value_json: string }>(svc.db, 'SELECT key, value_json FROM plan_entitlements WHERE plan_id = ?', planId);
  const ent: Record<string, unknown> = { ...DEFAULTS };
  for (const r of rows) if (r.key in DEFAULTS) ent[r.key] = parseJson(r.value_json, (DEFAULTS as unknown as Record<string, unknown>)[r.key]);
  return ent as unknown as Entitlements;
}

export interface SubscriptionRow {
  id: string;
  subject_type: SubjectType;
  subject_id: string;
  plan_id: string;
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired' | 'suspended';
  provider: string;
  provider_customer_ref: string | null;
  provider_subscription_ref: string | null;
  trial_ends_at: number | null;
  current_period_start: number | null;
  current_period_end: number | null;
  cancel_at_period_end: number;
  cancelled_at: number | null;
  grace_until: number | null;
  created_at: number;
  updated_at: number;
}

export async function getLiveSubscription(svc: Services, subjectType: SubjectType, subjectId: string): Promise<SubscriptionRow | null> {
  return first<SubscriptionRow>(
    svc.db,
    `SELECT * FROM subscriptions WHERE subject_type = ? AND subject_id = ?
       AND status IN ('trialing','active','past_due','suspended') LIMIT 1`,
    subjectType,
    subjectId,
  );
}

/**
 * The plan that currently grants entitlements. Paid entitlements apply only while
 * the subscription is trialing/active (within its period), or past_due within the
 * grace window. Everything else falls back to `free`.
 */
export function effectivePlanId(sub: SubscriptionRow | null, now: number): string {
  if (!sub) return 'free';
  if (sub.status === 'trialing') return sub.trial_ends_at === null || sub.trial_ends_at > now ? sub.plan_id : 'free';
  if (sub.status === 'active') return sub.current_period_end === null || sub.current_period_end > now ? sub.plan_id : 'free';
  if (sub.status === 'past_due') return sub.grace_until !== null && sub.grace_until > now ? sub.plan_id : 'free';
  return 'free';
}

export interface BillingContext {
  subjectType: SubjectType;
  subjectId: string;
  organizationId: string | null;
  planId: string;
  subscription: SubscriptionRow | null;
  entitlements: Entitlements;
}

/**
 * Resolves who pays for a request. With an organization context the caller must be
 * a member of an active organization; usage is then pooled at the organization level.
 */
export async function resolveBillingContext(svc: Services, userId: string, organizationId: string | null): Promise<BillingContext> {
  if (organizationId) await requireMembership(svc, userId, organizationId, 'member');
  const subjectType: SubjectType = organizationId ? 'organization' : 'user';
  const subjectId = organizationId ?? userId;
  const subscription = await getLiveSubscription(svc, subjectType, subjectId);
  const planId = effectivePlanId(subscription, svc.now());
  return { subjectType, subjectId, organizationId, planId, subscription, entitlements: await getPlanEntitlements(svc, planId) };
}

/** Organization context comes from the X-Organization-Id header (validated against membership). */
export function orgContextFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  return /^org_[0-9a-z]{10,40}$/.test(header) ? header : '__invalid__';
}
