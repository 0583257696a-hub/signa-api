import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context';
import { AppError } from '../../lib/errors';
import { body, ok } from '../../lib/http';
import { HOUR, MINUTE } from '../../lib/time';
import { clientIp, rateLimitByIp, requireAuth } from '../../middleware';
import { audit } from '../audit/service';
import { enforce } from '../ratelimit/service';
import { normalizeEmail, toSelfView } from '../users/model';
import { completeGoogleAuth, startGoogleAuth } from './oauth-google';
import {
  checkPassword,
  issueEmailVerification,
  login,
  notifySecurityEvent,
  register,
  requestPasswordReset,
  resetPassword,
  setPassword,
  verifyEmail,
} from './service';
import {
  clearSessionCookie,
  createSession,
  csrfTokenFor,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  setSessionCookie,
} from './session';

export const PasswordSchema = z.string().min(10).max(128);
const EmailSchema = z.email().max(254);
const TokenSchema = z.string().min(20).max(100);

const GENERIC_ACCEPTED = { status: 'accepted' } as const;

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/register', rateLimitByIp('auth_register_ip', 10, HOUR), async (c) => {
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(100),
      email: EmailSchema,
      password: PasswordSchema,
      locale: z.enum(['he', 'en']).default('he'),
      timeZone: z.string().max(64).optional(),
    }),
  );
  if (normalizeEmail(input.email) === input.password.toLowerCase()) {
    throw new AppError('validation_error', { details: { issues: [{ path: 'password', code: 'too_weak' }] } });
  }
  await register(c.get('services'), input, c.get('requestId'));
  // Identical response whether or not the email already exists (no enumeration).
  return ok(c, { ...GENERIC_ACCEPTED, next: 'verify_email_then_login' }, {}, 202);
});

authRoutes.post('/login', rateLimitByIp('auth_login_ip', 20, MINUTE), async (c) => {
  const svc = c.get('services');
  const input = await body(c, z.object({ email: EmailSchema, password: z.string().min(1).max(128) }));
  await enforce(svc, 'auth_login_email', normalizeEmail(input.email), 10, 15 * MINUTE);
  const user = await login(svc, input.email, input.password, c.get('requestId'));
  // Session fixation defence: any pre-existing session on this browser is revoked.
  const previous = c.get('auth');
  if (previous) await revokeSession(svc, previous.session.id, 'replaced_by_login');
  const issued = await createSession(svc, user.id, { authMethod: 'password', userAgent: c.req.header('user-agent') });
  setSessionCookie(c, issued.token);
  return ok(c, { user: toSelfView(user), csrfToken: issued.csrfToken });
});

authRoutes.post('/logout', async (c) => {
  const auth = c.get('auth');
  if (auth) await revokeSession(c.get('services'), auth.session.id, 'logout');
  clearSessionCookie(c);
  return ok(c, { status: 'signed_out' });
});

/** Session renewal: issues a fresh token + CSRF secret and revokes the old session. */
authRoutes.post('/refresh', requireAuth, async (c) => {
  const auth = c.get('auth')!;
  const issued = await rotateSession(c.get('services'), auth.session, 'rotated');
  setSessionCookie(c, issued.token);
  return ok(c, { csrfToken: issued.csrfToken, expiresAt: new Date(issued.session.expires_at).toISOString() });
});

authRoutes.get('/session', requireAuth, async (c) => {
  const auth = c.get('auth')!;
  return ok(c, {
    user: toSelfView(auth.user),
    csrfToken: await csrfTokenFor(c.get('services'), auth.session.id),
    expiresAt: new Date(auth.session.expires_at).toISOString(),
  });
});

authRoutes.get('/csrf', requireAuth, async (c) => {
  return ok(c, { csrfToken: await csrfTokenFor(c.get('services'), c.get('auth')!.session.id) });
});

/** Step-up authentication for high-risk operations. Rotates the session. */
authRoutes.post('/reauthenticate', requireAuth, rateLimitByIp('auth_reauth_ip', 10, MINUTE), async (c) => {
  const svc = c.get('services');
  const auth = c.get('auth')!;
  const { password } = await body(c, z.object({ password: z.string().min(1).max(128) }));
  if (!(await checkPassword(svc, auth.user.id, password))) {
    await audit(svc, { action: 'auth.reauthenticate', outcome: 'failure', actorUserId: auth.user.id, requestId: c.get('requestId') });
    throw new AppError('invalid_credentials');
  }
  const issued = await rotateSession(svc, auth.session, 'reauthenticated', { reauthenticated: true });
  setSessionCookie(c, issued.token);
  return ok(c, { csrfToken: issued.csrfToken });
});

authRoutes.post('/password/forgot', rateLimitByIp('auth_forgot_ip', 10, HOUR), async (c) => {
  const svc = c.get('services');
  const { email } = await body(c, z.object({ email: EmailSchema }));
  const limited = await enforce(svc, 'auth_forgot_email', normalizeEmail(email), 3, HOUR).then(
    () => false,
    () => true,
  );
  // Rate-limited or not, existing or not: the response is identical.
  if (!limited) await requestPasswordReset(svc, email, c.get('requestId'));
  return ok(c, GENERIC_ACCEPTED, {}, 202);
});

authRoutes.post('/password/reset', rateLimitByIp('auth_reset_ip', 20, HOUR), async (c) => {
  const input = await body(c, z.object({ token: TokenSchema, password: PasswordSchema }));
  await resetPassword(c.get('services'), input.token, input.password, c.get('requestId'));
  clearSessionCookie(c);
  return ok(c, { status: 'password_reset', next: 'login' });
});

authRoutes.post('/password/change', requireAuth, rateLimitByIp('auth_change_ip', 10, MINUTE), async (c) => {
  const svc = c.get('services');
  const auth = c.get('auth')!;
  const input = await body(c, z.object({ currentPassword: z.string().min(1).max(128), newPassword: PasswordSchema }));
  if (!(await checkPassword(svc, auth.user.id, input.currentPassword))) throw new AppError('invalid_credentials');
  await setPassword(svc, auth.user.id, input.newPassword);
  await revokeAllSessions(svc, auth.user.id, 'password_changed', auth.session.id);
  const issued = await rotateSession(svc, auth.session, 'password_changed', { reauthenticated: true });
  setSessionCookie(c, issued.token);
  await audit(svc, { action: 'auth.password_changed', actorUserId: auth.user.id, requestId: c.get('requestId') });
  await notifySecurityEvent(svc, auth.user.id, 'password_changed');
  return ok(c, { status: 'password_changed', csrfToken: issued.csrfToken });
});

authRoutes.post('/email/verify', rateLimitByIp('auth_verify_ip', 30, HOUR), async (c) => {
  const { token } = await body(c, z.object({ token: TokenSchema }));
  await verifyEmail(c.get('services'), token, c.get('requestId'));
  return ok(c, { status: 'email_verified' });
});

authRoutes.post('/email/verify/resend', requireAuth, async (c) => {
  const svc = c.get('services');
  const user = c.get('auth')!.user;
  await enforce(svc, 'auth_verify_resend', user.id, 3, HOUR);
  if (user.email_verified_at === null) await issueEmailVerification(svc, user);
  return ok(c, GENERIC_ACCEPTED, {}, 202);
});

// --- Optional Google OAuth -------------------------------------------------
authRoutes.get('/oauth/google/start', rateLimitByIp('auth_oauth_ip', 30, MINUTE), async (c) => {
  const url = await startGoogleAuth(c.get('services'), c.req.query('redirect') ?? '/');
  return c.redirect(url, 302);
});

authRoutes.get('/oauth/google/callback', rateLimitByIp('auth_oauth_ip', 30, MINUTE), async (c) => {
  const svc = c.get('services');
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state || code.length > 2048 || state.length > 100) throw new AppError('invalid_token');
  const { user, redirectPath } = await completeGoogleAuth(svc, code, state);
  const previous = c.get('auth');
  if (previous) await revokeSession(svc, previous.session.id, 'replaced_by_login');
  const issued = await createSession(svc, user.id, { authMethod: 'google', userAgent: c.req.header('user-agent') });
  setSessionCookie(c, issued.token);
  await audit(svc, { action: 'auth.login', actorUserId: user.id, requestId: c.get('requestId'), metadata: { method: 'google', ipBucket: clientIp(c) === 'unknown' ? 'unknown' : 'known' } });
  return c.redirect(`${svc.config.APP_BASE_URL}${redirectPath}`, 302);
});
