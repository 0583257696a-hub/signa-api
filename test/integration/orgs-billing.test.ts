import { describe, expect, it } from 'vitest';
import { signDevWebhook } from '../../src/modules/billing/provider';
import { reconcileSubscriptions } from '../../src/modules/billing/service';
import { Client, createHarness, signUp, WEBHOOK_SECRET, type Harness } from '../helpers/harness';

async function webhook(h: Harness, event: Record<string, unknown>, opts: { badSig?: boolean } = {}) {
  const raw = JSON.stringify(event);
  const t = h.clock.now;
  const sig = opts.badSig ? 'deadbeef' : await signDevWebhook(WEBHOOK_SECRET, t, raw);
  const res = await h.app.request('/api/v1/billing/webhooks/dev', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signa-dev-signature': `t=${t},v1=${sig}` }, body: raw }, h.env);
  return { status: res.status, body: (await res.json()) as any };
}

function grantBusiness(h: Harness, orgId: string) {
  h.d1.q(
    `INSERT INTO subscriptions (id, subject_type, subject_id, plan_id, status, provider, current_period_start, current_period_end, created_at, updated_at)
     VALUES ('sub_testbusiness0001', 'organization', ?, 'business', 'active', 'manual', ?, ?, ?, ?)`,
    orgId, h.clock.now, h.clock.now + 30 * 86400000, h.clock.now, h.clock.now,
  );
}

describe('organizations & tenant isolation', () => {
  it('requires a verified email to create an organization', async () => {
    const h = createHarness();
    const { client } = await signUp(h, { verify: false });
    expect((await client.post('/api/v1/organizations', { name: 'Clinic' })).body.error.code).toBe('email_not_verified');
  });

  it('hides organizations from non-members (404, not 403)', async () => {
    const h = createHarness();
    const owner = await signUp(h);
    const outsider = await signUp(h);
    const org = (await owner.client.post('/api/v1/organizations', { name: 'Tel Aviv Clinic' })).body.data.organization;
    expect(org.role).toBe('owner');
    for (const path of [`/api/v1/organizations/${org.id}`, `/api/v1/organizations/${org.id}/members`, `/api/v1/organizations/${org.id}/usage`]) {
      expect((await outsider.client.get(path)).status).toBe(404);
    }
    expect((await outsider.client.patch(`/api/v1/organizations/${org.id}`, { name: 'Hacked' })).status).toBe(404);
    outsider.client.orgId = org.id; // using someone else's org as billing context
    expect((await outsider.client.post('/api/v1/emoji/translate', { text: 'שלום' })).status).toBe(404);
  });

  it('runs the invitation flow with seat limits, email binding and expiry', async () => {
    const h = createHarness();
    const owner = await signUp(h);
    const org = (await owner.client.post('/api/v1/organizations', { name: 'School' })).body.data.organization;
    const inviteeEmail = 'invitee@example.com';
    // Free organizations have no seats.
    expect((await owner.client.post(`/api/v1/organizations/${org.id}/invitations`, { email: inviteeEmail })).body.error.code).toBe('entitlement_required');
    grantBusiness(h, org.id);
    const inv = await owner.client.post(`/api/v1/organizations/${org.id}/invitations`, { email: inviteeEmail, role: 'member' });
    expect(inv.status).toBe(201);
    const token = /token=([A-Za-z0-9_-]+)/.exec(h.email.outbox.find((m) => m.to === inviteeEmail)!.text)![1]!;

    const wrongUser = await signUp(h);
    expect((await wrongUser.client.post('/api/v1/organizations/invitations/accept', { token })).status).toBe(403);
    const invitee = await signUp(h, { email: inviteeEmail });
    const accepted = await invitee.client.post('/api/v1/organizations/invitations/accept', { token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.organization.role).toBe('member');
    expect((await invitee.client.post('/api/v1/organizations/invitations/accept', { token })).status).toBe(400);
    // Members see names but not emails; members cannot read usage.
    const members = (await invitee.client.get(`/api/v1/organizations/${org.id}/members`)).body.data.members;
    expect(members).toHaveLength(2);
    expect(members[0].email).toBeUndefined();
    expect((await invitee.client.get(`/api/v1/organizations/${org.id}/usage`)).status).toBe(403);

    const inv2 = await owner.client.post(`/api/v1/organizations/${org.id}/invitations`, { email: 'late@example.com' });
    expect(inv2.status).toBe(201);
    const token2 = /token=([A-Za-z0-9_-]+)/.exec(h.email.outbox.find((m) => m.to === 'late@example.com')!.text)![1]!;
    h.clock.now += 8 * 86400000;
    const late = await signUp(h, { email: 'late@example.com' });
    expect((await late.client.post('/api/v1/organizations/invitations/accept', { token: token2 })).body.error.code).toBe('invalid_token');
  });

  it('enforces role rules and protects the last owner', async () => {
    const h = createHarness();
    const owner = await signUp(h);
    const org = (await owner.client.post('/api/v1/organizations', { name: 'Org' })).body.data.organization;
    const admin = await signUp(h);
    const member = await signUp(h);
    h.d1.q(`INSERT INTO organization_members VALUES (?, ?, 'admin', 0, 0), (?, ?, 'member', 0, 0)`, org.id, admin.userId, org.id, member.userId);
    expect((await admin.client.patch(`/api/v1/organizations/${org.id}/members/${member.userId}`, { role: 'owner' })).status).toBe(403);
    expect((await admin.client.patch(`/api/v1/organizations/${org.id}/members/${owner.userId}`, { role: 'member' })).status).toBe(403);
    expect((await member.client.patch(`/api/v1/organizations/${org.id}`, { name: 'Renamed' })).status).toBe(403);
    expect((await admin.client.patch(`/api/v1/organizations/${org.id}/members/${member.userId}`, { role: 'admin' })).status).toBe(200);
    expect((await admin.client.patch(`/api/v1/organizations/${org.id}`, { settings: { defaultTranslationMode: 'emoji' } })).status).toBe(403);
    expect((await owner.client.patch(`/api/v1/organizations/${org.id}/members/${owner.userId}`, { role: 'member' })).body.error.details.reason).toBe('last_owner');
    expect((await owner.client.delete(`/api/v1/organizations/${org.id}/members/${owner.userId}`)).body.error.details.reason).toBe('last_owner');
    expect((await member.client.delete(`/api/v1/organizations/${org.id}/members/${member.userId}`)).status).toBe(200);
  });

  it('pools usage at the organization level and blocks suspended organizations', async () => {
    const h = createHarness();
    const owner = await signUp(h);
    const org = (await owner.client.post('/api/v1/organizations', { name: 'Org' })).body.data.organization;
    grantBusiness(h, org.id);
    owner.client.orgId = org.id;
    expect((await owner.client.post('/api/v1/emoji/translate', { text: 'שלום', style: 'expressive' })).status).toBe(200);
    const usage = await owner.client.get(`/api/v1/organizations/${org.id}/usage`);
    expect(usage.body.data.usage).toMatchObject({ planId: 'business', subject: { type: 'organization', id: org.id } });
    expect(usage.body.data.usage.counters.emoji.used).toBe(1);
    owner.client.orgId = null;
    expect((await owner.client.get('/api/v1/usage')).body.data.counters.emoji.used).toBe(0);
    h.d1.q(`UPDATE organizations SET status = 'suspended' WHERE id = ?`, org.id);
    owner.client.orgId = org.id;
    expect((await owner.client.post('/api/v1/emoji/translate', { text: 'שלום' })).body.error.code).toBe('organization_suspended');
  });
});

describe('billing', () => {
  it('refuses checkout while pricing is not configured', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    const r = await client.post('/api/v1/billing/checkout', { planId: 'pro' });
    expect(r.status).toBe(409);
    expect(r.body.error.details.reason).toBe('plan_not_purchasable');
  });

  it('joins the waitlist for waitlist plans', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    expect((await client.post('/api/v1/plans/pro/waitlist')).body.data.status).toBe('on_waitlist');
    expect((await client.post('/api/v1/plans/business/waitlist')).status).toBe(409);
  });

  it('activates subscriptions only through signed, idempotent webhooks', async () => {
    const h = createHarness();
    const { client, userId } = await signUp(h);
    h.d1.q(`UPDATE plans SET availability = 'available', pricing_json = '{"currency":"ILS","monthlyAmountMinor":1}' WHERE id = 'pro'`);
    const checkout = await client.post('/api/v1/billing/checkout', { planId: 'pro' });
    expect(checkout.status).toBe(201);
    const ref = new URL(checkout.body.data.url).searchParams.get('session')!;
    // Nothing is active until the provider confirms.
    expect((await client.get('/api/v1/usage')).body.data.planId).toBe('free');

    expect((await webhook(h, { id: 'evt_1', type: 'checkout.completed', checkoutRef: ref, subscriptionRef: 'sub_dev_1' }, { badSig: true })).status).toBe(400);
    const now = h.clock.now;
    const ok = await webhook(h, { id: 'evt_1', type: 'checkout.completed', checkoutRef: ref, subscriptionRef: 'sub_dev_1', status: 'active', periodStart: now, periodEnd: now + 30 * 86400000 });
    expect(ok.body.data.outcome).toBe('processed');
    expect((await webhook(h, { id: 'evt_1', type: 'checkout.completed', checkoutRef: ref, subscriptionRef: 'sub_dev_1' })).body.data.outcome).toBe('duplicate');
    expect(h.d1.q('SELECT COUNT(*) AS n FROM subscriptions')[0]!.n).toBe(1);
    expect((await client.get('/api/v1/usage')).body.data.planId).toBe('pro');

    // Payment failure → past_due with grace (entitlements kept), then expiry after grace.
    expect((await webhook(h, { id: 'evt_2', type: 'payment.failed', subscriptionRef: 'sub_dev_1' })).body.data.outcome).toBe('processed');
    const sub = (await client.get('/api/v1/billing/subscription')).body.data.subscription;
    expect(sub.status).toBe('past_due');
    expect(Date.parse(sub.graceUntil)).toBe(now + 7 * 86400000);
    expect((await client.get('/api/v1/usage')).body.data.planId).toBe('pro');
    h.clock.now = now + 8 * 86400000;
    await reconcileSubscriptions(h.services());
    expect(h.d1.q('SELECT status FROM subscriptions')[0]!.status).toBe('expired');
    const history = h.d1.q<{ to_status: string }>('SELECT to_status FROM subscription_history ORDER BY created_at, rowid').map((r) => r.to_status);
    expect(history).toEqual(['active', 'past_due', 'expired']);
    expect(h.d1.q(`SELECT COUNT(*) AS n FROM users WHERE id = ?`, userId)[0]!.n).toBe(1);
  });

  it('cancels at period end and reconciles to cancelled', async () => {
    const h = createHarness();
    const { client, userId } = await signUp(h);
    const now = h.clock.now;
    h.d1.q(
      `INSERT INTO subscriptions (id, subject_type, subject_id, plan_id, status, provider, provider_subscription_ref, current_period_start, current_period_end, created_at, updated_at)
       VALUES ('sub_cancelme0000001', 'user', ?, 'pro', 'active', 'dev', 'sub_dev_9', ?, ?, ?, ?)`,
      userId, now, now + 86400000, now, now,
    );
    const r = await client.post('/api/v1/billing/subscription/cancel', {});
    expect(r.body.data.subscription.cancelAtPeriodEnd).toBe(true);
    h.clock.now = now + 2 * 86400000;
    await reconcileSubscriptions(h.services());
    expect(h.d1.q('SELECT status FROM subscriptions')[0]!.status).toBe('cancelled');
  });

  it('allows only organization owners to manage organization billing', async () => {
    const h = createHarness();
    const owner = await signUp(h);
    const org = (await owner.client.post('/api/v1/organizations', { name: 'Org' })).body.data.organization;
    const admin = await signUp(h);
    h.d1.q(`INSERT INTO organization_members VALUES (?, ?, 'admin', 0, 0)`, org.id, admin.userId);
    expect((await admin.client.post('/api/v1/billing/checkout', { planId: 'business', organizationId: org.id })).status).toBe(403);
  });
});
