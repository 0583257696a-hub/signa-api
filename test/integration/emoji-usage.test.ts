import { describe, expect, it } from 'vitest';
import { Client, createHarness, signUp } from '../helpers/harness';

const translate = (c: Client, text: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  c.post('/api/v1/emoji/translate', { text, mode: 'text_and_emoji', style: 'standard', language: 'he', ...extra }, headers);

describe('emoji translation API', () => {
  it('translates and returns both output forms with metadata', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    const r = await translate(client, 'שלום! אני שמח לראות אותך');
    expect(r.status).toBe(200);
    expect(r.body.data.result).toBe('שלום! 👋 אני שמח 😊 לראות אותך 🤗');
    expect(r.body.data.alternatives.emojiOnly).toBe('👋😊🤗');
    expect(r.body.data.direction).toBe('rtl');
    expect(r.body.meta).toMatchObject({ provider: 'rules', usageCounted: true, method: 'deterministic_rules' });
    expect(r.body.meta.requestId).toMatch(/^req_/);
  });

  it('requires authentication', async () => {
    const h = createHarness();
    const r = await translate(new Client(h), 'שלום');
    expect(r.status).toBe(401);
  });

  it('validates input: empty, whitespace, too long, invalid mode', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    expect((await translate(client, '   ')).body.error.code).toBe('empty_input');
    expect((await translate(client, '\u0000‮')).body.error.code).toBe('empty_input');
    const long = await translate(client, 'א'.repeat(501));
    expect(long.status).toBe(413);
    expect(long.body.error.details.maxChars).toBe(500);
    expect((await translate(client, 'hi', { mode: 'emoji_maybe' })).status).toBe(422);
  });

  it('enforces style entitlements server-side', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    const r = await translate(client, 'שלום', { style: 'expressive' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('entitlement_required');
  });

  it('does not count requests that matched nothing', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    const r = await translate(client, 'qwerty zxcvb', { mode: 'emoji_only' });
    expect(r.status).toBe(200);
    expect(r.body.data.result).toBe('');
    expect(r.body.meta.usageCounted).toBe(false);
    const usage = await client.get('/api/v1/usage');
    expect(usage.body.data.counters.translations.used).toBe(0);
    expect(h.d1.q(`SELECT outcome, error_code FROM usage_events`)[0]).toEqual({ outcome: 'failed', error_code: 'no_match' });
  });

  it('counts usage, reports reset date, and rejects at the pooled monthly limit', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    h.d1.q(`UPDATE plan_entitlements SET value_json = '3' WHERE plan_id = 'free' AND key = 'translations.monthly_limit'`);
    for (let i = 0; i < 3; i++) expect((await translate(client, 'שלום')).status).toBe(200);
    const blocked = await translate(client, 'שלום');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('quota_exceeded');
    expect(blocked.body.error.details).toMatchObject({ limit: 3, used: 3, resetsAt: '2026-11-01T00:00:00.000Z', planId: 'free' });
    const usage = await client.get('/api/v1/usage');
    expect(usage.body.data.counters.translations).toEqual({ used: 3, limit: 3 });
    expect(usage.body.data.period.resetsAt).toBe('2026-11-01T00:00:00.000Z');
    expect(h.d1.q(`SELECT COUNT(*) AS n FROM usage_events WHERE outcome = 'rejected'`)[0]!.n).toBe(1);
  });

  it('resets quotas at the UTC month boundary', async () => {
    const h = createHarness();
    h.clock.now = Date.UTC(2026, 9, 31, 23, 59, 0);
    const { client } = await signUp(h);
    h.d1.q(`UPDATE plan_entitlements SET value_json = '1' WHERE plan_id = 'free' AND key = 'translations.monthly_limit'`);
    expect((await translate(client, 'שלום')).status).toBe(200);
    expect((await translate(client, 'שלום')).status).toBe(429);
    h.clock.now = Date.UTC(2026, 10, 1, 0, 0, 1);
    expect((await translate(client, 'שלום')).status).toBe(200);
  });

  it('does not let concurrent requests exceed the quota', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    h.d1.q(`UPDATE plan_entitlements SET value_json = '5' WHERE plan_id = 'free' AND key = 'translations.monthly_limit'`);
    const results = await Promise.all(Array.from({ length: 12 }, () => translate(client, 'שלום')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
    expect(h.d1.q(`SELECT count FROM usage_counters WHERE feature = 'translations'`)[0]!.count).toBe(5);
  });

  it('makes retries idempotent and detects key reuse with a different body', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    const key = { 'idempotency-key': 'retry-key-0001' };
    const a = await translate(client, 'שלום', {}, key);
    const b = await translate(client, 'שלום', {}, key);
    expect(a.body.data.result).toBe(b.body.data.result);
    expect(b.body.meta).toMatchObject({ idempotentReplay: true, usageCounted: false });
    expect((await client.get('/api/v1/usage')).body.data.counters.translations.used).toBe(1);
    expect(h.d1.q('SELECT retry_count FROM usage_events')[0]!.retry_count).toBe(1);
    const conflict = await translate(client, 'תודה', {}, key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('idempotency_conflict');
  });

  it('keeps clients from touching counters (no such endpoint)', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    expect((await client.post('/api/v1/usage', { used: 0 })).status).toBe(404);
    expect((await client.patch('/api/v1/usage', { used: 0 })).status).toBe(404);
  });

  it('respects the emoji feature flag', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    h.d1.q(`UPDATE feature_flags SET enabled = 0 WHERE key = 'emoji_translation'`);
    const r = await translate(client, 'שלום');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('feature_disabled');
  });

  it('returns localized error messages', async () => {
    const h = createHarness();
    const { client } = await signUp(h, { locale: 'he' });
    const r = await translate(client, '   ');
    expect(r.body.error.message).toBe('יש להזין טקסט.');
  });

  it('lists plans without inventing prices', async () => {
    const h = createHarness();
    const r = await new Client(h).get('/api/v1/plans');
    expect(r.status).toBe(200);
    const plans = r.body.data.plans;
    expect(plans.map((p: { id: string }) => p.id)).toEqual(['free', 'pro', 'business']);
    for (const p of plans) {
      expect(p.pricing).toBeNull();
      expect(p.pricingStatus).toBe('to_be_announced');
    }
    expect(plans[1].availability).toBe('waitlist');
    expect(plans[2].availability).toBe('contact_sales');
    expect(plans[0].entitlements['translations.monthly_limit']).toBe(50);
  });
});
