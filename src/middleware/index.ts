import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../context';
import { newId } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { localeFromHeader } from '../lib/i18n';
import { findSessionByToken, readSessionCookie, verifyCsrf } from '../modules/auth/session';
import type { PlatformRole } from '../modules/users/model';
import { enforce } from '../modules/ratelimit/service';
import { MINUTE } from '../lib/time';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * Pre-authentication endpoints: a stale cookie must not lock users out of signing in,
 * so the synchronizer token is not required here — the Origin check still applies.
 * Payment webhooks are server-to-server and authenticated by signature instead.
 */
const CSRF_TOKEN_EXEMPT = /^\/api\/v1\/(auth\/(login|register|logout|password\/forgot|password\/reset|email\/verify)|billing\/webhooks\/[a-z]+)$/;

/** Assigns a server-generated request ID, resolves locale and emits an access log line. */
export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = newId('req', 16);
  c.set('requestId', requestId);
  c.set('locale', localeFromHeader(c.req.header('accept-language')));
  c.set('auth', null);
  const started = Date.now();
  await next();
  c.header('X-Request-Id', requestId);
  const svc = c.get('services');
  const status = c.res.status;
  svc.logger.log(status >= 500 ? 'error' : 'info', 'http_request', {
    requestId,
    method: c.req.method,
    route: c.req.routePath, // route template, never the concrete URL (which may hold IDs/tokens)
    status,
    durationMs: Date.now() - started,
    errorCode: c.res.headers.get('X-Error-Code') ?? undefined,
    authenticated: c.get('auth') !== null,
  });
};

/** Baseline security headers for a JSON API. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  const svc = c.get('services');
  if (svc.config.isProduction) {
    const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
    if (proto !== 'https') throw new AppError('forbidden', { details: { reason: 'https_required' } });
  }
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  c.header('Cross-Origin-Resource-Policy', 'same-site');
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  if (svc.config.cookieSecure) c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
};

/** Resolves the session cookie (if any). Does not reject anonymous requests. */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = readSessionCookie(c);
  if (token) {
    const auth = await findSessionByToken(c.get('services'), token);
    if (auth) {
      c.set('auth', auth);
      c.set('locale', auth.user.locale);
    }
  }
  await next();
};

/**
 * CSRF protection for cookie-authenticated, state-changing requests:
 *   1. Origin (or Referer) must be an allowed origin.
 *   2. X-CSRF-Token must match the per-session secret (synchronizer token).
 */
export const csrfProtection: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get('auth');
  if (UNSAFE.has(c.req.method)) {
    const svc = c.get('services');
    const exempt = CSRF_TOKEN_EXEMPT.test(c.req.path);
    if (!exempt || !c.req.path.includes('/webhooks/')) {
      const origin = c.req.header('origin') ?? refererOrigin(c.req.header('referer'));
      const allowed = new Set([svc.config.APP_BASE_URL, svc.config.API_BASE_URL, ...svc.config.CORS_ALLOWED_ORIGINS].map(stripSlash));
      if (origin && !allowed.has(stripSlash(origin))) throw new AppError('csrf_failed');
    }
    if (auth && !exempt && !(await verifyCsrf(svc, auth.session, c.req.header('x-csrf-token')))) {
      throw new AppError('csrf_failed');
    }
  }
  await next();
};

const stripSlash = (s: string) => s.replace(/\/+$/, '');
function refererOrigin(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  try {
    return new URL(ref).origin;
  } catch {
    return undefined;
  }
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('auth')) throw new AppError('unauthenticated');
  await next();
};

const ROLE_RANK: Record<PlatformRole, number> = { user: 0, support: 1, admin: 2, superadmin: 3 };

/** Platform (staff) roles are independent from organization roles. */
export function requirePlatformRole(min: Exclude<PlatformRole, 'user'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) throw new AppError('unauthenticated');
    if (ROLE_RANK[auth.user.platform_role] < ROLE_RANK[min]) throw new AppError('forbidden');
    await next();
  };
}

export const hasPlatformRole = (role: PlatformRole, min: PlatformRole) => ROLE_RANK[role] >= ROLE_RANK[min];

/** Step-up authentication: the session must have proven credentials recently. */
export const RECENT_AUTH_WINDOW = 15 * MINUTE;
export function requireRecentAuth(svcNow: number, authenticatedAt: number): void {
  if (svcNow - authenticatedAt > RECENT_AUTH_WINDOW) throw new AppError('reauthentication_required');
}

export function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? 'unknown';
}

/** Per-IP rate limit middleware. */
export function rateLimitByIp(bucket: string, limit: number, windowMs = MINUTE): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await enforce(c.get('services'), bucket, clientIp(c), limit, windowMs);
    await next();
  };
}
