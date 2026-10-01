# Security

## Authentication & sessions
- **Password hashing:** PBKDF2-HMAC-SHA256, **100,000 iterations** (the Cloudflare Workers ceiling), 16-byte random salt, 32-byte key, NFKC-normalized input. Argon2id is not available natively in Workers' Web Crypto. Hashes are self-describing (`pbkdf2_sha256$iter$salt$hash`), so the parameters can be raised later; `needsRehash` upgrades a hash transparently on the next login. Passwords must be 10–128 characters.
- **Timing equalization:** login and password reset run a full hash comparison against a dummy hash when the account does not exist.
- **No enumeration:** registration and forgot-password always return the same `202`. Login returns the same `invalid_credentials` for an unknown email and for a wrong password. Repeated sign-up with an existing email triggers a security notice to the real owner instead.
- **Tokens:** 256-bit random values (`crypto.getRandomValues`). Session, email-verification, password-reset, invitation and upload-grant tokens are stored only as **SHA-256 hashes**. One-time tokens are consumed atomically (`UPDATE … RETURNING`) and older tokens of the same purpose are invalidated.
- **Cookies:** `__Host-signa_session` over HTTPS: `HttpOnly; Secure; SameSite=Lax; Path=/`. No tokens in `localStorage`.
- **Session lifetime:** 7-day idle timeout (sliding) and 30-day absolute lifetime.
- **Rotation:** a new session on every login (any existing session on the browser is revoked) and on `refresh`, `reauthenticate` and password change. Password reset revokes all sessions. Platform role changes revoke the target's sessions. Suspension and deactivation revoke sessions; a suspended or deleted user's sessions stop working at once, because the user status is checked on every request.
- **Step-up auth:** high-risk operations (platform role changes, plan/entitlement/pricing changes, manual subscriptions, organization deletion, deleting an OAuth-only account) require `authenticated_at` within the last 15 minutes (`POST /auth/reauthenticate`).
- **Identity abstraction:** `CredentialVerifier` (password) and the session layer are separate. Google OAuth (authorization code + PKCE + state; ID token claims `iss/aud/exp/email_verified` validated) plugs in beside it. A managed identity provider can replace credential verification without touching sessions or the rest of the API.

## CSRF
For cookie-authenticated `POST/PUT/PATCH/DELETE`:
1. **Origin/Referer check** against `APP_BASE_URL`, `API_BASE_URL` and `CORS_ALLOWED_ORIGINS`.
2. **Synchronizer token**: `X-CSRF-Token` must equal `HMAC(APP_SECRET, "csrf|" + sessionId)`. It rotates whenever the session rotates.

Pre-authentication endpoints (login, register, forgot/reset, verify, logout) skip the token but keep the Origin check. Payment webhooks are authenticated by signature instead.

## Transport & headers
In production, non-HTTPS requests are rejected and HSTS is sent. Every response includes `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive CSP and `Cache-Control: no-store` by default. CORS allows only configured origins (with credentials).

## Rate limiting
D1 fixed-window counters via an atomic UPSERT. Identifiers (IPs, emails) are stored only as keyed HMACs.

| Bucket | Limit |
|---|---|
| Login | 20/min per IP, 10 per 15 min per email |
| Register | 10/h per IP |
| Forgot password | 10/h per IP, 3/h per email (silently, still `202`) |
| Reset password | 20/h per IP |
| Verify email | 30/h per IP |
| Re-authenticate | 10/min |
| Translations | `rate.requests_per_minute` per user (from the plan) |

## Authorization & tenant isolation
- Every protected route checks the session server-side. Organization resources go through `requireMembership(userId, orgId, minRole)`, which joins on `organization_members`. Outsiders get **404**, so IDs cannot be probed.
- Every tenant-scoped query includes the organization or user boundary in its `WHERE` clause (jobs: `id AND user_id`; history: `id AND user_id`; sessions: `id AND user_id`; invitations: `id AND organization_id`).
- Organization roles (`owner > admin > member`) and **platform roles** (`support < admin < superadmin`) are separate columns and separate checks. Staff can act only on accounts with a lower platform role and never on themselves.
- **Mass assignment:** mutation schemas use Zod `.strict()`, so unknown fields such as `status` or `platform_role` are rejected. Updates write explicit columns only.
- **Quotas** cannot be modified by clients: there are no write endpoints for counters, and entitlements come from the database.

## Payments
Subscriptions are created or changed only by **verified provider webhooks** (HMAC + timestamp tolerance for the dev adapter), never by frontend reports. Webhook events are recorded by `(provider, event_id)` and processed idempotently; failed events can be retried. No card data is ever received or stored, only provider references. The dev adapter is refused in production by config validation.

## Uploads (R2)
Admin-only, plus a **single-use, 15-minute upload grant** per asset. The server generates opaque object keys (no user-controlled paths, so no traversal). There is an allow-list of MIME types with per-type size caps, declared `Content-Type` and `Content-Length` are enforced, magic bytes are checked, and a SHA-256 checksum is recorded. R2 credentials are never exposed: content is served through the Worker, either publicly (approved + public + published) or with a 15-minute HMAC-signed URL.

## Logging & errors
Structured JSON logs include request ID, method, **route template**, status, duration, error code and auth flag. Never logged: request bodies, translation text, cookies, tokens, passwords, emails (keys matching sensitive patterns are redacted as defence in depth). Unexpected errors return `internal_error` without stack traces; the server log records only the error class and name. Audit metadata drops keys that look sensitive.

## Configuration safety
`loadConfig` validates the environment with Zod and **refuses to start** with: `APP_SECRET` shorter than 32 characters; dev payment/email providers in production; non-HTTPS `APP_BASE_URL` in production; an incomplete HTTP sign provider configuration.
