import { createApp } from '../../src/app';
import type { Services } from '../../src/context';
import type { Bindings, SignJobMessage } from '../../src/env';
import { loadConfig } from '../../src/env';
import { silentLogger } from '../../src/lib/logger';
import { DevPaymentProvider } from '../../src/modules/billing/provider';
import type { AssetStore } from '../../src/modules/dictionary/asset-store';
import { DevEmailProvider } from '../../src/modules/email/provider';
import type { JobQueue } from '../../src/modules/sign/queue';
import { buildServices } from '../../src/services';
import { TestD1 } from './d1';

export const ORIGIN = 'http://localhost:3000';
export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';

export class MemoryQueue implements JobQueue {
  messages: SignJobMessage[] = [];
  fail = false;
  async send(m: SignJobMessage) {
    if (this.fail) throw new Error('queue down');
    this.messages.push(m);
  }
}

export class MemoryAssetStore implements AssetStore {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array, opts: { contentType: string }) {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer);
    this.objects.set(key, { bytes, contentType: opts.contentType });
  }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { body: new Blob([o.bytes as unknown as ArrayBuffer]).stream(), contentType: o.contentType, size: o.bytes.byteLength, etag: '"x"' };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async ping() {
    return true;
  }
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  env: Bindings;
  d1: TestD1;
  email: DevEmailProvider;
  queue: MemoryQueue;
  assets: MemoryAssetStore;
  clock: { now: number };
  services: () => Services;
  overrides: Partial<Services>;
}

export function createHarness(opts: { envOverrides?: Partial<Bindings>; services?: Partial<Services>; withQueue?: boolean } = {}): Harness {
  const d1 = new TestD1();
  const env: Bindings = {
    DB: d1 as unknown as D1Database,
    APP_ENV: 'test',
    APP_BASE_URL: ORIGIN,
    API_BASE_URL: 'http://localhost:8787',
    CORS_ALLOWED_ORIGINS: ORIGIN,
    APP_SECRET: 'test-secret-test-secret-test-secret-0000',
    EMAIL_PROVIDER: 'dev',
    PAYMENT_PROVIDER: 'dev',
    DEV_PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SIGN_PROVIDER: 'dictionary_lookup',
    ...opts.envOverrides,
  };
  const clock = { now: Date.UTC(2026, 9, 15, 12, 0, 0) };
  const email = new DevEmailProvider();
  const queue = new MemoryQueue();
  const assets = new MemoryAssetStore();
  const config = loadConfig(env);
  const overrides: Partial<Services> = {
    config,
    now: () => clock.now,
    logger: silentLogger,
    email,
    payment: new DevPaymentProvider(WEBHOOK_SECRET, ORIGIN),
    jobQueue: opts.withQueue === false ? null : queue,
    assetStore: assets,
    ...opts.services,
  };
  const app = createApp(overrides);
  return { app, env, d1, email, queue, assets, clock, overrides, services: () => buildServices(env, overrides) };
}

/** Browser-like client: keeps the session cookie and sends Origin + CSRF token. */
export class Client {
  cookie = '';
  csrf = '';
  orgId: string | null = null;
  constructor(private readonly h: Harness) {}

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const init: RequestInit = {
      method,
      headers: {
        origin: ORIGIN,
        'accept-language': 'en',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        ...(this.orgId ? { 'x-organization-id': this.orgId } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await this.h.app.request(path, init, this.h.env);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = /signa_session=([^;]*)/.exec(setCookie);
      if (m) this.cookie = m[1] ? `signa_session=${m[1]}` : '';
      if (/Max-Age=0/i.test(setCookie)) this.cookie = '';
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (json?.data?.csrfToken) this.csrf = json.data.csrfToken;
    return { status: res.status, body: json, headers: res.headers };
  }
  get(p: string, h?: Record<string, string>) {
    return this.request('GET', p, undefined, h);
  }
  post(p: string, b: unknown = {}, h?: Record<string, string>) {
    return this.request('POST', p, b, h);
  }
  patch(p: string, b: unknown, h?: Record<string, string>) {
    return this.request('PATCH', p, b, h);
  }
  put(p: string, b: unknown, h?: Record<string, string>) {
    return this.request('PUT', p, b, h);
  }
  delete(p: string, b?: unknown, h?: Record<string, string>) {
    return this.request('DELETE', p, b, h);
  }
}

let counter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}${++counter}@example.com`;
export const PASSWORD = 'correct-horse-battery-staple';

/** Registers, verifies (via the dev outbox link) and signs in a user. */
export async function signUp(
  h: Harness,
  opts: { email?: string; name?: string; verify?: boolean; role?: 'support' | 'admin' | 'superadmin'; locale?: 'he' | 'en' } = {},
) {
  const email = opts.email ?? uniqueEmail();
  const c = new Client(h);
  const r = await c.post('/api/v1/auth/register', { name: opts.name ?? 'Test User', email, password: PASSWORD, locale: opts.locale ?? 'en' });
  if (r.status !== 202) throw new Error(`register failed ${r.status} ${JSON.stringify(r.body)}`);
  if (opts.verify !== false) {
    const msg = [...h.email.outbox].reverse().find((m) => m.to === email && m.text.includes('verify-email'));
    const token = /token=([A-Za-z0-9_-]+)/.exec(msg!.text)![1]!;
    const v = await c.post('/api/v1/auth/email/verify', { token });
    if (v.status !== 200) throw new Error('verify failed');
  }
  if (opts.role) h.d1.q('UPDATE users SET platform_role = ? WHERE email_normalized = ?', opts.role, email);
  const l = await c.post('/api/v1/auth/login', { email, password: PASSWORD });
  if (l.status !== 200) throw new Error(`login failed ${l.status} ${JSON.stringify(l.body)}`);
  return { client: c, email, userId: l.body.data.user.id as string };
}

/** Creates a published, approved, licence-confirmed dictionary entry with an approved asset (direct DB seeding). */
export function seedSign(
  h: Harness,
  opts: { code: string; gloss: string; labelHe: string; variants?: string[]; withAsset?: boolean; visibility?: 'public' | 'private'; conceptKey?: string; isDefault?: boolean; nmm?: unknown[] },
) {
  const id = `sgn_${opts.code.toLowerCase().replace(/[^a-z0-9]/g, '')}seed00000000`;
  const now = h.clock.now;
  h.d1.q(
    `INSERT INTO sign_entries (id, sign_code, canonical_label, label_he, hebrew_terms_json, concept_key, is_default_variant, non_manual_markers_json,
       validation_status, license_status, reviewer_ref, publication_status, version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?, 'approved', 'confirmed', 'expert-panel-1', 'published', 1, ?, ?)`,
    id, opts.code, opts.gloss, opts.labelHe, JSON.stringify(opts.variants ?? []), opts.conceptKey ?? null, opts.isDefault ? 1 : 0, JSON.stringify(opts.nmm ?? []), now, now,
  );
  if (opts.withAsset !== false) {
    h.d1.q(
      `INSERT INTO animation_assets (id, sign_entry_id, r2_key, mime_type, size_bytes, max_size_bytes, duration_ms, asset_version, license_json, approval_status, visibility, created_at, updated_at)
       VALUES (?,?,?, 'model/gltf-binary', 100, 1000, 900, 1, '{"status":"confirmed","licenseId":"L1","holder":"Signa"}', 'approved', ?, ?, ?)`,
      `ast_${id.slice(4)}`, id, `animations/${id}`, opts.visibility ?? 'public', now, now,
    );
  }
  return id;
}
