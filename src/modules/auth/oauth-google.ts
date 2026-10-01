import type { Services } from '../../context';
import { batch, first, run, stmt } from '../../lib/db';
import { fromBase64Url, newId, randomToken, sha256Hex, toBase64Url } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { MINUTE } from '../../lib/time';
import { isFlagEnabled } from '../flags/service';
import { normalizeEmail, type UserRow } from '../users/model';

/**
 * Optional Google OAuth 2.0 / OpenID Connect adapter (authorization code + PKCE).
 * Active only when GOOGLE_CLIENT_ID/SECRET are configured AND the `google_oauth`
 * feature flag is on. The ID token is received directly from Google's token
 * endpoint over TLS (OIDC Core §3.1.3.7), and its iss/aud/exp/email_verified
 * claims are validated before use.
 */
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const STATE_TTL = 10 * MINUTE;

export async function assertGoogleEnabled(svc: Services): Promise<void> {
  if (!svc.config.googleOAuthConfigured) throw new AppError('provider_not_configured');
  if (!(await isFlagEnabled(svc, 'google_oauth'))) throw new AppError('feature_disabled');
}

const redirectUri = (svc: Services) => `${svc.config.API_BASE_URL}/api/v1/auth/oauth/google/callback`;

/** Only same-app relative paths are accepted as post-login destinations (no open redirects). */
export function safeRedirectPath(p: string | undefined): string {
  if (!p || !p.startsWith('/') || p.startsWith('//') || p.includes('\\') || p.length > 200) return '/';
  return p;
}

export async function startGoogleAuth(svc: Services, redirectPath: string): Promise<string> {
  await assertGoogleEnabled(svc);
  const state = randomToken();
  const verifier = randomToken(48);
  const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const now = svc.now();
  await run(
    svc.db,
    'INSERT INTO oauth_states (state_hash, provider, code_verifier, redirect_path, created_at, expires_at) VALUES (?,?,?,?,?,?)',
    await sha256Hex(state), 'google', verifier, safeRedirectPath(redirectPath), now, now + STATE_TTL,
  );
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: svc.config.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(svc),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

interface IdClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export async function completeGoogleAuth(
  svc: Services,
  code: string,
  state: string,
): Promise<{ user: UserRow; redirectPath: string }> {
  await assertGoogleEnabled(svc);
  const now = svc.now();
  const st = await first<{ code_verifier: string; redirect_path: string }>(
    svc.db,
    `DELETE FROM oauth_states WHERE state_hash = ? AND provider = 'google' AND expires_at > ? RETURNING code_verifier, redirect_path`,
    await sha256Hex(state), now,
  );
  if (!st) throw new AppError('invalid_token');

  const res = await svc.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: svc.config.GOOGLE_CLIENT_ID!,
      client_secret: svc.config.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(svc),
      grant_type: 'authorization_code',
      code_verifier: st.code_verifier,
    }).toString(),
  });
  if (!res.ok) throw new AppError('provider_error', { message: `google token exchange ${res.status}` });
  const tokenJson = (await res.json()) as { id_token?: string };
  const claims = decodeJwtPayload(tokenJson.id_token);
  if (
    !claims ||
    !claims.iss || !ISSUERS.has(claims.iss) ||
    claims.aud !== svc.config.GOOGLE_CLIENT_ID ||
    !claims.sub ||
    !claims.exp || claims.exp * 1000 < now ||
    !claims.email || claims.email_verified !== true
  ) {
    throw new AppError('invalid_token');
  }

  const user = await findOrCreateGoogleUser(svc, claims as Required<Pick<IdClaims, 'sub' | 'email'>> & IdClaims);
  if (user.status === 'suspended' || user.status === 'deleted') throw new AppError('account_inactive');
  if (user.status === 'deactivated') {
    await run(svc.db, `UPDATE users SET status = 'active', updated_at = ? WHERE id = ?`, now, user.id);
    user.status = 'active';
  }
  return { user, redirectPath: st.redirect_path };
}

async function findOrCreateGoogleUser(svc: Services, claims: IdClaims & { sub: string; email: string }): Promise<UserRow> {
  const linked = await first<UserRow>(
    svc.db,
    `SELECT u.* FROM auth_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = 'google' AND i.provider_subject = ?`,
    claims.sub,
  );
  if (linked) return linked;
  const now = svc.now();
  const emailNorm = normalizeEmail(claims.email);
  const existing = await first<UserRow>(svc.db, 'SELECT * FROM users WHERE email_normalized = ?', emailNorm);
  if (existing) {
    // Google asserts a verified email, so linking to the same address is safe.
    await run(
      svc.db,
      'INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?,?,?,?,?)',
      newId('idn'), existing.id, 'google', claims.sub, now,
    );
    await run(svc.db, 'UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', now, existing.id);
    return existing;
  }
  const id = newId('usr');
  await batch(svc.db, [
    stmt(
      svc.db,
      `INSERT INTO users (id, email, email_normalized, email_verified_at, name, status, platform_role, locale, created_at, updated_at)
       VALUES (?,?,?,?,?, 'active', 'user', 'he', ?, ?)`,
      id, claims.email, emailNorm, now, (claims.name ?? claims.email.split('@')[0] ?? 'User').slice(0, 100), now, now,
    ),
    stmt(svc.db, 'INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?,?,?,?,?)', newId('idn'), id, 'google', claims.sub, now),
  ]);
  return (await first<UserRow>(svc.db, 'SELECT * FROM users WHERE id = ?', id))!;
}

function decodeJwtPayload(jwt: string | undefined): IdClaims | null {
  if (!jwt) return null;
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as IdClaims;
  } catch {
    return null;
  }
}
