import { describe, expect, it } from 'vitest';
import { Client, createHarness, ORIGIN, PASSWORD, signUp } from '../helpers/harness';

const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 1, 2, 3, 4]); // "glTF" magic

async function upload(h: ReturnType<typeof createHarness>, c: Client, url: string, token: string, bytes: Uint8Array, type = 'model/gltf-binary') {
  const res = await h.app.request(
    new URL(url).pathname,
    { method: 'PUT', headers: { origin: ORIGIN, cookie: c.cookie, 'x-csrf-token': c.csrf, 'x-upload-token': token, 'content-type': type, 'content-length': String(bytes.byteLength) }, body: bytes },
    h.env,
  );
  return { status: res.status, body: (await res.json()) as any };
}

describe('sign dictionary & asset registry', () => {
  it('runs the full editorial workflow and only exposes published, approved data', async () => {
    const h = createHarness();
    const admin = await signUp(h, { role: 'admin' });
    const user = await signUp(h);
    const base = '/api/v1/admin/dictionary';

    expect((await user.client.post(`${base}/entries`, { canonicalLabel: 'HELLO' })).status).toBe(403);
    const created = await admin.client.post(`${base}/entries`, { canonicalLabel: 'HELLO', labelHe: 'שלום', hebrewTerms: ['היי'] });
    expect(created.status).toBe(201);
    const entry = created.body.data.entry;
    expect(entry).toMatchObject({ code: 'SG-0001', validationStatus: 'draft', licenseStatus: 'pending', publicationStatus: 'draft' });

    // Not visible publicly; cannot be published before approval + licence.
    expect((await user.client.get(`/api/v1/dictionary/entries/${entry.id}`)).status).toBe(404);
    expect((await admin.client.post(`${base}/entries/${entry.id}/publish`)).body.error.details.reason).toBe('requires_expert_approval_and_confirmed_license');
    expect((await admin.client.post(`${base}/entries/${entry.id}/review`, { decision: 'approved' })).status).toBe(422); // reviewerRef required
    await admin.client.post(`${base}/entries/${entry.id}/review`, { decision: 'approved', reviewerRef: 'ISL-panel-2026-03' });
    expect((await admin.client.post(`${base}/entries/${entry.id}/publish`)).status).toBe(409);
    await admin.client.post(`${base}/entries/${entry.id}/license`, { status: 'confirmed' });
    expect((await admin.client.post(`${base}/entries/${entry.id}/publish`)).body.data.entry.publicationStatus).toBe('published');

    const pub = await user.client.get('/api/v1/dictionary/entries?q=שלום');
    expect(pub.body.data.entries).toHaveLength(1);
    expect(pub.body.data.entries[0]).not.toHaveProperty('reviewerRef');

    // Asset: register → upload (validated) → approve (licence required) → visible.
    const reg = await admin.client.post(`${base}/entries/${entry.id}/assets`, {
      mimeType: 'model/gltf-binary',
      durationMs: 850,
      license: { licenseId: 'LIC-1', holder: 'Signa Studio', status: 'pending' },
    });
    expect(reg.status).toBe(201);
    const { asset, upload: grant } = reg.body.data;
    expect(asset.approvalStatus).toBe('pending_upload');
    expect(JSON.stringify(reg.body)).not.toContain('animations/'); // R2 key never exposed
    expect((await upload(h, admin.client, grant.url, 'wrong-token-wrong-token', GLB)).status).toBe(403);
    expect((await upload(h, admin.client, grant.url, grant.token, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).status).toBe(415);
    expect((await upload(h, admin.client, grant.url, grant.token, GLB, 'video/mp4')).status).toBe(415);
    const up = await upload(h, admin.client, grant.url, grant.token, GLB);
    expect(up.status).toBe(200);
    expect(up.body.data.asset).toMatchObject({ approvalStatus: 'uploaded', sizeBytes: GLB.byteLength });
    expect(up.body.data.asset.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await upload(h, admin.client, grant.url, grant.token, GLB)).status).toBe(403); // single-use grant
    expect(h.assets.objects.size).toBe(1);

    expect((await admin.client.post(`${base}/assets/${asset.id}/review`, { decision: 'approved' })).body.error.details.reason).toBe('license_not_confirmed');
    await admin.client.patch(`${base}/assets/${asset.id}`, { license: { licenseId: 'LIC-1', holder: 'Signa Studio', status: 'confirmed' } });
    expect((await admin.client.post(`${base}/assets/${asset.id}/review`, { decision: 'approved' })).body.data.asset.approvalStatus).toBe('approved');

    const detail = await user.client.get(`/api/v1/dictionary/entries/${entry.id}`);
    expect(detail.body.data.assets).toHaveLength(1);
    const url = new URL(detail.body.data.assets[0].url);
    expect(url.searchParams.get('sig')).toBeTruthy(); // private asset → signed, short-lived URL
    const content = await h.app.request(url.pathname + url.search, {}, h.env);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(GLB);
    expect((await h.app.request(url.pathname, {}, h.env)).status).toBe(404);
    h.clock.now += 20 * 60 * 1000;
    expect((await h.app.request(url.pathname + url.search, {}, h.env)).status).toBe(404); // expired

    // Editing linguistic content resets approval and unpublishes; history is kept.
    const edited = await admin.client.patch(`${base}/entries/${entry.id}`, { hebrewTerms: ['היי', 'הי'] });
    expect(edited.body.data.entry).toMatchObject({ validationStatus: 'in_review', publicationStatus: 'unpublished', version: 4 });
    expect((await user.client.get(`/api/v1/dictionary/entries/${entry.id}`)).status).toBe(404);
    const revs = await admin.client.get(`${base}/entries/${entry.id}/revisions`);
    expect(revs.body.data.revisions.length).toBeGreaterThanOrEqual(3);
  });

  it('publishes immutable dictionary versions', async () => {
    const h = createHarness();
    const admin = await signUp(h, { role: 'admin' });
    h.d1.q(`INSERT INTO sign_entries (id, sign_code, canonical_label, validation_status, license_status, publication_status, version, created_at, updated_at)
            VALUES ('sgn_versiontest00001', 'SG-0001', 'HELLO', 'approved', 'confirmed', 'published', 3, 0, 0)`);
    const v = await admin.client.post('/api/v1/admin/dictionary/versions', { notes: 'first release' });
    expect(v.body.data).toEqual({ version: 1, entryCount: 1 });
    const pub = await new Client(h).get('/api/v1/dictionary/versions/1');
    expect(pub.body.data.entries).toEqual([{ id: 'sgn_versiontest00001', version: 3, code: 'SG-0001', gloss: 'HELLO' }]);
  });

  it('enforces the database invariant: unapproved entries cannot be published', () => {
    const h = createHarness();
    expect(() =>
      h.d1.q(`INSERT INTO sign_entries (id, sign_code, canonical_label, validation_status, license_status, publication_status, created_at, updated_at)
              VALUES ('sgn_x', 'SG-0099', 'X', 'in_review', 'confirmed', 'published', 0, 0)`),
    ).toThrow(/CHECK/);
  });
});

describe('administration', () => {
  it('separates platform roles and audits sensitive actions', async () => {
    const h = createHarness();
    const support = await signUp(h, { role: 'support' });
    const admin = await signUp(h, { role: 'admin' });
    const target = await signUp(h);
    const plain = await signUp(h);

    expect((await plain.client.get('/api/v1/admin/users')).status).toBe(403);
    const search = await support.client.get(`/api/v1/admin/users?q=${encodeURIComponent(target.email)}`);
    expect(search.body.data.users).toHaveLength(1);
    expect(JSON.stringify(search.body)).not.toMatch(/password|token|pbkdf2/i);
    expect((await support.client.post(`/api/v1/admin/users/${target.userId}/suspend`, { reason: 'abuse report' })).status).toBe(403);

    expect((await admin.client.post(`/api/v1/admin/users/${target.userId}/suspend`, { reason: 'abuse report' })).status).toBe(200);
    expect((await target.client.get('/api/v1/me')).status).toBe(401); // sessions revoked
    const relogin = await new Client(h).post('/api/v1/auth/login', { email: target.email, password: PASSWORD });
    expect(relogin.body.error.code).toBe('account_inactive');
    expect((await admin.client.post(`/api/v1/admin/users/${support.userId}/suspend`, { reason: 'test' })).status).toBe(200);
    expect((await admin.client.post(`/api/v1/admin/users/${admin.userId}/suspend`, { reason: 'self' })).status).toBe(403);

    const events = await admin.client.get('/api/v1/admin/audit-events?action=admin.user_suspended');
    expect(events.body.data.events).toHaveLength(2);
    expect(events.body.data.events[0].metadata.reason).toBe('test');
  });

  it('requires superadmin and recent re-authentication for privilege changes', async () => {
    const h = createHarness();
    const superadmin = await signUp(h, { role: 'superadmin' });
    const admin = await signUp(h, { role: 'admin' });
    const target = await signUp(h);
    const path = `/api/v1/admin/users/${target.userId}/platform-role`;
    expect((await admin.client.put(path, { role: 'admin', reason: 'promotion' })).status).toBe(403);
    h.clock.now += 20 * 60 * 1000;
    expect((await superadmin.client.put(path, { role: 'support', reason: 'promotion' })).body.error.code).toBe('reauthentication_required');
    expect((await superadmin.client.post('/api/v1/auth/reauthenticate', { password: PASSWORD })).status).toBe(200);
    expect((await superadmin.client.put(path, { role: 'support', reason: 'promotion' })).status).toBe(200);
    expect((await target.client.get('/api/v1/me')).status).toBe(401); // privilege change revokes sessions
  });

  it('manages plans, entitlements and feature flags with validation', async () => {
    const h = createHarness();
    const sa = await signUp(h, { role: 'superadmin' });
    const bad = await sa.client.put('/api/v1/admin/plans/free/entitlements', { 'translations.monthly_limit': -5 });
    expect(bad.status).toBe(422);
    expect((await sa.client.put('/api/v1/admin/plans/free/entitlements', { 'is_admin': true })).status).toBe(422);
    const okR = await sa.client.put('/api/v1/admin/plans/free/entitlements', { 'translations.monthly_limit': 100 });
    expect(okR.body.data.entitlements['translations.monthly_limit']).toBe(100);
    expect((await sa.client.put('/api/v1/admin/feature-flags/sign_translation', { enabled: false })).status).toBe(200);
    const blocked = await sa.client.post('/api/v1/sign/translate', { text: 'שלום' });
    expect(blocked.body.error.code).toBe('feature_disabled');
  });

  it('reports overview, job statistics and engine health without content', async () => {
    const h = createHarness();
    const admin = await signUp(h, { role: 'admin' });
    await admin.client.post('/api/v1/emoji/translate', { text: 'שלום תודה' });
    const overview = await admin.client.get('/api/v1/admin/overview');
    expect(overview.body.data.registeredUsers.total).toBe(1);
    expect(overview.body.data.translations.succeeded).toBe(1);
    expect(overview.body.data.infraCost).toBeNull();
    const health = await admin.client.get('/api/v1/admin/engine/health');
    expect(health.body.data.sign).toMatchObject({ provider: 'dictionary-lookup', linguisticallyValidated: false });
    expect(JSON.stringify(health.body)).not.toContain('test-secret');
    expect((await admin.client.get('/api/v1/admin/jobs/stats')).status).toBe(200);
  });
});
