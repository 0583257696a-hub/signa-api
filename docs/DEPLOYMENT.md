# Deployment

> Nothing has been deployed yet. These are the steps to do it with your Cloudflare account.

## 1. Prerequisites
- Node.js ≥ 22.5, a Cloudflare account, and `npx wrangler login`.

## 2. Create resources (per environment)
```bash
npx wrangler d1 create signa-db-production          # copy database_id into wrangler.toml [env.production]
npx wrangler r2 bucket create signa-assets-production
npx wrangler queues create signa-sign-jobs-production
npx wrangler queues create signa-sign-jobs-production-dlq
```
Repeat with `-staging` names for staging. For local development nothing is needed: `wrangler dev` simulates D1, R2 and Queues.

## 3. Configure
Edit `wrangler.toml` `[env.production.vars]`: `APP_BASE_URL`, `API_BASE_URL`, `CORS_ALLOWED_ORIGINS` (real HTTPS domains). Use the same registrable domain for the app and the API (e.g. `signa.co.il` and `api.signa.co.il`) so the `SameSite=Lax` cookie works.

Secrets (never committed):
```bash
openssl rand -base64 48 | npx wrangler secret put APP_SECRET --env production
# only when used:
npx wrangler secret put SIGN_PROVIDER_API_KEY --env production
npx wrangler secret put GOOGLE_CLIENT_SECRET --env production   # plus GOOGLE_CLIENT_ID as a var or secret
```
Rotating `APP_SECRET` invalidates CSRF tokens, signed asset URLs and rate-limit keys (users simply fetch a new CSRF token). Sessions are unaffected.

| Variable | Values | Default |
|---|---|---|
| `APP_ENV` | development, test, staging, production | development |
| `EMAIL_PROVIDER` | disabled, dev (dev is forbidden in production) | disabled |
| `PAYMENT_PROVIDER` | none, dev (dev is forbidden in production) | none |
| `SIGN_PROVIDER` | none, dictionary_lookup, http | dictionary_lookup |
| `SIGN_PROVIDER_VALIDATED` | `true` only after an ISL expert evaluation of the engine | false |
| `SIGN_SYNC_FALLBACK_MAX_CHARS` | 0–2000 | 280 |
| `SIGN_RESULT_TTL_SECONDS` | 60–86400 | 3600 |
| `LOG_LEVEL` | debug, info, warn, error | info |

## 4. Migrate & deploy

### Option A: Cloudflare Workers Builds (Git integration, what production uses)
Worker **`signa-api`** → Settings → Build:

| Setting | Value |
|---|---|
| Git repository | `new-project-signa`, branch `main` |
| Build command | `npm ci` |
| Deploy command | `npm run deploy` (applies pending D1 migrations, then deploys the production environment) |
| Root directory | `/` |

`[env.production] name = "signa-api"` must match the Worker name in the dashboard. Secrets such as `APP_SECRET` are set under Worker → Settings → Variables and Secrets (type **Secret**). Every push to `main` builds, applies pending migrations and deploys.

Temporary address: `https://signa-api.abd-digital.workers.dev` (`/health`, `/ready`, `/api/v1`). A newly created `workers.dev` subdomain can return `NXDOMAIN` from some resolvers for a while (cached negative answers), even though it resolves globally.

### Option B: from a terminal
```bash
npm ci && npm run typecheck && npm test
npx wrangler d1 migrations apply signa-db-production --remote --env production
npx wrangler deploy --env production
curl https://api.signa.example/health && curl https://api.signa.example/ready
```
Migrations are forward-only, version-controlled SQL in `migrations/`. Wrangler tracks applied migrations in D1. **Never edit an applied migration**: add a new numbered file. Take a D1 backup (Time Travel) before applying migrations to production.

## 5. Bootstrap the first superadmin
There is deliberately no API to self-promote. After the operator registers through the app:
```bash
npx wrangler d1 execute signa-db-production --remote --env production \
  --command "UPDATE users SET platform_role = 'superadmin' WHERE email_normalized = 'ops@your-domain'"
```

## 6. Release checklist
- [ ] Real domains in vars; `APP_SECRET` set (≥ 32 chars)
- [ ] D1 IDs filled in; migrations applied; `/ready` returns `ready`
- [ ] Payment provider adapter implemented, webhook secret set, prices configured via `PATCH /admin/plans/:id` (until then, checkout returns `provider_not_configured` / `plan_not_purchasable`)
- [ ] Email provider adapter implemented (until then, emails are recorded as `suppressed`, so verification and reset emails are **not delivered**)
- [ ] Dictionary entries reviewed by ISL experts, licences confirmed, assets uploaded and approved, first dictionary version published
- [ ] `SIGN_PROVIDER_VALIDATED` left `false` unless an engine has passed linguistic validation
- [ ] Cloudflare Workers Logs / Logpush configured; alerts on `level=error`, queue DLQ volume and `/ready`
- [ ] Rate-limit and plan limits reviewed (`GET /admin/plans`)
