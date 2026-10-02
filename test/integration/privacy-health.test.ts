import { describe, expect, it } from 'vitest';
import { runMaintenance } from '../../src/cron';
import { Client, createHarness, PASSWORD, signUp } from '../helpers/harness';

const HISTORY_ON = { enabled: true, consentVersion: '2026-10-01' };

function makePro(h: ReturnType<typeof createHarness>, userId: string) {
  h.d1.q(
    `INSERT INTO subscriptions (id, subject_type, subject_id, plan_id, status, provider, current_period_start, current_period_end, created_at, updated_at)
     VALUES (?, 'user', ?, 'pro', 'active', 'manual', ?, ?, ?, ?)`,
    `sub_${userId.slice(4)}`, userId, h.clock.now, h.clock.now + 30 * 86400000, h.clock.now, h.clock.now,
  );
}

describe('privacy-first defaults & saved history', () => {
  it('stores no translation text by default', async () => {
    const h = createHarness({ withQueue: false });
    const { client } = await signUp(h);
    await client.post('/api/v1/emoji/translate', { text: 'טקסט פרטי שמח' });
    await client.post('/api/v1/sign/translate', { text: 'טקסט פרטי' });
    const dump = h.d1
      .q<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((t) => JSON.stringify(h.d1.q(`SELECT * FROM "${t.name}"`)))
      .join('\n');
    expect(dump).not.toContain('טקסט פרטי');
  });

  it('requires explicit consent and a plan entitlement before saving history', async () => {
    const h = createHarness();
    const { client, userId } = await signUp(h);
    const item = { kind: 'emoji', sourceText: 'שלום', language: 'he', output: { result: 'שלום 👋', mode: 'text_and_emoji', style: 'standard' } };
    expect((await client.post('/api/v1/history', item)).body.error.code).toBe('feature_disabled');
    expect((await client.put('/api/v1/me/privacy/history', HISTORY_ON)).body.error.code).toBe('entitlement_required');
    makePro(h, userId);
    expect((await client.put('/api/v1/me/privacy/history', { enabled: true })).status).toBe(422);
    const on = await client.put('/api/v1/me/privacy/history', HISTORY_ON);
    expect(on.body.data.user.privacy.historyEnabled).toBe(true);
    expect((await client.post('/api/v1/history', item)).status).toBe(201);
    await client.post('/api/v1/history', { ...item, sourceText: 'תודה רבה' });
    const list = await client.get('/api/v1/history?q=' + encodeURIComponent('תודה'));
    expect(list.body.data.items).toHaveLength(1);
    const other = await signUp(h);
    expect((await other.client.delete(`/api/v1/history/${list.body.data.items[0].id}`)).status).toBe(404);
    expect((await client.delete('/api/v1/history')).body.data.deleted).toBe(2);
  });

  it('exports account data', async () => {
    const h = createHarness();
    const { client, email } = await signUp(h);
    const r = await client.get('/api/v1/me/export');
    expect(r.body.data.profile.email).toBe(email);
    expect(r.body.data.notStored.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toMatch(/pbkdf2|token_hash/);
  });

  it('deletes and anonymizes the account', async () => {
    const h = createHarness();
    const { client, email, userId } = await signUp(h);
    makePro(h, userId);
    await client.put('/api/v1/me/privacy/history', HISTORY_ON);
    await client.post('/api/v1/history', { kind: 'emoji', sourceText: 'סוד', language: 'he', output: { result: 'x', mode: 'emoji_only', style: 'minimal' } });
    expect((await client.delete('/api/v1/me', { password: PASSWORD })).status).toBe(422); // confirmation required
    expect((await client.delete('/api/v1/me', { password: 'wrong-password', confirm: 'DELETE' })).status).toBe(401);
    expect((await client.delete('/api/v1/me', { password: PASSWORD, confirm: 'DELETE' })).status).toBe(200);
    const u = h.d1.q<{ email: string; name: string; status: string }>('SELECT email, name, status FROM users WHERE id = ?', userId)[0]!;
    expect(u).toEqual({ email: `deleted+${userId}@invalid`, name: '', status: 'deleted' });
    expect(h.d1.q('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', userId)[0]!.n).toBe(0);
    expect(h.d1.q('SELECT COUNT(*) AS n FROM user_credentials WHERE user_id = ?', userId)[0]!.n).toBe(0);
    expect(h.d1.q('SELECT COUNT(*) AS n FROM saved_translations')[0]!.n).toBe(0);
    expect(h.d1.q(`SELECT status FROM subscriptions WHERE subject_id = ?`, userId)[0]!.status).toBe('cancelled');
    expect((await new Client(h).post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(401);
    // The address can be registered again as a new account.
    expect((await new Client(h).post('/api/v1/auth/register', { name: 'New', email, password: PASSWORD })).status).toBe(202);
    expect(h.d1.q(`SELECT COUNT(*) AS n FROM users WHERE email_normalized = ?`, email)[0]!.n).toBe(1);
  });

  it('blocks deletion while the user is the sole owner of an organization with members', async () => {
    const h = createHarness();
    const owner = await signUp(h);
    const org = (await owner.client.post('/api/v1/organizations', { name: 'Org' })).body.data.organization;
    const member = await signUp(h);
    h.d1.q(`INSERT INTO organization_members VALUES (?, ?, 'member', 0, 0)`, org.id, member.userId);
    const r = await owner.client.delete('/api/v1/me', { password: PASSWORD, confirm: 'DELETE' });
    expect(r.status).toBe(409);
    expect(r.body.error.details).toEqual({ reason: 'sole_owner_of_organizations', organizationIds: [org.id] });
  });
});

describe('health, errors & maintenance', () => {
  it('separates liveness and readiness without leaking internals', async () => {
    const h = createHarness();
    const live = await h.app.request('/health', {}, h.env);
    expect(await live.json()).toEqual({ status: 'ok' });
    const ready = await h.app.request('/ready', {}, h.env);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready', checks: { configuration: 'ok', database: 'ok', storage: 'ok', queue: 'ok' } });
    expect((await h.app.request('/health/', {}, h.env)).status).toBe(200);
    expect((await h.app.request('/api/v1/plans/', {}, h.env)).status).toBe(200);
    const root = await h.app.request('/', {}, h.env);
    expect(await root.json()).toMatchObject({ service: 'signa-api', status: 'ok' });
  });

  it('stays alive and reports not-ready when configuration is invalid (e.g. missing APP_SECRET)', async () => {
    const { createApp } = await import('../../src/app');
    const app = createApp();
    const env = { DB: {} as D1Database, APP_ENV: 'production', APP_BASE_URL: 'https://signa.example' };
    const errors: string[] = [];
    const orig = console.error;
    console.error = (l: string) => errors.push(l);
    try {
      expect((await app.request('/health', {}, env)).status).toBe(200);
      expect((await app.request('/', {}, env)).status).toBe(200);
      const ready = await app.request('/ready', {}, env);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: 'not_ready', checks: { configuration: 'fail' } });
      const api = await app.request('/api/v1/plans', {}, env);
      expect(api.status).toBe(503);
      expect(await api.text()).not.toContain('APP_SECRET');
    } finally {
      console.error = orig;
    }
    expect(errors.join('\n')).toContain('APP_SECRET');
  });

  it('reports not ready when the database is down', async () => {
    const h = createHarness({ services: { db: { prepare() { throw new Error('db down: secret-host'); } } as unknown as D1Database } });
    const r = await h.app.request('/ready', {}, h.env);
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain('secret-host');
  });

  it('returns consistent JSON errors with security headers', async () => {
    const h = createHarness();
    const r = await h.app.request('/api/v1/nope', { headers: { 'accept-language': 'he' } }, h.env);
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: { code: 'not_found', message: 'לא נמצא.' }, meta: { requestId: expect.stringMatching(/^req_/) } });
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const malformed = await new Client(h).request('POST', '/api/v1/auth/login', undefined, { 'content-type': 'application/json' });
    expect(malformed.status).toBe(422);
  });

  it('hides stack traces of unexpected errors', async () => {
    const h = createHarness({ services: { emojiEngine: { name: 'x', version: '0', translate: async () => { throw new Error('boom at /src/secret.ts:1'); } } } });
    const { client } = await signUp(h);
    const r = await client.post('/api/v1/emoji/translate', { text: 'שלום' });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain('secret.ts');
    expect((await client.get('/api/v1/usage')).body.data.counters.translations.used).toBe(0);
  });

  it('runs scheduled maintenance', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    await client.post('/api/v1/sign/translate', { text: 'שלום' });
    h.clock.now += 40 * 86400000;
    const result = await runMaintenance(h.services(), '*/10 * * * *');
    expect(result.jobs).toMatchObject({ expired: 1 });
    expect(h.d1.q('SELECT COUNT(*) AS n FROM sessions')[0]!.n).toBe(0);
    expect(h.d1.q('SELECT COUNT(*) AS n FROM rate_limits')[0]!.n).toBe(0);
  });

  it('refuses insecure production configuration', async () => {
    const { loadConfig } = await import('../../src/env');
    const base = { DB: {} as D1Database, APP_SECRET: 'x'.repeat(40), APP_ENV: 'production' };
    expect(() => loadConfig({ ...base, APP_BASE_URL: 'http://signa.example' })).toThrow(/https/);
    expect(() => loadConfig({ ...base, APP_BASE_URL: 'https://signa.example', PAYMENT_PROVIDER: 'dev', DEV_PAYMENT_WEBHOOK_SECRET: 's' })).toThrow(/dev payment/);
    expect(() => loadConfig({ ...base, APP_SECRET: 'short' })).toThrow(/APP_SECRET/);
    expect(loadConfig({ ...base, APP_BASE_URL: 'https://signa.example', API_BASE_URL: 'https://api.signa.example' }).cookieSecure).toBe(true);
  });
});
