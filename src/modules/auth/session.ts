import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Services } from '../../context';
import { first, run } from '../../lib/db';
import { hmacHex, newId, randomToken, sha256Hex, timingSafeEqual } from '../../lib/crypto';
import { DAY, MINUTE } from '../../lib/time';
import type { UserRow } from '../users/model';

export const SESSION_IDLE_TTL = 7 * DAY;
export const SESSION_ABSOLUTE_TTL = 30 * DAY;
const TOUCH_INTERVAL = 5 * MINUTE;

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  auth_method: string;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
  authenticated_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_reason: string | null;
}

export interface AuthContext {
  user: UserRow;
  session: SessionRow;
}

export interface IssuedSession {
  session: SessionRow;
  token: string;
  csrfToken: string;
}

export function sessionCookieName(svc: Services): string {
  // __Host- prefix pins the cookie to this exact host, HTTPS and Path=/.
  return svc.config.cookieSecure ? '__Host-signa_session' : 'signa_session';
}

/**
 * Session management abstraction. A managed identity provider can later replace
 * credential verification while keeping this session layer (or vice versa).
 */
export async function createSession(
  svc: Services,
  userId: string,
  opts: { authMethod: string; userAgent?: string | null; authenticatedAt?: number },
): Promise<IssuedSession> {
  const now = svc.now();
  const token = randomToken();
  const session: SessionRow = {
    id: newId('ses'),
    user_id: userId,
    token_hash: await sha256Hex(token),
    auth_method: opts.authMethod,
    user_agent: opts.userAgent ? opts.userAgent.slice(0, 160) : null,
    created_at: now,
    last_seen_at: now,
    authenticated_at: opts.authenticatedAt ?? now,
    expires_at: now + SESSION_IDLE_TTL,
    revoked_at: null,
    revoked_reason: null,
  };
  await run(
    svc.db,
    `INSERT INTO sessions (id, user_id, token_hash, auth_method, user_agent, created_at, last_seen_at,
       authenticated_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    session.id,
    session.user_id,
    session.token_hash,
    session.auth_method,
    session.user_agent,
    session.created_at,
    session.last_seen_at,
    session.authenticated_at,
    session.expires_at,
  );
  return { session, token, csrfToken: await csrfTokenFor(svc, session.id) };
}

export async function findSessionByToken(svc: Services, token: string): Promise<AuthContext | null> {
  if (!token || token.length > 100) return null;
  const hash = await sha256Hex(token);
  const session = await first<SessionRow>(svc.db, 'SELECT * FROM sessions WHERE token_hash = ?', hash);
  const now = svc.now();
  if (!session || session.revoked_at !== null || session.expires_at <= now) return null;
  if (session.created_at + SESSION_ABSOLUTE_TTL <= now) return null;
  const user = await first<UserRow>(svc.db, 'SELECT * FROM users WHERE id = ?', session.user_id);
  if (!user || user.status !== 'active') return null;
  if (now - session.last_seen_at > TOUCH_INTERVAL) {
    const expires = Math.min(now + SESSION_IDLE_TTL, session.created_at + SESSION_ABSOLUTE_TTL);
    await run(svc.db, 'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', now, expires, session.id);
    session.last_seen_at = now;
    session.expires_at = expires;
  }
  return { user, session };
}

/**
 * Synchronizer CSRF token bound to the session: HMAC(APP_SECRET, session id).
 * It can be re-derived at any time (GET /api/v1/auth/csrf) and is useless without
 * the HttpOnly session cookie. Rotating the session rotates the CSRF token.
 */
export function csrfTokenFor(svc: Services, sessionId: string): Promise<string> {
  return hmacHex(svc.config.APP_SECRET, `csrf|${sessionId}`);
}

export async function verifyCsrf(svc: Services, session: SessionRow, headerToken: string | undefined): Promise<boolean> {
  if (!headerToken || headerToken.length > 100) return false;
  return timingSafeEqual(headerToken, await csrfTokenFor(svc, session.id));
}

export async function revokeSession(svc: Services, sessionId: string, reason: string): Promise<void> {
  await run(svc.db, 'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL', svc.now(), reason, sessionId);
}

export async function revokeAllSessions(
  svc: Services,
  userId: string,
  reason: string,
  exceptSessionId?: string,
): Promise<number> {
  return run(
    svc.db,
    `UPDATE sessions SET revoked_at = ?, revoked_reason = ?
      WHERE user_id = ? AND revoked_at IS NULL AND id <> ?`,
    svc.now(),
    reason,
    userId,
    exceptSessionId ?? '',
  );
}

/** Replaces the current session with a fresh one (new token + CSRF secret). */
export async function rotateSession(
  svc: Services,
  current: SessionRow,
  reason: string,
  opts: { reauthenticated?: boolean } = {},
): Promise<IssuedSession> {
  const issued = await createSession(svc, current.user_id, {
    authMethod: current.auth_method,
    userAgent: current.user_agent,
    authenticatedAt: opts.reauthenticated ? svc.now() : current.authenticated_at,
  });
  await revokeSession(svc, current.id, reason);
  return issued;
}

export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  const svc = c.get('services');
  setCookie(c, sessionCookieName(svc), token, {
    httpOnly: true,
    secure: svc.config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_ABSOLUTE_TTL / 1000),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  const svc = c.get('services');
  deleteCookie(c, sessionCookieName(svc), { path: '/', secure: svc.config.cookieSecure });
}

export function readSessionCookie(c: Context<AppEnv>): string | undefined {
  return getCookie(c, sessionCookieName(c.get('services')));
}
