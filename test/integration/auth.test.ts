import { describe, expect, it } from 'vitest';
import { Client, createHarness, ORIGIN, PASSWORD, signUp, uniqueEmail } from '../helpers/harness';

describe('authentication', () => {
  it('registers without revealing whether the email exists', async () => {
    const h = createHarness();
    const c = new Client(h);
    const email = uniqueEmail();
    const first = await c.post('/api/v1/auth/register', { name: 'A', email, password: PASSWORD });
    const second = await c.post('/api/v1/auth/register', { name: 'B', email, password: PASSWORD });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.data).toEqual(first.body.data);
    expect(h.d1.q('SELECT COUNT(*) AS n FROM users')[0]!.n).toBe(1);
  });

  it('stores only password hashes and token hashes', async () => {
    const h = createHarness();
    await signUp(h);
    const cred = h.d1.q<{ password_hash: string }>('SELECT password_hash FROM user_credentials')[0]!;
    expect(cred.password_hash.startsWith('pbkdf2_sha256$100000$')).toBe(true);
    expect(cred.password_hash).not.toContain(PASSWORD);
    const token = h.d1.q<{ token_hash: string }>('SELECT token_hash FROM one_time_tokens')[0]!;
    expect(token.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const ses = h.d1.q<{ token_hash: string }>('SELECT token_hash FROM sessions')[0]!;
    expect(ses.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses identical errors for unknown email and wrong password', async () => {
    const h = createHarness();
    const { email } = await signUp(h);
    const c = new Client(h);
    const wrong = await c.post('/api/v1/auth/login', { email, password: 'wrong-password-123' });
    const unknown = await c.post('/api/v1/auth/login', { email: 'nobody@example.com', password: 'wrong-password-123' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('invalid_credentials');
    expect(unknown.body.error).toEqual(wrong.body.error);
  });

  it('sets a HttpOnly SameSite session cookie and serves /me', async () => {
    const h = createHarness();
    const email = uniqueEmail();
    const c = new Client(h);
    await c.post('/api/v1/auth/register', { name: 'Dana', email, password: PASSWORD, locale: 'he' });
    const res = await c.post('/api/v1/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(res.body.data.csrfToken).toBeTruthy();
    const me = await c.get('/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(email);
    expect(me.body.data.user.direction).toBe('rtl');
    expect(JSON.stringify(me.body)).not.toMatch(/password|token_hash|pbkdf2/);
  });

  it('requires a CSRF token and an allowed Origin for state changes', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    const noToken = await client.patch('/api/v1/me', { name: 'X' }, { 'x-csrf-token': '' });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('csrf_failed');
    const badOrigin = await client.patch('/api/v1/me', { name: 'X' }, { origin: 'https://evil.example' });
    expect(badOrigin.status).toBe(403);
    const good = await client.patch('/api/v1/me', { name: 'Yossi Cohen' });
    expect(good.status).toBe(200);
    expect(good.body.data.user.name).toBe('Yossi Cohen');
  });

  it('rejects mass assignment of privileged fields', async () => {
    const h = createHarness();
    const { client, userId } = await signUp(h);
    const r = await client.patch('/api/v1/me', { name: 'ok', platform_role: 'superadmin', status: 'active' });
    expect(r.status).toBe(422);
    expect(h.d1.q<{ platform_role: string }>('SELECT platform_role FROM users WHERE id = ?', userId)[0]!.platform_role).toBe('user');
  });

  it('rotates the session on refresh and revokes the old token', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    const oldCookie = client.cookie;
    const r = await client.post('/api/v1/auth/refresh');
    expect(r.status).toBe(200);
    expect(client.cookie).not.toBe(oldCookie);
    expect((await client.get('/api/v1/me')).status).toBe(200);
    const stale = new Client(h);
    stale.cookie = oldCookie;
    expect((await stale.get('/api/v1/me')).status).toBe(401);
  });

  it('logs out and invalidates the session', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    const cookie = client.cookie;
    expect((await client.post('/api/v1/auth/logout')).status).toBe(200);
    const again = new Client(h);
    again.cookie = cookie;
    expect((await again.get('/api/v1/me')).status).toBe(401);
  });

  it('completes the password reset flow and revokes all sessions', async () => {
    const h = createHarness();
    const { client, email } = await signUp(h);
    const anon = new Client(h);
    const unknown = await anon.post('/api/v1/auth/password/forgot', { email: 'nobody@example.com' });
    const known = await anon.post('/api/v1/auth/password/forgot', { email });
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(known.body.data).toEqual(unknown.body.data);
    const mail = h.email.outbox.find((m) => m.to === email && m.text.includes('reset-password'))!;
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    const reset = await anon.post('/api/v1/auth/password/reset', { token, password: 'a-brand-new-password' });
    expect(reset.status).toBe(200);
    expect((await anon.post('/api/v1/auth/password/reset', { token, password: 'another-password-1' })).status).toBe(400);
    expect((await client.get('/api/v1/me')).status).toBe(401);
    expect((await anon.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(401);
    expect((await anon.post('/api/v1/auth/login', { email, password: 'a-brand-new-password' })).status).toBe(200);
  });

  it('expires password reset tokens', async () => {
    const h = createHarness();
    const { email } = await signUp(h);
    const anon = new Client(h);
    await anon.post('/api/v1/auth/password/forgot', { email });
    const token = /token=([A-Za-z0-9_-]+)/.exec(h.email.outbox.find((m) => m.text.includes('reset-password'))!.text)![1]!;
    h.clock.now += 2 * 60 * 60 * 1000;
    const r = await anon.post('/api/v1/auth/password/reset', { token, password: 'a-brand-new-password' });
    expect(r.body.error.code).toBe('invalid_token');
  });

  it('changes password, keeping only the current (rotated) session', async () => {
    const h = createHarness();
    const { client, email } = await signUp(h);
    const other = new Client(h);
    await other.post('/api/v1/auth/login', { email, password: PASSWORD });
    const r = await client.post('/api/v1/auth/password/change', { currentPassword: PASSWORD, newPassword: 'changed-password-99' });
    expect(r.status).toBe(200);
    expect((await client.get('/api/v1/me')).status).toBe(200);
    expect((await other.get('/api/v1/me')).status).toBe(401);
  });

  it('verifies email with a single-use token', async () => {
    const h = createHarness();
    const { client } = await signUp(h, { verify: false });
    expect((await client.get('/api/v1/me')).body.data.user.emailVerified).toBe(false);
    const token = /token=([A-Za-z0-9_-]+)/.exec(h.email.outbox.find((m) => m.text.includes('verify-email'))!.text)![1]!;
    expect((await client.post('/api/v1/auth/email/verify', { token })).status).toBe(200);
    expect((await client.get('/api/v1/me')).body.data.user.emailVerified).toBe(true);
    expect((await client.post('/api/v1/auth/email/verify', { token })).status).toBe(400);
  });

  it('rate limits login attempts per email', async () => {
    const h = createHarness();
    const { email } = await signUp(h);
    const c = new Client(h);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await c.post('/api/v1/auth/login', { email, password: 'wrong-password-x' }, { 'cf-connecting-ip': `10.0.0.${i}` })).status;
    expect(last).toBe(429);
  });

  it('lists and revokes own sessions only', async () => {
    const h = createHarness();
    const a = await signUp(h);
    const b = await signUp(h);
    const list = await a.client.get('/api/v1/me/sessions');
    expect(list.body.data.sessions).toHaveLength(1);
    expect(list.body.data.sessions[0].current).toBe(true);
    const bSessions = await b.client.get('/api/v1/me/sessions');
    const bId = bSessions.body.data.sessions[0].id;
    expect((await a.client.delete(`/api/v1/me/sessions/${bId}`)).status).toBe(404);
    expect((await b.client.get('/api/v1/me')).status).toBe(200);
  });

  it('deactivates and reactivates on next sign-in', async () => {
    const h = createHarness();
    const { client, email } = await signUp(h);
    expect((await client.post('/api/v1/me/deactivate', { password: PASSWORD })).status).toBe(200);
    expect((await client.get('/api/v1/me')).status).toBe(401);
    const c = new Client(h);
    expect((await c.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
  });

  it('does not issue cookies to disallowed origins via CORS', async () => {
    const h = createHarness();
    const res = await h.app.request('/api/v1/plans', { headers: { origin: 'https://evil.example' } }, h.env);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const ok = await h.app.request('/api/v1/plans', { headers: { origin: ORIGIN } }, h.env);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
