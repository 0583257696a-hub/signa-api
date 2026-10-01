export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Provider-level idempotency key (sent as a header where supported). */
  idempotencyKey: string;
}

export interface EmailSendResult {
  providerMessageRef: string | null;
}

/** Email provider abstraction. Real providers (SES, Postmark, Resend…) implement this. */
export interface EmailProvider {
  readonly name: string;
  /** False when delivery is disabled; callers then record the delivery as suppressed. */
  readonly enabled: boolean;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/** Default: delivery disabled until a provider is explicitly configured. */
export class DisabledEmailProvider implements EmailProvider {
  readonly name = 'disabled';
  readonly enabled = false;
  async send(): Promise<EmailSendResult> {
    return { providerMessageRef: null };
  }
}

/**
 * Development adapter: keeps messages in memory and NEVER contacts a network
 * service. Tests and local tooling can inspect `outbox`. Forbidden in production
 * by configuration validation.
 */
export class DevEmailProvider implements EmailProvider {
  readonly name = 'dev';
  readonly enabled = true;
  readonly outbox: EmailMessage[] = [];
  private readonly max = 100;
  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.outbox.push(message);
    if (this.outbox.length > this.max) this.outbox.shift();
    return { providerMessageRef: `dev_${this.outbox.length}` };
  }
}
