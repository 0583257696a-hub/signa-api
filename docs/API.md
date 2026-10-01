# API Reference (`/api/v1`)

## Conventions

**Success**
```json
{ "data": { … }, "meta": { "requestId": "req_…", … } }
```
**Error**
```json
{ "error": { "code": "quota_exceeded", "class": "limit", "message": "…localized…", "details": { … } }, "meta": { "requestId": "req_…" } }
```
- `code` is stable and machine-readable; `message` is localized (`he` default, `en` via `Accept-Language` or the user's locale). `class` is one of `client | auth | limit | dependency | internal`.
- Every response carries an `X-Request-Id` header.
- JSON bodies only (`Content-Type: application/json`, max 64 KB). Unknown fields are rejected with `422` on mutation endpoints.
- Lists use `?limit=1..100&cursor=…` and return `nextCursor`.
- Timestamps are ISO-8601 UTC.

### Frontend integration (Next.js)

1. Call the API with `credentials: 'include'`. The session lives in an **HttpOnly, Secure, SameSite=Lax** cookie (`__Host-signa_session` over HTTPS). Never store tokens in `localStorage`.
2. Keep the `csrfToken` (returned by login, refresh, reauthenticate and `GET /auth/session` or `GET /auth/csrf`) **in memory** and send it as `X-CSRF-Token` on every `POST/PUT/PATCH/DELETE`. After a page reload, fetch it again with `GET /auth/csrf`.
3. Send `Idempotency-Key` (8–128 chars `[A-Za-z0-9_-:.]`) on translation requests so that retries are never billed twice.
4. To act in an organization context, send `X-Organization-Id: org_…`.
5. Render `error.message` directly, or map `error.code` to your own copy.

### Common error codes

`validation_error` 422 · `unauthenticated` 401 · `forbidden` 403 · `csrf_failed` 403 · `not_found` 404 · `conflict` 409 · `idempotency_conflict` 409 · `rate_limited` 429 (+`Retry-After`) · `quota_exceeded` 429 (`details: { limitType, limit, used, resetsAt, planId }`) · `entitlement_required` 403 · `input_too_long` 413 (`details.maxChars`) · `empty_input` 422 · `feature_disabled` 403 · `account_inactive` 403 · `organization_suspended` 403 · `reauthentication_required` 401 · `invalid_credentials` 401 · `invalid_token` 400 · `email_not_verified` 403 · `job_not_ready` 409 · `job_not_cancellable` 409 · `queue_unavailable` 503 · `provider_not_configured` 501 · `provider_error` 502 · `internal_error` 500

---

## Health
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness: `{ "status": "ok" }` |
| GET | `/ready` | Readiness: `{ status: "ready"\|"not_ready", checks: { database, storage, queue } }`; `503` if the DB is down |

## Auth (`/auth`)
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/register` | `name, email, password (10–128), locale?, timeZone?` | Always `202` (no enumeration); sends a verification email |
| POST | `/login` | `email, password` | Sets the session cookie; returns `{ user, csrfToken }`. Rate limited per IP and per email |
| POST | `/logout` | – | Revokes the session, clears the cookie |
| POST | `/refresh` | – | Rotates the session (new cookie and CSRF token) |
| GET | `/session` | – | `{ user, csrfToken, expiresAt }` |
| GET | `/csrf` | – | `{ csrfToken }` |
| POST | `/reauthenticate` | `password` | Step-up auth for high-risk actions (valid 15 min) |
| POST | `/password/forgot` | `email` | Always `202` |
| POST | `/password/reset` | `token, password` | Single use, 1 h TTL; revokes all sessions |
| POST | `/password/change` | `currentPassword, newPassword` | Revokes other sessions, rotates the current one |
| POST | `/email/verify` | `token` | Single use, 24 h TTL |
| POST | `/email/verify/resend` | – | `202` |
| GET | `/oauth/google/start?redirect=/path` | – | Redirects to Google (only if configured and flag on) |
| GET | `/oauth/google/callback` | – | PKCE + state; signs in and redirects to the app |

Links in emails point to `APP_BASE_URL/verify-email#token=…`, `/reset-password#token=…` and `/invitations/accept#token=…`. The frontend reads the token from the URL fragment and POSTs it.

## Me (`/me`)
| Method | Path | Notes |
|---|---|---|
| GET | `/me` | `{ user, organizations[], plan: { id, subscriptionStatus, historyAvailable } }` |
| PATCH | `/me` | `name, locale (he/en), direction (ltr/rtl/null = derived), timeZone, accessibility{reduceMotion,highContrast,largeText,captions}, preferences{defaultMode,playbackSpeed,emojiStyle}` |
| PUT | `/me/privacy/history` | `{ enabled, consentVersion }`: opt in/out of saved history (Pro/Business) |
| GET | `/me/export` | Data export (JSON) |
| POST | `/me/deactivate` | `{ password }`: signing in again reactivates |
| DELETE | `/me` | `{ password, confirm: "DELETE" }`: see DATA-AND-PRIVACY.md |
| GET | `/me/sessions` | Active sessions (`current` flag) |
| DELETE | `/me/sessions/:id` | Revoke one of your own sessions |
| POST | `/me/sessions/revoke-others` | Sign out everywhere else |

## Plans, usage, billing
| Method | Path | Notes |
|---|---|---|
| GET | `/plans` | Public. `{ plans: [{ id, name{en,he}, availability: available\|waitlist\|contact_sales, pricing (null), pricingStatus: "to_be_announced", trialDays, entitlements }] }` |
| POST | `/plans/:planId/waitlist` | Join the waitlist (plans with `availability = waitlist`) |
| GET | `/usage` | Usage in the current context: `{ planId, period{start,end,resetsAt}, counters{translations,emoji,sign: {used,limit}}, limits{…} }` |
| GET | `/organizations/:id/usage` | Org admins: org usage + per-member success counts |
| GET | `/billing/subscription[?organizationId=]` | Live subscription + effective plan |
| GET | `/billing/subscription/history[?organizationId=]` | Status/plan history |
| POST | `/billing/checkout` | `{ planId, organizationId? }` → `{ checkoutId, url }`. Requires a verified email, a purchasable plan (pricing configured) and a configured provider. **Does not activate anything.** |
| POST | `/billing/subscription/cancel` | `{ organizationId? }`: cancels at period end (immediately during a trial) |
| POST | `/billing/webhooks/:provider` | Provider-signed webhooks (idempotent per event ID) |

`translations.monthly_limit` is a **pooled** limit across emoji and sign (the "12 / 50" counter in the UI). Per-feature limits apply as well when they are set.

## Emoji
`POST /emoji/translate`, with optional headers `Idempotency-Key` and `X-Organization-Id`:
```json
{ "text": "שלום! אני שמח לראות אותך", "mode": "text_and_emoji", "style": "standard", "language": "he", "variant": 0 }
```
- `mode`: `emoji_only | text_and_emoji`; `style`: `minimal | standard | expressive` (gated by plan); `language`: `he | en | auto`; `variant` 0–9 picks deterministic alternatives ("Regenerate").

Response:
```json
{
  "data": {
    "result": "שלום! 👋 אני שמח 😊 לראות אותך 🤗",
    "mode": "text_and_emoji", "style": "standard", "language": "he", "direction": "rtl",
    "alternatives": { "textAndEmoji": "שלום! 👋 אני שמח 😊 לראות אותך 🤗", "emojiOnly": "👋😊🤗" },
    "emojis": ["👋", "😊", "🤗"], "variant": 0
  },
  "meta": { "requestId": "req_…", "provider": "rules", "engineVersion": "1.0.0", "method": "deterministic_rules",
            "usageCounted": true, "idempotentReplay": false, "matchedConcepts": 3, "coverage": 0.8, "noMatch": false }
}
```
The rule-based engine matches a curated lexicon (Hebrew prefixes and suffixes, English stemming, phrases, negation). It does **not** understand arbitrary sentences, and `coverage` is not an accuracy measure. Requests where nothing matched are not counted.

## Sign language (ISL)
| Method | Path | Notes |
|---|---|---|
| POST | `/sign/translate` | `{ text, language: "he", outputFormat: "avatar_sequence"\|"gloss" }` → `202 { job }` (queued), or `200` when processed inline or an idempotent replay. `meta.pollAfterMs` |
| GET | `/sign/jobs/:jobId` | Job status (owner only) |
| GET | `/sign/jobs/:jobId/result` | `409 job_not_ready` while pending; `404` with `details.reason = result_expired` after retention |
| POST | `/sign/jobs/:jobId/cancel` | Queued or processing jobs only |

Job statuses: `queued, processing, completed, partially_completed, failed, cancelled, expired`.
Result: see [ISL-PIPELINE.md](ISL-PIPELINE.md#result-format). Show `quality.lexicalCoverage` as dictionary coverage, never as accuracy. UI mapping: `verificationStatus` → badge (Verified / Partially verified / Experimental / Unsupported); `segments[].status` → `verified_sign` ("covered by reviewed signs"), `fingerspelled`, `unknown_sign` / `missing_asset` / `unsupported` (not renderable); `segments[].sourceSpan` highlights the source text.

## Saved history (opt-in)
| Method | Path | Notes |
|---|---|---|
| POST | `/history` | Save one translation the user chose to keep. Requires opt-in + Pro/Business |
| GET | `/history?q=&kind=&from=&to=` | Search your saved items |
| DELETE | `/history/:id` | Delete one item |
| DELETE | `/history` | Clear everything |

## Organizations (`/organizations`)
| Method | Path | Role |
|---|---|---|
| POST | `/` | any verified user → owner |
| GET | `/` | your organizations |
| GET | `/:id` | member (admins also see the subscription) |
| PATCH | `/:id` | admin (`name`, `defaultLocale`); owner (`settings`) |
| DELETE | `/:id` | owner + recent re-auth |
| GET | `/:id/members` | member (emails visible to admins only) |
| PATCH | `/:id/members/:userId` | admin (member↔admin); owner (anything involving owners); last owner protected |
| DELETE | `/:id/members/:userId` | admin, or self to leave |
| POST | `/:id/invitations` | admin: `{ email, role: admin\|member }` (seat-limited by plan) |
| GET | `/:id/invitations` | admin |
| DELETE | `/:id/invitations/:invitationId` | admin |
| POST | `/invitations/accept` | `{ token }`: must be signed in with the invited, verified email |

Non-members get `404` for every organization resource.

## Dictionary (public)
| Method | Path | Notes |
|---|---|---|
| GET | `/dictionary/entries?q=` | Published (expert-approved + licence-confirmed) entries |
| GET | `/dictionary/entries/:id` | Entry + approved animation metadata with a URL (public or signed for 15 min) |
| GET | `/dictionary/versions` | Published dictionary versions |
| GET | `/dictionary/versions/:version` | Snapshot of entries and their versions |
| GET | `/assets/:assetId/content` | Asset bytes from R2 (public assets, or a valid `exp`+`sig`) |

## Admin (`/admin`, platform roles `support < admin < superadmin`)
| Method | Path | Min role |
|---|---|---|
| GET | `/admin/overview?days=` | support |
| GET | `/admin/users?q=&status=` · `/admin/users/:id` | support |
| POST | `/admin/users/:id/suspend` · `/reactivate` `{ reason }` | admin |
| PUT | `/admin/users/:id/platform-role` `{ role, reason }` | superadmin + re-auth |
| GET | `/admin/organizations` · `/admin/organizations/:id` | support |
| POST | `/admin/organizations/:id/suspend` · `/reactivate` | admin |
| GET | `/admin/subscriptions?status=&planId=` | support |
| POST | `/admin/subscriptions` (manual grant) | superadmin + re-auth |
| POST | `/admin/subscriptions/:id/status` | admin + re-auth |
| GET | `/admin/plans` | admin |
| PATCH | `/admin/plans/:id` (names, availability, pricing, trial, grace) | superadmin + re-auth |
| PUT | `/admin/plans/:id/entitlements` | superadmin + re-auth |
| GET | `/admin/usage?period=YYYY-MM` | support |
| GET | `/admin/feature-flags` · PUT `/admin/feature-flags/:key` | support · admin |
| GET | `/admin/audit-events?action=&actorUserId=&outcome=&from=&to=` | admin |
| GET | `/admin/jobs/stats?days=` · `/admin/engine/health` | support |
| GET/POST/PATCH | `/admin/dictionary/entries[...]` (create, edit, review, license, publish, unpublish, revisions; `?conceptKey=` filter) | admin |
| GET/POST/PATCH | `/admin/dictionary/concepts[/:key]` (`?category=&status=&coverage=missing\|covered`) | admin |
| GET | `/admin/dictionary/coverage` (lexical coverage per category) | admin |
| POST | `/admin/dictionary/versions` | admin |
| POST | `/admin/dictionary/entries/:id/assets` → upload grant | admin |
| PUT | `/admin/dictionary/assets/:assetId/upload` (`X-Upload-Token`, raw body) | admin |
| PATCH/POST/GET | `/admin/dictionary/assets/:assetId[/review\|/revisions]` | admin |
