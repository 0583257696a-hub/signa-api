# Israeli Sign Language (ISL) Pipeline

> Hebrew-to-ISL translation is **not** a solved problem, and Signa does not pretend otherwise.
> ISL has its own grammar (word order, spatial reference, classifiers), and meaning is carried by
> non-manual markers (facial expression, eyebrows, gaze, head and body movement, mouthing).
> Translating Hebrew word by word does not produce ISL. This backend provides the **infrastructure**
> for a real engine and refuses to present anything unvalidated as verified.

## Pipeline
1. **Validate** the request (Zod; normalize; strip control/bidi characters; empty and length checks against `sign.max_input_chars`).
2. **Authorize & meter:** session, `sign_translation` flag, `sign.enabled` entitlement, per-user rate limit, atomic quota reservation (idempotent via `Idempotency-Key`), atomic concurrent-job limit (`sign.max_concurrent_jobs`).
3. **Create an ephemeral job:** metadata in `translation_jobs`, source text in `translation_job_inputs` (10-minute deadline).
4. **Enqueue** `{ jobId }` (no text) on Cloudflare Queues. If the queue is missing or failing, inputs of up to `SIGN_SYNC_FALLBACK_MAX_CHARS` (280) are processed synchronously; longer inputs fail cleanly with `queue_unavailable` and the usage is released.
5. **Process** (queue consumer): claim the job with a conditional `UPDATE` (safe under duplicate delivery), call the configured `SignTranslationProvider`, and record provider latency.
6. **Validate the proposal** against the approved dictionary (published = expert-approved + licence-confirmed) and the animation catalog (approved assets, latest version).
7. **Check renderability** and compute `verificationStatus`.
8. **Store the result** (`translation_job_results`, TTL `SIGN_RESULT_TTL_SECONDS`) and **delete the input immediately**. Usage is committed, or released for `unsupported`/failed/cancelled/expired outcomes.
9. **Cron** expires overdue jobs and purges expired inputs and results; job metadata (no text) is deleted after 30 days.

### Reliability
- Bounded attempts: `max_attempts = 3` (per job) plus queue `max_retries = 3` and a dead-letter queue. Dead-lettered jobs are failed explicitly (`dead_lettered`).
- Exponential backoff for redelivery: 10 s, 20 s, 40 s … capped at 5 min.
- Processing lease: 2 min per attempt, so a crashed worker's job becomes claimable again.
- Explicit failure codes: `provider_error`, `input_unavailable`, `max_attempts_exceeded`, `deadline_exceeded`, `dead_lettered`, `queue_unavailable`, `cancelled_by_user`.
- A completed result is never returned while the job is pending (`409 job_not_ready`). A cancellation that races with completion wins.

## Providers
| `SIGN_PROVIDER` | Class | Behaviour |
|---|---|---|
| `none` | `NoSignProvider` | Always `unsupported` (`no_translation_engine_configured`) |
| `dictionary_lookup` (default) | `DictionaryLookupProvider` | **Experimental, illustrative.** Longest-match lookup of approved entries by Hebrew label or `hebrewTerms`, in source order, with an entry chosen per term by `selectCandidate` (see below). Unmatched or ambiguous words become explicit `unsupported` segments (`no_approved_sign`, `ambiguous_term`, `no_animation_available`). No sentence analysis is performed. Always `engineValidated = false`. References only existing approved entries and never invents IDs. |
| `http` | `HttpSignProvider` | External engine. Bearer API key, 20 s timeout, the job ID as idempotency key, and strict schema validation of the response. `engineValidated` is true **only if** the engine reports `validated: true` **and** the operator set `SIGN_PROVIDER_VALIDATED=true` after an ISL expert evaluation. |

Contract (`src/modules/sign/provider.ts`):
```ts
interface SignTranslationProvider {
  translate(input: SignTranslationInput): Promise<SignTranslationResult>;
  health(): Promise<{ status: 'ok' | 'degraded' | 'not_configured' }>;
}
```
A provider returns proposed segments `{ kind: sign | fingerspelling | pause | unsupported, signEntryId?, letters?, durationMs?, sourceSpan?, nonManualMarkers? }`. Replacing the provider does not change authentication, billing or the API contract.

## Three representations
A translation keeps three things apart:
1. **Source sentence:** the Hebrew text. It is ephemeral, never stored with the result (`sourceTextStored: false`).
2. **Linguistic representation:** the ISL structure an engine maps the meaning to (questions, negation, time, spatial reference, grammatical non-manual markers). Only a validated engine (`SIGN_PROVIDER=http`) can produce it.
3. **Animation sequence:** approved signs, timing, lexical and grammatical non-manual markers that the avatar can render.

A sentence like "איפה תחנת האוטובוס הקרובה?" needs analysis of the question, the place and proximity. A sequence of separate word animations is **not** assumed to be the correct translation. A missing sign or structure is marked as missing; no movement is invented.

## Lexical candidate selection
`selectCandidate` (`src/modules/sign/candidates.ts`) picks one dictionary entry for a term:
- Only expert-verified entries **with an approved animation** are eligible.
- The highest `contextMatch` wins, **unless** the runner-up is within `0.05`. A near-tie is reported as `ambiguous_term` rather than guessed.
- A tie between variants of **one** concept is resolved only by the reviewer-chosen `isDefaultVariant`. A tie across different concepts is never resolved automatically.

This chooses a lexical entry only. A confident choice for every word does not by itself make a correct ISL sentence.

## Verification statuses (computed by Signa)
| Status | Rule |
|---|---|
| `verified` | Validated engine **and** every content segment is a published sign with an approved animation, with nothing unsupported |
| `partially_verified` | Validated engine; at least one renderable segment, but some are fingerspelled or not covered |
| `experimental` | Engine not linguistically validated, but at least one segment is renderable |
| `unsupported` | Nothing renderable, or the provider declined the input |
| `failed` | Processing failed (job status `failed`) |

Segment statuses: `verified_sign`, `fingerspelled` (every letter has an approved `FS-<letter>` entry and asset), `unknown_sign` (not in the approved dictionary, including any fabricated ID), `missing_asset`, `unsupported`, `pause`.
Non-manual markers come in two kinds:
- `lexicalNonManualMarkers`: part of the expert-approved sign itself (from the dictionary). Always included for `verified_sign` segments.
- `nonManualMarkers`: sentence-level (grammatical) markers proposed by the engine. Passed through **only** for renderable segments from a validated engine.

`quality.lexicalCoverage` is the share of source letters covered by approved signs. It is **not** a confidence score or a measure of linguistic correctness, and must not be shown as "translation accuracy".
Job status is `partially_completed` when some, but not all, segments are renderable.

## Result format
```json
{
  "jobId": "job_…", "sourceLanguage": "he", "outputFormat": "avatar_sequence",
  "engine": { "name": "dictionary-lookup", "version": "1.0.0", "validated": false },
  "dictionaryVersion": 3,
  "verificationStatus": "experimental",
  "segments": [{
    "index": 0, "kind": "sign", "status": "verified_sign", "gloss": "HELLO",
    "signEntry": { "id": "sgn_…", "code": "SG-0001", "label": "שלום", "conceptKey": "HELLO" },
    "assets": [{ "id": "ast_…", "mimeType": "model/gltf-binary", "durationMs": 900, "url": "https://…" }],
    "timing": { "startMs": 0, "durationMs": 900 },
    "lexicalNonManualMarkers": [], "nonManualMarkers": [], "sourceSpan": { "start": 0, "end": 4 }, "renderable": true
  }],
  "missing": [{ "index": 3, "status": "unsupported", "sourceSpan": { "start": 20, "end": 25 }, "reason": "no_approved_sign" }],
  "sourceTextStored": false,
  "quality": { "segmentsTotal": 4, "verifiedSegments": 3, "fingerspelledSegments": 0, "unsupportedSegments": 1,
               "lexicalCoverage": 0.83, "renderable": false, "totalDurationMs": 2600 },
  "notices": ["engine_not_linguistically_validated", "segmentation_is_illustrative_not_isl_grammar", "some_segments_cannot_be_rendered"],
  "createdAt": "…"
}
```

## Dictionary & asset registry
See [DICTIONARY.md](DICTIONARY.md) for the lexical model (concepts and entries), sources, licensing and build order.
- **Sign entry:** `SG-0001`-style code, concept, gloss, Hebrew/English terms, sense, part of speech, grammatical features, regional variants, sign definition, lexical non-manual markers, handedness, source and licence references, `validation_status` (`draft → in_review → needs_expert → approved | rejected`), `reviewer_ref` (required for approval), `license_status` (`pending | needs_source | confirmed | rejected`), `publication_status`, version.
- **Invariant enforced by a DB CHECK:** published ⇒ approved **and** licence confirmed.
- Editing linguistic content of an approved entry resets it to `in_review` and unpublishes it. Every review, licence change and edit snapshots a revision (`sign_entry_revisions`).
- **Dictionary versions:** `POST /admin/dictionary/versions` snapshots every published entry at its current version (`dictionary_version_entries`). Results record the dictionary version they were validated against.
- **Animation assets:** binary content lives in R2 under opaque keys; D1 holds metadata (MIME type, size, duration, version, licence JSON, attribution, approval status, visibility, SHA-256). Approval requires an uploaded file **and** a confirmed licence. A licence change sends an approved asset back to review and makes it private. Revisions are kept in `animation_asset_revisions`.
- Fingerspelling letters are ordinary entries with canonical label `FS-<letter>` (e.g. `FS-א`).
