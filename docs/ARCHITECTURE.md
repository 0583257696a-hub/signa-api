# Architecture

## Shape

A **modular monolith** deployed as one Cloudflare Worker with three entry points (`src/index.ts`):

| Entry | Trigger | Purpose |
|---|---|---|
| `fetch` | HTTP | REST API under `/api/v1`, plus `/health` and `/ready` |
| `queue` | Cloudflare Queues | Processes sign translation jobs; also consumes the dead-letter queue |
| `scheduled` | Cron (`*/10 * * * *`) | Job expiry, ephemeral-data purge, subscription reconciliation, cleanup |

```
src/
  index.ts          Worker entry (fetch / queue / scheduled)
  app.ts            Hono app: middleware chain, routing, error mapping
  services.ts       Dependency container built from bindings (overridable in tests)
  context.ts        Services interface + Hono env typing
  env.ts            Bindings + Zod-validated configuration (fails closed in production)
  cron.ts           Scheduled maintenance
  lib/              errors, i18n (he/en messages), crypto, db helpers, http helpers, logger, time
  middleware/       request context, security headers, session loading, CSRF, auth/role guards, IP rate limit
  modules/
    auth/           registration, login, sessions, password reset, email verification, Google OAuth adapter
    users/          /me profile, preferences, sessions, deactivation, deletion
    orgs/           organizations, membership, roles, invitations, org usage
    billing/        plans, PaymentProvider interface + dev adapter, subscriptions, webhooks, reconciliation
    usage/          entitlements (plan → limits) and atomic usage metering
    emoji/          EmojiEngine interface, rule-based engine, Hebrew/English lexicon
    sign/           SignTranslationProvider interface, providers, validator, jobs, queue consumer
    dictionary/     sign entries, versions, animation asset registry, R2 asset store, signed URLs
    history/        OPT-IN saved translations
    privacy/        account deletion & export
    admin/          platform administration API
    audit/          audit events
    metrics/        hourly aggregate operational metrics
    email/          EmailProvider interface, dev/disabled adapters, bilingual templates
    flags/          feature flags
    ratelimit/      D1 fixed-window rate limiter
    health/         liveness & readiness
migrations/         D1 SQL migrations (schema + seed plans/flags)
test/               unit + integration tests (real migrations on SQLite)
```

## Layering

Each module separates **HTTP handlers** (`routes.ts`: validation, authorization, response shaping) from **business logic** (`service.ts` / `jobs.ts` / `validator.ts`). Data access goes through the `lib/db.ts` helpers, which always use bound parameters. External systems are reached only through injected interfaces:

| Interface | Implementations | Selected by |
|---|---|---|
| `PaymentProvider` | `NoPaymentProvider`, `DevPaymentProvider` | `PAYMENT_PROVIDER` |
| `EmailProvider` | `DisabledEmailProvider`, `DevEmailProvider` | `EMAIL_PROVIDER` |
| `SignTranslationProvider` | `NoSignProvider`, `DictionaryLookupProvider` (experimental), `HttpSignProvider` | `SIGN_PROVIDER` |
| `EmojiEngine` | `RuleBasedEmojiEngine` | built in |
| `JobQueue` | `CloudflareJobQueue` | `SIGN_JOBS_QUEUE` binding |
| `AssetStore` | `R2AssetStore` | `ASSETS_BUCKET` binding |

`buildServices(env, overrides)` builds the container per request. Tests inject fakes (clock, queue, asset store, providers) through `createApp(overrides)`.

## Request pipeline

```
services → requestContext (request ID, locale, access log) → securityHeaders (+ HTTPS enforcement in prod)
→ CORS (allow-listed origins, credentials) → loadSession (cookie → session) → csrfProtection → route
→ onError (AppError → localized JSON envelope; unknown errors → internal_error, no stack traces)
```

## Key decisions

- **D1 for everything relational.** Counters and rate limits use single-statement conditional UPSERTs, which are atomic in SQLite/D1, so no extra infrastructure (KV, Durable Objects) is needed. A Durable Object could replace the D1 rate limiter later if write volume demands it.
- **Queues for ISL jobs**, with a documented synchronous fallback for short inputs when the queue is missing or failing. Messages carry only a job ID; source text sits in an ephemeral D1 table that is purged when the job finishes.
- **Organization context** comes from the `X-Organization-Id` header. When it is present, membership is verified and usage is pooled at the organization level.
- **Server-side entitlements.** All limits come from `plan_entitlements` (editable by superadmins). The frontend only reads them.
- **Verification status is computed by Signa**, never taken from a provider (see [ISL-PIPELINE.md](ISL-PIPELINE.md)).
- **Bilingual by design.** Errors carry a stable `code` plus a localized `message` (from `Accept-Language` or the user's locale). User profiles derive `direction` (`rtl`/`ltr`) from the locale unless it is set explicitly. Email templates render RTL for Hebrew.

## Testing

`npm test` runs Vitest. The integration tests build the real app with `createApp(overrides)` and run the **real migrations** on Node's built-in SQLite through a small D1-compatible adapter (`test/helpers/d1.ts`), with transactional batches like D1. They cover auth, CSRF, quotas (including concurrency and month boundaries), idempotency, tenant isolation, the job lifecycle (retries, dead-letter, expiry, cancellation, duplicate delivery), dictionary and asset workflows, admin permissions, webhooks, privacy guarantees (no text in DB or logs), and configuration safety.

The code was also smoke-tested on the actual Workers runtime with `wrangler dev`: local D1 migrations, register → login → emoji → ISL job via the local Queue consumer → result → usage.
