import { z } from 'zod';
import { hmacHex, randomToken, timingSafeEqual } from '../../lib/crypto';
import { AppError } from '../../lib/errors';

export type ProviderSubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';

export interface CheckoutRequest {
  checkoutId: string;
  planId: string;
  subject: { type: 'user' | 'organization'; id: string };
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  trialDays: number;
}

export interface CheckoutSession {
  providerSessionRef: string;
  url: string;
  expiresAt: number;
}

export interface ProviderSubscription {
  providerSubscriptionRef: string;
  status: ProviderSubscriptionStatus;
  planId: string | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: number | null;
}

export type WebhookEventType =
  | 'checkout.completed'
  | 'subscription.updated'
  | 'subscription.cancelled'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'unknown';

/** Provider-neutral webhook event. Contains references and states only — never card data. */
export interface NormalizedWebhookEvent {
  eventId: string;
  type: WebhookEventType;
  checkoutRef?: string;
  subscriptionRef?: string;
  customerRef?: string;
  status?: ProviderSubscriptionStatus;
  planId?: string;
  periodStart?: number;
  periodEnd?: number;
  trialEndsAt?: number | null;
  cancelAtPeriodEnd?: boolean;
}

/**
 * Payment provider abstraction. No provider has been selected yet; a real
 * implementation (e.g. Stripe, Paddle, an Israeli PSP) implements this interface.
 * Subscriptions become paid ONLY through verified webhooks, never because the
 * frontend reports a successful checkout.
 */
export interface PaymentProvider {
  readonly name: string;
  readonly configured: boolean;
  createCheckoutSession(req: CheckoutRequest): Promise<CheckoutSession>;
  getSubscription(providerSubscriptionRef: string): Promise<ProviderSubscription | null>;
  cancelSubscription(providerSubscriptionRef: string, opts: { atPeriodEnd: boolean }): Promise<void>;
  /** Verifies the signature and normalizes the event. Throws `invalid_signature`. */
  parseWebhook(headers: Headers, rawBody: string, now: number): Promise<NormalizedWebhookEvent>;
}

export class NoPaymentProvider implements PaymentProvider {
  readonly name = 'none';
  readonly configured = false;
  async createCheckoutSession(): Promise<CheckoutSession> {
    throw new AppError('provider_not_configured');
  }
  async getSubscription(): Promise<ProviderSubscription | null> {
    return null;
  }
  async cancelSubscription(): Promise<void> {
    throw new AppError('provider_not_configured');
  }
  async parseWebhook(): Promise<NormalizedWebhookEvent> {
    throw new AppError('provider_not_configured');
  }
}

const DevEventSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['checkout.completed', 'subscription.updated', 'subscription.cancelled', 'payment.succeeded', 'payment.failed']).or(z.string().max(100)),
  checkoutRef: z.string().max(100).optional(),
  subscriptionRef: z.string().max(100).optional(),
  customerRef: z.string().max(100).optional(),
  status: z.enum(['trialing', 'active', 'past_due', 'cancelled', 'expired']).optional(),
  planId: z.string().max(40).optional(),
  periodStart: z.number().int().optional(),
  periodEnd: z.number().int().optional(),
  trialEndsAt: z.number().int().nullable().optional(),
  cancelAtPeriodEnd: z.boolean().optional(),
});

export const DEV_SIGNATURE_HEADER = 'x-signa-dev-signature';
const TOLERANCE_MS = 5 * 60_000;

/**
 * Development adapter. Never moves money. Checkout URLs point at a local dev page;
 * webhooks must be signed with DEV_PAYMENT_WEBHOOK_SECRET:
 *   x-signa-dev-signature: t=<ms timestamp>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
 * Forbidden in production by configuration validation.
 */
export class DevPaymentProvider implements PaymentProvider {
  readonly name = 'dev';
  readonly configured = true;
  constructor(
    private readonly webhookSecret: string,
    private readonly appBaseUrl: string,
  ) {}

  async createCheckoutSession(req: CheckoutRequest): Promise<CheckoutSession> {
    const ref = `dev_cs_${randomToken(12)}`;
    return { providerSessionRef: ref, url: `${this.appBaseUrl}/dev/checkout?session=${ref}&plan=${req.planId}`, expiresAt: Date.now() + 60 * 60_000 };
  }

  async getSubscription(): Promise<ProviderSubscription | null> {
    return null; // the dev provider keeps no state; webhooks are the source of truth
  }

  async cancelSubscription(): Promise<void> {
    // No remote state to change in development.
  }

  async parseWebhook(headers: Headers, rawBody: string, now: number): Promise<NormalizedWebhookEvent> {
    const header = headers.get(DEV_SIGNATURE_HEADER) ?? '';
    const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
    const t = Number(parts.t);
    if (!parts.v1 || !Number.isFinite(t) || Math.abs(now - t) > TOLERANCE_MS) throw new AppError('invalid_signature');
    const expected = await signDevWebhook(this.webhookSecret, t, rawBody);
    if (!timingSafeEqual(parts.v1, expected)) throw new AppError('invalid_signature');
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new AppError('bad_request');
    }
    const parsed = DevEventSchema.safeParse(json);
    if (!parsed.success) throw new AppError('bad_request');
    const e = parsed.data;
    const known = ['checkout.completed', 'subscription.updated', 'subscription.cancelled', 'payment.succeeded', 'payment.failed'];
    return {
      eventId: e.id,
      type: (known.includes(e.type) ? e.type : 'unknown') as WebhookEventType,
      ...(e.checkoutRef ? { checkoutRef: e.checkoutRef } : {}),
      ...(e.subscriptionRef ? { subscriptionRef: e.subscriptionRef } : {}),
      ...(e.customerRef ? { customerRef: e.customerRef } : {}),
      ...(e.status ? { status: e.status } : {}),
      ...(e.planId ? { planId: e.planId } : {}),
      ...(e.periodStart !== undefined ? { periodStart: e.periodStart } : {}),
      ...(e.periodEnd !== undefined ? { periodEnd: e.periodEnd } : {}),
      ...(e.trialEndsAt !== undefined ? { trialEndsAt: e.trialEndsAt } : {}),
      ...(e.cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd: e.cancelAtPeriodEnd } : {}),
    };
  }
}

export const signDevWebhook = (secret: string, t: number, rawBody: string) => hmacHex(secret, `${t}.${rawBody}`);
