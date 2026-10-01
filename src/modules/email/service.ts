import type { Services } from '../../context';
import { hmacHex, newId } from '../../lib/crypto';
import { first, run } from '../../lib/db';
import type { Locale } from '../../lib/i18n';
import { renderTemplate, type TemplateId, type TemplateVars } from './templates';

const MAX_ATTEMPTS = 3;

/**
 * Sends a templated email with idempotency and bounded retries, recording only
 * delivery metadata (template, locale, keyed recipient hash, status).
 */
export async function sendTemplatedEmail(
  svc: Services,
  args: { to: string; template: TemplateId; locale: Locale; vars: TemplateVars; idempotencyKey: string },
): Promise<'sent' | 'suppressed' | 'failed' | 'duplicate'> {
  const now = svc.now();
  const recipientHash = (await hmacHex(svc.config.APP_SECRET, `email|${args.to.toLowerCase()}`)).slice(0, 40);
  const existing = await first<{ status: string }>(svc.db, 'SELECT status FROM email_deliveries WHERE idempotency_key = ?', args.idempotencyKey);
  if (existing && existing.status !== 'failed') return 'duplicate';

  const id = newId('eml');
  if (!existing) {
    await run(
      svc.db,
      `INSERT INTO email_deliveries (id, idempotency_key, template, locale, recipient_hash, provider, status, attempts, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,0,?,?) ON CONFLICT (idempotency_key) DO NOTHING`,
      id, args.idempotencyKey, args.template, args.locale, recipientHash, svc.email.name, 'pending', now, now,
    );
  }

  if (!svc.email.enabled) {
    await run(svc.db, `UPDATE email_deliveries SET status = 'suppressed', updated_at = ? WHERE idempotency_key = ?`, now, args.idempotencyKey);
    svc.logger.log('info', 'email_suppressed', { template: args.template, reason: 'provider_disabled' });
    return 'suppressed';
  }

  const rendered = renderTemplate(args.template, args.locale, args.vars);
  let lastError = 'unknown';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await svc.email.send({ to: args.to, ...rendered, idempotencyKey: args.idempotencyKey });
      await run(
        svc.db,
        `UPDATE email_deliveries SET status = 'sent', attempts = attempts + 1, provider_message_ref = ?, updated_at = ?
          WHERE idempotency_key = ?`,
        res.providerMessageRef, svc.now(), args.idempotencyKey,
      );
      return 'sent';
    } catch (e) {
      lastError = e instanceof Error ? e.name : 'error';
      await run(svc.db, 'UPDATE email_deliveries SET attempts = attempts + 1, updated_at = ? WHERE idempotency_key = ?', svc.now(), args.idempotencyKey);
    }
  }
  await run(
    svc.db,
    `UPDATE email_deliveries SET status = 'failed', last_error_code = ?, updated_at = ? WHERE idempotency_key = ?`,
    lastError.slice(0, 60), svc.now(), args.idempotencyKey,
  );
  svc.logger.log('warn', 'email_failed', { template: args.template, errorCode: lastError });
  return 'failed';
}
