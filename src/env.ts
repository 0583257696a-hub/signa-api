import { z } from 'zod';

/** Message placed on the sign-translation queue. Contains identifiers only — never text. */
export interface SignJobMessage {
  jobId: string;
  enqueuedAt: number;
}

/** Cloudflare bindings and vars (see wrangler.toml). */
export interface Bindings {
  DB: D1Database;
  ASSETS_BUCKET?: R2Bucket;
  SIGN_JOBS_QUEUE?: Queue<SignJobMessage>;

  APP_ENV?: string;
  APP_BASE_URL?: string;
  API_BASE_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  LOG_LEVEL?: string;

  /** Secret: HMAC key for identifier hashing, signed URLs and fingerprints (≥ 32 chars). */
  APP_SECRET?: string;

  EMAIL_PROVIDER?: string; // 'disabled' | 'dev'
  EMAIL_FROM?: string;

  PAYMENT_PROVIDER?: string; // 'none' | 'dev'
  DEV_PAYMENT_WEBHOOK_SECRET?: string;

  SIGN_PROVIDER?: string; // 'none' | 'dictionary_lookup' | 'http'
  SIGN_PROVIDER_URL?: string;
  SIGN_PROVIDER_API_KEY?: string;
  SIGN_PROVIDER_VALIDATED?: string; // 'true' only after linguistic validation of the engine

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  SIGN_SYNC_FALLBACK_MAX_CHARS?: string;
  SIGN_RESULT_TTL_SECONDS?: string;
}

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const ConfigSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    APP_BASE_URL: z.url().default('http://localhost:3000'),
    API_BASE_URL: z.url().default('http://localhost:8787'),
    CORS_ALLOWED_ORIGINS: csv,
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
    EMAIL_PROVIDER: z.enum(['disabled', 'dev']).default('disabled'),
    EMAIL_FROM: z.string().default('Signa <no-reply@localhost>'),
    PAYMENT_PROVIDER: z.enum(['none', 'dev']).default('none'),
    DEV_PAYMENT_WEBHOOK_SECRET: z.string().optional(),
    SIGN_PROVIDER: z.enum(['none', 'dictionary_lookup', 'http']).default('dictionary_lookup'),
    SIGN_PROVIDER_URL: z.url().optional(),
    SIGN_PROVIDER_API_KEY: z.string().optional(),
    SIGN_PROVIDER_VALIDATED: bool,
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    SIGN_SYNC_FALLBACK_MAX_CHARS: z.coerce.number().int().min(0).max(2000).default(280),
    SIGN_RESULT_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  })
  .superRefine((c, ctx) => {
    const prod = c.APP_ENV === 'production';
    if (prod && c.PAYMENT_PROVIDER === 'dev') {
      ctx.addIssue({ code: 'custom', path: ['PAYMENT_PROVIDER'], message: 'dev payment provider is forbidden in production' });
    }
    if (prod && c.EMAIL_PROVIDER === 'dev') {
      ctx.addIssue({ code: 'custom', path: ['EMAIL_PROVIDER'], message: 'dev email provider is forbidden in production' });
    }
    if (prod && !c.APP_BASE_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_BASE_URL'], message: 'production requires https' });
    }
    if (c.PAYMENT_PROVIDER === 'dev' && !c.DEV_PAYMENT_WEBHOOK_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['DEV_PAYMENT_WEBHOOK_SECRET'], message: 'required for the dev payment provider' });
    }
    if (c.SIGN_PROVIDER === 'http' && (!c.SIGN_PROVIDER_URL || !c.SIGN_PROVIDER_API_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['SIGN_PROVIDER_URL'], message: 'http sign provider requires URL and API key' });
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema> & {
  isProduction: boolean;
  cookieSecure: boolean;
  googleOAuthConfigured: boolean;
};

const cache = new WeakMap<object, AppConfig>();

/** Validates environment configuration. Throws (without echoing secret values) on invalid config. */
export function loadConfig(env: Bindings): AppConfig {
  const cached = cache.get(env);
  if (cached) return cached;
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${fields}`);
  }
  const c = parsed.data;
  const cfg: AppConfig = {
    ...c,
    isProduction: c.APP_ENV === 'production',
    // Secure cookies everywhere except plain-http local development.
    cookieSecure: c.APP_ENV === 'production' || c.APP_ENV === 'staging' || c.API_BASE_URL.startsWith('https://'),
    googleOAuthConfigured: Boolean(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET),
  };
  cache.set(env, cfg);
  return cfg;
}
