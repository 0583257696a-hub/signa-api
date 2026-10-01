# Data & Privacy

Signa is **privacy-first**: translation text is processed and forgotten by default.

## Data categories

| Category | Examples | Where | Retention |
|---|---|---|---|
| **Operational metadata** | request ID, route template, status, duration, error code; job status/attempts/failure code; audit events (identifiers + enum values) | logs, `translation_jobs`, `audit_events`, `ops_metrics` | Logs per Cloudflare settings; job metadata 30 days; audit 365 days; metrics 90 days |
| **Aggregate usage metrics** | monthly counters per user/org/feature; usage events (outcome, feature, period, keyed request fingerprint, **no text**) | `usage_counters`, `usage_events` | Counters indefinitely (billing history); events 400 days |
| **Temporary translation data** | ISL job source text; normalized ISL result | `translation_job_inputs`, `translation_job_results` | Input deleted as soon as the job reaches a terminal state (or at its 10-minute deadline); result deleted after `SIGN_RESULT_TTL_SECONDS` (default 1 hour). Emoji text is never persisted. |
| **User-consented saved content** | translations the user explicitly saved | `saved_translations` | Until the user deletes the item, clears history, or deletes the account |
| **Account data** | name, email, locale, time zone, accessibility & player preferences, password hash, sessions | `users`, `user_credentials`, `sessions` | Until account deletion |

### Never stored
Translation text (except opt-in saved items and the minutes-long ephemeral job input), plaintext passwords, raw tokens, payment card data, full request bodies, IP addresses (rate limiting uses keyed HMACs in short-lived rows).

### Never sent to third parties
Source text goes to an external service **only** if an operator configures `SIGN_PROVIDER=http` with an engine whose data handling has been reviewed. The emoji engine runs entirely inside the Worker. Emails never contain translation text.

## Saved history: opt-in rules
1. Off by default (`users.history_enabled = 0`).
2. Turning it on requires the plan entitlement `history.available` (Pro/Business) **and** acceptance of the current disclosure version (`consentVersion`). The consent time and version are recorded.
3. Items are stored only when the client explicitly calls `POST /history` for a specific translation. Nothing is captured automatically.
4. Users can list, search, delete and clear their items at any time, even after turning history off.

## Account deletion workflow (`DELETE /me`)
1. **Verify identity:** password (or a recent re-authentication for OAuth-only accounts) plus `confirm: "DELETE"`.
2. **Ownership check:** refused while the user is the *only owner* of an organization that has other members. They must transfer ownership or delete the organization first.
3. **Billing:** the personal subscription is cancelled with the payment provider (no further charges).
4. **Notification:** a confirmation email is sent to the original address.
5. **Deletion:** credentials, sessions, one-time tokens, external identities, saved translations, translation jobs (and any ephemeral inputs/results), memberships, waitlist entries and pending invitations to the address are deleted. Organizations where the user was the sole member are marked deleted.
6. **Anonymization:** the user row becomes a tombstone (`deleted+<id>@invalid`, empty name, preferences cleared), so pseudonymous usage, billing and audit records stay consistent. The email address can be registered again.
7. **Audit:** an `account.deleted` event is recorded (identifiers only).

Deactivation (`POST /me/deactivate`) is the reversible alternative: sessions are revoked and signing in again reactivates the account.

## Data export (`GET /me/export`)
Returns the profile, organization memberships, subscriptions, usage counters, saved translations, active sessions, and an explicit list of what Signa does not store.
