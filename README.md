# Signa — Backend API

Backend for **Signa**, a bilingual (Hebrew / English) SaaS that turns free text into:

1. **Israeli Sign Language (ISL)** output for a 3D avatar, built only from expert-approved dictionary entries and licensed animation assets.
2. **Emoji translations**: emoji-only output, or the original text with emojis added.

It runs on **Cloudflare Workers** with **Hono**, **D1** (SQLite), **R2**, **Queues** and **Cron Triggers**, written in strict TypeScript and validated with Zod.

> **Status.** All modules described below are implemented and covered by automated tests (92 tests),
> and were smoke-tested end-to-end on the real Workers runtime (`wrangler dev`, local D1 and Queues).
> It has **not** been deployed to a Cloudflare account. No real payment provider, email provider or
> validated ISL translation engine is connected yet. Those sit behind interfaces, with safe defaults (see [What remains](#what-remains)).

## Web app

`web/` is the Signa frontend (Next.js + React + TypeScript, static export), built from the UI mockups:
sign-language and emoji translation, history (opt-in), dictionary, usage & plans, settings/accessibility,
help and a staff overview, in Hebrew (RTL) and English. It is built on every deploy (`[build]` in
`wrangler.toml`) and served as static assets **by the same Worker**, so the site and the API share one
origin (`/api/*`, `/health`, `/ready` run the Worker; everything else is static).

```bash
npm run build:web     # builds web/out
npx wrangler dev      # site + API on http://localhost:8787
```

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars          # set APP_SECRET (≥ 32 chars)
npm run db:migrate:local                # apply D1 migrations locally
npm run dev                             # http://localhost:8787
npm test                                # 92 unit + integration tests
npm run typecheck
```

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module layout, request pipeline, provider interfaces, design decisions |
| [docs/API.md](docs/API.md) | Every endpoint, request/response envelope, error codes, frontend integration |
| [docs/SECURITY.md](docs/SECURITY.md) | Auth, sessions, CSRF, password hashing, tenant isolation, admin protections |
| [docs/DATA-AND-PRIVACY.md](docs/DATA-AND-PRIVACY.md) | Data categories, retention, deletion/export, what is never stored |
| [docs/ISL-PIPELINE.md](docs/ISL-PIPELINE.md) | Sign translation pipeline, verification statuses, candidate selection, assets |
| [docs/DICTIONARY.md](docs/DICTIONARY.md) | Lexical model (concepts and entries), sources and licensing, build order |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Provisioning Cloudflare resources, secrets, migrations, release checklist |

## What remains

These items need decisions, credentials or external work and are **not** done:

- **Payment provider.** Only `PaymentProvider` plus a dev adapter exist. Pick a provider, implement its adapter (checkout, webhook signature verification, status lookup) and set real prices. Prices are intentionally `null` ("to be announced").
- **Email provider.** Only `EmailProvider` plus a dev in-memory adapter exist. Production delivery stays disabled until a real adapter is added.
- **ISL translation engine.** The default `dictionary_lookup` adapter is an experimental, illustrative lookup over approved entries. It is **not** ISL grammar, and its output is always labelled `experimental`. A linguistically validated engine can be plugged in through `SignTranslationProvider` / `SIGN_PROVIDER=http`.
- **Dictionary content and animation assets.** The dictionary starts with 114 *candidate concepts* and no signs. Entries need ISL expert review and confirmed licences before publication (see `docs/DICTIONARY.md`).
- **Google OAuth.** Implemented, but it needs Google credentials and the `google_oauth` feature flag turned on.
- **Production values.** Production runs on the `signa-api` Worker at `https://signa-api.abd-digital.workers.dev` (D1 `signa-db-production`); staging values in `wrangler.toml` are still placeholders, and a custom domain is not set up yet.
