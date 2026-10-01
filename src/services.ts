import type { Services } from './context';
import { loadConfig, type Bindings } from './env';
import { createLogger } from './lib/logger';
import { DevPaymentProvider, NoPaymentProvider } from './modules/billing/provider';
import { R2AssetStore } from './modules/dictionary/asset-store';
import { DevEmailProvider, DisabledEmailProvider } from './modules/email/provider';
import { RuleBasedEmojiEngine } from './modules/emoji/engine';
import { createSignProvider } from './modules/sign/provider';
import { CloudflareJobQueue } from './modules/sign/queue';

const emojiEngine = new RuleBasedEmojiEngine();
let devEmail: DevEmailProvider | undefined;

/** Builds the dependency container from Worker bindings. Tests pass overrides. */
export function buildServices(env: Bindings, overrides: Partial<Services> = {}): Services {
  const config = overrides.config ?? loadConfig(env);
  const logger = overrides.logger ?? createLogger({ service: 'signa-api', env: config.APP_ENV }, undefined, config.LOG_LEVEL);
  const base = {
    db: overrides.db ?? env.DB,
    config,
    fetch: overrides.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
  };
  return {
    ...base,
    now: overrides.now ?? Date.now,
    logger,
    email: overrides.email ?? (config.EMAIL_PROVIDER === 'dev' ? (devEmail ??= new DevEmailProvider()) : new DisabledEmailProvider()),
    payment:
      overrides.payment ??
      (config.PAYMENT_PROVIDER === 'dev' ? new DevPaymentProvider(config.DEV_PAYMENT_WEBHOOK_SECRET!, config.APP_BASE_URL) : new NoPaymentProvider()),
    signProvider: overrides.signProvider ?? createSignProvider(base),
    emojiEngine: overrides.emojiEngine ?? emojiEngine,
    jobQueue: overrides.jobQueue !== undefined ? overrides.jobQueue : env.SIGN_JOBS_QUEUE ? new CloudflareJobQueue(env.SIGN_JOBS_QUEUE) : null,
    assetStore: overrides.assetStore !== undefined ? overrides.assetStore : env.ASSETS_BUCKET ? new R2AssetStore(env.ASSETS_BUCKET) : null,
  };
}
