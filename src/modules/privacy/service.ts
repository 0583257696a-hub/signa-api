import type { Services } from '../../context';
import { all, batch, first, stmt } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { iso } from '../../lib/time';
import { audit } from '../audit/service';
import { sendTemplatedEmail } from '../email/service';
import { getLiveSubscription } from '../usage/entitlements';
import { toSelfView, type UserRow } from '../users/model';

/**
 * ACCOUNT DELETION WORKFLOW
 *  1. Verify identity (password, or a recent re-authentication for OAuth-only accounts).
 *  2. Refuse while the user is the only owner of an organization that has other
 *     members — ownership must be transferred (or the organization deleted) first.
 *  3. Cancel the personal subscription with the payment provider (no further charges).
 *  4. Delete personal data: credentials, sessions, one-time tokens, external identities,
 *     saved translations, translation jobs (+ any ephemeral inputs/results),
 *     memberships, waitlist entries, pending invitations to the user's address.
 *  5. Organizations where the user was the sole member are marked deleted.
 *  6. The user row is anonymized (no name/email) and kept as a tombstone so that
 *     pseudonymous billing/usage/audit records stay referentially consistent.
 *  7. A confirmation email is sent to the original address before anonymization,
 *     and an audit event is recorded (identifiers only).
 */
export async function deleteAccount(svc: Services, user: UserRow, requestId: string): Promise<void> {
  const blocking = await all<{ id: string; name: string }>(
    svc.db,
    `SELECT o.id, o.name FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id AND m.user_id = ?1 AND m.role = 'owner'
      WHERE o.status <> 'deleted'
        AND (SELECT COUNT(*) FROM organization_members WHERE organization_id = o.id AND role = 'owner') = 1
        AND (SELECT COUNT(*) FROM organization_members WHERE organization_id = o.id) > 1`,
    user.id,
  );
  if (blocking.length) {
    throw new AppError('conflict', { details: { reason: 'sole_owner_of_organizations', organizationIds: blocking.map((o) => o.id) } });
  }

  const sub = await getLiveSubscription(svc, 'user', user.id);
  if (sub?.provider_subscription_ref) {
    try {
      await svc.payment.cancelSubscription(sub.provider_subscription_ref, { atPeriodEnd: false });
    } catch {
      throw new AppError('provider_error', { details: { reason: 'subscription_cancellation_failed' } });
    }
  }

  await sendTemplatedEmail(svc, {
    to: user.email,
    template: 'security_notice',
    locale: user.locale,
    vars: { event: user.locale === 'he' ? 'החשבון נמחק' : 'account deleted' },
    idempotencyKey: `account-deleted:${user.id}`,
  });

  const now = svc.now();
  const soleOrgs = await all<{ id: string }>(
    svc.db,
    `SELECT organization_id AS id FROM organization_members m
      WHERE m.user_id = ? AND (SELECT COUNT(*) FROM organization_members WHERE organization_id = m.organization_id) = 1`,
    user.id,
  );
  const db = svc.db;
  await batch(db, [
    stmt(db, 'DELETE FROM sessions WHERE user_id = ?', user.id),
    stmt(db, 'DELETE FROM one_time_tokens WHERE user_id = ?', user.id),
    stmt(db, 'DELETE FROM auth_identities WHERE user_id = ?', user.id),
    stmt(db, 'DELETE FROM user_credentials WHERE user_id = ?', user.id),
    stmt(db, 'DELETE FROM saved_translations WHERE user_id = ?', user.id),
    stmt(db, 'DELETE FROM translation_jobs WHERE user_id = ?', user.id), // cascades inputs/results
    stmt(db, 'DELETE FROM plan_waitlist WHERE user_id = ?', user.id),
    stmt(db, 'DELETE FROM organization_invitations WHERE email_normalized = ? AND accepted_at IS NULL', user.email_normalized),
    ...soleOrgs.map((o) => stmt(db, `UPDATE organizations SET status = 'deleted', updated_at = ? WHERE id = ?`, now, o.id)),
    stmt(db, 'DELETE FROM organization_members WHERE user_id = ?', user.id),
    stmt(
      db,
      `UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, updated_at = ?
        WHERE subject_type = 'user' AND subject_id = ? AND status IN ('trialing','active','past_due','suspended')`,
      now, now, user.id,
    ),
    stmt(
      db,
      `UPDATE users SET email = ?, email_normalized = ?, name = '', status = 'deleted', platform_role = 'user',
         accessibility_json = '{}', preferences_json = '{}', history_enabled = 0, history_consent_at = NULL,
         history_consent_version = NULL, email_verified_at = NULL, deleted_at = ?, updated_at = ? WHERE id = ?`,
      `deleted+${user.id}@invalid`, `deleted+${user.id}@invalid`, now, now, user.id,
    ),
  ]);
  await audit(svc, { action: 'account.deleted', actorUserId: user.id, targetType: 'user', targetId: user.id, requestId });
}

/** Machine-readable export of the data Signa holds about the user (data portability). */
export async function exportAccount(svc: Services, user: UserRow) {
  const [memberships, subscriptions, usage, saved, sessions] = await Promise.all([
    all<{ organization_id: string; role: string; created_at: number; name: string }>(
      svc.db,
      `SELECT m.organization_id, m.role, m.created_at, o.name FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ?`,
      user.id,
    ),
    all<{ plan_id: string; status: string; created_at: number; current_period_end: number | null }>(
      svc.db,
      `SELECT plan_id, status, created_at, current_period_end FROM subscriptions WHERE subject_type = 'user' AND subject_id = ?`,
      user.id,
    ),
    all<{ feature: string; period: string; count: number }>(
      svc.db,
      `SELECT feature, period, count FROM usage_counters WHERE subject_type = 'user' AND subject_id = ? ORDER BY period`,
      user.id,
    ),
    all<{ id: string; kind: string; source_text: string; output_json: string; language: string; created_at: number }>(
      svc.db,
      'SELECT id, kind, source_text, output_json, language, created_at FROM saved_translations WHERE user_id = ? ORDER BY created_at',
      user.id,
    ),
    all<{ id: string; created_at: number; last_seen_at: number; auth_method: string }>(
      svc.db,
      'SELECT id, created_at, last_seen_at, auth_method FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
      user.id,
    ),
  ]);
  const consent = await first<{ history_consent_version: string | null }>(svc.db, 'SELECT history_consent_version FROM users WHERE id = ?', user.id);
  return {
    exportedAt: iso(svc.now()),
    profile: toSelfView(user),
    historyConsentVersion: consent?.history_consent_version ?? null,
    organizations: memberships.map((m) => ({ id: m.organization_id, name: m.name, role: m.role, joinedAt: iso(m.created_at) })),
    subscriptions: subscriptions.map((s) => ({ planId: s.plan_id, status: s.status, createdAt: iso(s.created_at), currentPeriodEnd: iso(s.current_period_end) })),
    usageCounters: usage,
    savedTranslations: saved.map((s) => ({ id: s.id, kind: s.kind, sourceText: s.source_text, output: JSON.parse(s.output_json), language: s.language, createdAt: iso(s.created_at) })),
    activeSessions: sessions.map((s) => ({ id: s.id, createdAt: iso(s.created_at), lastSeenAt: iso(s.last_seen_at), method: s.auth_method })),
    notStored: [
      'Translation source text and output (unless explicitly saved to history)',
      'Payment card details (held only by the payment provider)',
      'Plaintext passwords (only a salted hash is kept)',
    ],
  };
}
