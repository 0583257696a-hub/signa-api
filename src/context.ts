import type { AppConfig, Bindings } from './env';
import type { Locale } from './lib/i18n';
import type { Logger } from './lib/logger';
import type { EmailProvider } from './modules/email/provider';
import type { PaymentProvider } from './modules/billing/provider';
import type { SignTranslationProvider } from './modules/sign/provider';
import type { EmojiEngine } from './modules/emoji/engine';
import type { JobQueue } from './modules/sign/queue';
import type { AssetStore } from './modules/dictionary/asset-store';
import type { AuthContext } from './modules/auth/session';

/** Dependency container. Everything external is injected so tests can substitute fakes. */
export interface Services {
  db: D1Database;
  config: AppConfig;
  now: () => number;
  logger: Logger;
  email: EmailProvider;
  payment: PaymentProvider;
  signProvider: SignTranslationProvider;
  emojiEngine: EmojiEngine;
  jobQueue: JobQueue | null;
  assetStore: AssetStore | null;
  fetch: typeof fetch;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    services: Services;
    requestId: string;
    locale: Locale;
    auth: AuthContext | null;
  };
};
