import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context';
import { hmacHex } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { body, ok } from '../../lib/http';
import { MINUTE } from '../../lib/time';
import { requireAuth } from '../../middleware';
import { requireFlag } from '../flags/service';
import { enforce } from '../ratelimit/service';
import { idempotencyKeyFrom, orgContext } from '../sign/routes';
import { resolveBillingContext } from '../usage/entitlements';
import { commitUsage, releaseUsage, reserveUsage } from '../usage/service';
import { normalizeInput } from './engine';

const TranslateSchema = z.object({
  text: z.string().max(10_000),
  mode: z.enum(['emoji_only', 'text_and_emoji']).default('text_and_emoji'),
  style: z.enum(['minimal', 'standard', 'expressive']).default('standard'),
  language: z.enum(['he', 'en', 'auto']).default('auto'),
  /** "Regenerate" support: picks deterministic alternatives. */
  variant: z.number().int().min(0).max(9).default(0),
});

export const emojiRoutes = new Hono<AppEnv>();
emojiRoutes.use('*', requireAuth);

/**
 * Billing policy: a request counts as one emoji usage event when the engine
 * produced at least one emoji. Validation errors, rejected requests, engine
 * failures and "no emoji matched" results are not counted.
 */
emojiRoutes.post('/translate', async (c) => {
  const svc = c.get('services');
  const user = c.get('auth')!.user;
  await requireFlag(svc, 'emoji_translation');
  const input = await body(c, TranslateSchema);
  const idempotencyKey = idempotencyKeyFrom(c.req.header('idempotency-key'));
  const ctx = await resolveBillingContext(svc, user.id, orgContext(c));
  if (!ctx.entitlements['emoji.styles'].includes(input.style)) {
    throw new AppError('entitlement_required', { details: { feature: `emoji.style.${input.style}` } });
  }
  await enforce(svc, 'translate_user', user.id, ctx.entitlements['rate.requests_per_minute'], MINUTE);

  const text = normalizeInput(input.text);
  if (!text) throw new AppError('empty_input');
  const max = ctx.entitlements['emoji.max_input_chars'];
  if (text.length > max) throw new AppError('input_too_long', { details: { maxChars: max, length: text.length } });

  const fingerprint = idempotencyKey
    ? await hmacHex(svc.config.APP_SECRET, `emoji|${user.id}|${input.mode}|${input.style}|${input.language}|${input.variant}|${text}`)
    : undefined;
  const reservation = await reserveUsage(svc, ctx, { feature: 'emoji', userId: user.id, requestId: c.get('requestId'), idempotencyKey, fingerprint });

  let out;
  try {
    out = await svc.emojiEngine.translate({ text, mode: input.mode, style: input.style, language: input.language, variant: input.variant });
  } catch {
    if (!reservation.replay) await releaseUsage(svc, reservation.eventId, 'engine_error');
    throw new AppError('provider_error');
  }

  let usageCounted = false;
  if (!reservation.replay) {
    if (out.emojis.length === 0) await releaseUsage(svc, reservation.eventId, 'no_match');
    else {
      await commitUsage(svc, reservation.eventId);
      usageCounted = true;
    }
  }

  return ok(
    c,
    {
      result: out.result,
      mode: input.mode,
      style: input.style,
      language: out.language,
      direction: out.language === 'he' ? 'rtl' : 'ltr',
      alternatives: { textAndEmoji: out.textWithEmoji, emojiOnly: out.emojiOnly },
      emojis: out.emojis,
      variant: input.variant,
    },
    {
      provider: svc.emojiEngine.name,
      engineVersion: svc.emojiEngine.version,
      method: 'deterministic_rules',
      usageCounted,
      idempotentReplay: reservation.replay,
      matchedConcepts: out.matchedConcepts,
      coverage: out.coverage,
      noMatch: out.emojis.length === 0,
    },
  );
});
