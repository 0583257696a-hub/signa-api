import type { Services } from '../../context';
import { getDummyPasswordHash, hashPassword, needsRehash, newId, randomToken, sha256Hex, verifyPassword } from '../../lib/crypto';
import { batch, first, isUniqueViolation, run, stmt } from '../../lib/db';
import { AppError } from '../../lib/errors';
import type { Locale } from '../../lib/i18n';
import { DAY, HOUR } from '../../lib/time';
import { audit } from '../audit/service';
import { sendTemplatedEmail } from '../email/service';
import { isFlagEnabled } from '../flags/service';
import { normalizeEmail, type UserRow } from '../users/model';
import { revokeAllSessions } from './session';

export const EMAIL_VERIFICATION_TTL = DAY;
export const PASSWORD_RESET_TTL = HOUR;

/**
 * Credential verification abstraction. The password implementation lives here;
 * a managed identity provider can implement the same contract later.
 */
export interface CredentialVerifier {
  verify(email: string, password: string): Promise<UserRow | null>;
}

export async function findUserByEmail(svc: Services, email: string): Promise<UserRow | null> {
  return first<UserRow>(svc.db, 'SELECT * FROM users WHERE email_normalized = ?', normalizeEmail(email));
}

export async function register(
  svc: Services,
  input: { name: string; email: string; password: string; locale: Locale; timeZone?: string },
  requestId: string,
): Promise<void> {
  if (!(await isFlagEnabled(svc, 'registration_open'))) throw new AppError('registration_closed');
  const now = svc.now();
  const emailNorm = normalizeEmail(input.email);
  const existing = await findUserByEmail(svc, emailNorm);
  const passwordHash = await hashPassword(input.password); // always hash: equalizes timing
  if (existing) {
    // Do not reveal that the account exists. Notify the real owner instead.
    if (existing.status !== 'deleted') {
      await sendTemplatedEmail(svc, {
        to: existing.email,
        template: 'security_notice',
        locale: existing.locale,
        vars: { event: existing.locale === 'he' ? 'ניסיון הרשמה עם כתובת האימייל שלך' : 'a sign-up attempt with your email address' },
        idempotencyKey: `register-attempt:${existing.id}:${Math.floor(now / HOUR)}`,
      });
    }
    return;
  }
  const userId = newId('usr');
  try {
    await batch(svc.db, [
      stmt(
        svc.db,
        `INSERT INTO users (id, email, email_normalized, name, status, platform_role, locale, time_zone, created_at, updated_at)
         VALUES (?,?,?,?, 'active', 'user', ?, ?, ?, ?)`,
        userId, input.email.trim(), emailNorm, input.name.trim(), input.locale, input.timeZone ?? 'Asia/Jerusalem', now, now,
      ),
      stmt(svc.db, 'INSERT INTO user_credentials (user_id, password_hash, password_updated_at) VALUES (?,?,?)', userId, passwordHash, now),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) return; // concurrent registration with same email — same generic outcome
    throw e;
  }
  await audit(svc, { action: 'auth.register', actorUserId: userId, targetType: 'user', targetId: userId, requestId });
  await issueEmailVerification(svc, { id: userId, email: input.email.trim(), name: input.name.trim(), locale: input.locale });
}

export async function issueEmailVerification(
  svc: Services,
  user: Pick<UserRow, 'id' | 'email' | 'name' | 'locale'>,
): Promise<void> {
  const token = await createOneTimeToken(svc, user.id, 'email_verification', EMAIL_VERIFICATION_TTL);
  await sendTemplatedEmail(svc, {
    to: user.email,
    template: 'email_verification',
    locale: user.locale,
    vars: { name: user.name, link: `${svc.config.APP_BASE_URL}/verify-email#token=${token}` },
    idempotencyKey: `verify:${await sha256Hex(token)}`,
  });
}

async function createOneTimeToken(
  svc: Services,
  userId: string,
  purpose: 'email_verification' | 'password_reset',
  ttl: number,
): Promise<string> {
  const now = svc.now();
  const token = randomToken();
  // Only one live token per purpose: older ones are invalidated.
  await batch(svc.db, [
    stmt(svc.db, 'UPDATE one_time_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL', now, userId, purpose),
    stmt(
      svc.db,
      'INSERT INTO one_time_tokens (id, user_id, purpose, token_hash, created_at, expires_at) VALUES (?,?,?,?,?,?)',
      newId('ott'), userId, purpose, await sha256Hex(token), now, now + ttl,
    ),
  ]);
  return token;
}

/** Atomically consumes a one-time token. Returns the user ID or throws invalid_token. */
async function consumeOneTimeToken(svc: Services, token: string, purpose: 'email_verification' | 'password_reset'): Promise<string> {
  if (!token || token.length > 100) throw new AppError('invalid_token');
  const now = svc.now();
  const row = await first<{ user_id: string }>(
    svc.db,
    `UPDATE one_time_tokens SET used_at = ?
      WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
      RETURNING user_id`,
    now, await sha256Hex(token), purpose, now,
  );
  if (!row) throw new AppError('invalid_token');
  return row.user_id;
}

export async function verifyEmail(svc: Services, token: string, requestId: string): Promise<void> {
  const userId = await consumeOneTimeToken(svc, token, 'email_verification');
  const now = svc.now();
  await run(svc.db, 'UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?', now, now, userId);
  await audit(svc, { action: 'auth.email_verified', actorUserId: userId, targetType: 'user', targetId: userId, requestId });
}

export const passwordVerifier = (svc: Services): CredentialVerifier => ({
  async verify(email, password) {
    const user = await findUserByEmail(svc, email);
    const cred = user
      ? await first<{ password_hash: string }>(svc.db, 'SELECT password_hash FROM user_credentials WHERE user_id = ?', user.id)
      : null;
    // Always run a full hash comparison so response time does not reveal account existence.
    const hash = cred?.password_hash ?? (await getDummyPasswordHash());
    const okPw = await verifyPassword(password, hash);
    if (!user || !cred || !okPw || user.status === 'deleted') return null;
    if (needsRehash(cred.password_hash)) {
      await run(svc.db, 'UPDATE user_credentials SET password_hash = ? WHERE user_id = ?', await hashPassword(password), user.id);
    }
    return user;
  },
});

/** Password login. Returns the user if credentials are valid and the account may sign in. */
export async function login(svc: Services, email: string, password: string, requestId: string): Promise<UserRow> {
  const user = await passwordVerifier(svc).verify(email, password);
  if (!user) {
    await audit(svc, { action: 'auth.login', outcome: 'failure', requestId, metadata: { reason: 'invalid_credentials' } });
    throw new AppError('invalid_credentials');
  }
  if (user.status === 'suspended') {
    await audit(svc, { action: 'auth.login', outcome: 'denied', actorUserId: user.id, requestId, metadata: { reason: 'suspended' } });
    throw new AppError('account_inactive');
  }
  if (user.status === 'deactivated') {
    // Self-deactivated accounts are reactivated by signing in with valid credentials.
    const now = svc.now();
    await run(svc.db, `UPDATE users SET status = 'active', updated_at = ? WHERE id = ? AND status = 'deactivated'`, now, user.id);
    user.status = 'active';
    await audit(svc, { action: 'account.reactivated', actorUserId: user.id, targetType: 'user', targetId: user.id, requestId });
  }
  await audit(svc, { action: 'auth.login', actorUserId: user.id, requestId });
  return user;
}

export async function requestPasswordReset(svc: Services, email: string, requestId: string): Promise<void> {
  const user = await findUserByEmail(svc, email);
  if (!user || user.status === 'deleted' || user.status === 'suspended') {
    await getDummyPasswordHash(); // keep response time similar
    return;
  }
  const hasPassword = await first<{ user_id: string }>(svc.db, 'SELECT user_id FROM user_credentials WHERE user_id = ?', user.id);
  if (!hasPassword) return; // OAuth-only account; generic response still returned
  const token = await createOneTimeToken(svc, user.id, 'password_reset', PASSWORD_RESET_TTL);
  await sendTemplatedEmail(svc, {
    to: user.email,
    template: 'password_reset',
    locale: user.locale,
    vars: { name: user.name, link: `${svc.config.APP_BASE_URL}/reset-password#token=${token}` },
    idempotencyKey: `reset:${await sha256Hex(token)}`,
  });
  await audit(svc, { action: 'auth.password_reset_requested', actorUserId: user.id, requestId });
}

export async function resetPassword(svc: Services, token: string, newPassword: string, requestId: string): Promise<void> {
  const userId = await consumeOneTimeToken(svc, token, 'password_reset');
  await setPassword(svc, userId, newPassword);
  // A password reset invalidates every existing session.
  await revokeAllSessions(svc, userId, 'password_reset');
  // Completing a reset via the emailed link also proves control of the address.
  const now = svc.now();
  await run(svc.db, 'UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?', now, now, userId);
  await audit(svc, { action: 'auth.password_reset', actorUserId: userId, targetType: 'user', targetId: userId, requestId });
  await notifySecurityEvent(svc, userId, 'password_reset');
}

export async function setPassword(svc: Services, userId: string, newPassword: string): Promise<void> {
  const now = svc.now();
  await run(
    svc.db,
    `INSERT INTO user_credentials (user_id, password_hash, password_updated_at) VALUES (?,?,?)
     ON CONFLICT (user_id) DO UPDATE SET password_hash = excluded.password_hash, password_updated_at = excluded.password_updated_at`,
    userId, await hashPassword(newPassword), now,
  );
}

export async function checkPassword(svc: Services, userId: string, password: string): Promise<boolean> {
  const cred = await first<{ password_hash: string }>(svc.db, 'SELECT password_hash FROM user_credentials WHERE user_id = ?', userId);
  return verifyPassword(password, cred?.password_hash ?? (await getDummyPasswordHash())).then((r) => r && !!cred);
}

export async function notifySecurityEvent(svc: Services, userId: string, event: string): Promise<void> {
  const user = await first<UserRow>(svc.db, 'SELECT * FROM users WHERE id = ?', userId);
  if (!user || user.status === 'deleted') return;
  const labels: Record<string, { en: string; he: string }> = {
    password_reset: { en: 'password reset', he: 'איפוס סיסמה' },
    password_changed: { en: 'password changed', he: 'שינוי סיסמה' },
    sessions_revoked: { en: 'all sessions signed out', he: 'ניתוק כל ההתחברויות' },
    account_deactivated: { en: 'account deactivated', he: 'השבתת החשבון' },
  };
  const label = labels[event]?.[user.locale] ?? event;
  await sendTemplatedEmail(svc, {
    to: user.email,
    template: 'security_notice',
    locale: user.locale,
    vars: { event: label },
    idempotencyKey: `security:${userId}:${event}:${svc.now()}`,
  });
}
