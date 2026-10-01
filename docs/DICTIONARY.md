# Building the Signa ISL Dictionary

This guide explains how lexical data gets into Signa. The guiding rule: **nothing is published
without ISL expert review and a confirmed licence**, and nothing is imported in bulk and presented
as a verified commercial dictionary.

## 1. Candidate sources (check licences first)

| Source | What it offers | Before using it in Signa |
|---|---|---|
| **The Corpus of Israeli Sign Language** | Videos of Deaf signers in Israel, with written descriptions and information on linguistic variation. Useful for vocabulary, natural usage and grammar research. | Check the terms of use. Corpus videos are research material, not licensed avatar assets. |
| **ISL-LEX v.1** (research lexical resource) | 961 non-compound signs, with videos, form features, and frequency and iconicity ratings. Useful for the entry schema (form features) and for prioritizing concepts. | Check the licence for commercial use, separately for the data and for the videos. |
| **The online Israeli Sign Language dictionary** | Reference entries. | Being viewable online does **not** mean permission to copy or use commercially. |

Record every source on the entry (`sourceReference`) and the governing agreement (`licenseRef`). Changing `licenseRef` on a confirmed entry automatically resets `licenseStatus` to `pending` and unpublishes the entry.

## 2. The lexical model

The dictionary is **not** a `Hebrew word → animation file` table.

- **Concept** (`lexical_concepts`): a semantic unit to cover, such as `NEED`, `HELP` or `WHERE`, with Hebrew and English terms, a category and an editorial status. Concepts are a *planning inventory* and contain no sign data.
- **Sign entry** (`sign_entries`): a specific sign (form and meaning) linked to a concept. One concept can have several entries: regional or community variants, different senses, or grammatical forms.

> `conceptKey` is **not** an identifier of a hand movement.

| Field (API) | Purpose |
|---|---|
| `id`, `code` | Stable identifier, plus a human-readable code (`SG-0001`) |
| `conceptKey` | Semantic concept, e.g. `HELP` (must exist in the concept list) |
| `gloss` (`canonicalLabel`) | ISL gloss label, e.g. `NEED-HELP` |
| `label.he` / `hebrewTerms` | Hebrew words or phrases that may map to this entry |
| `label.en` / `englishTerms` | English equivalents |
| `senseDescription` | Precise meaning and context |
| `partOfSpeech` | noun, verb, adjective, adverb, pronoun, question, numeral, classifier, greeting, particle, other |
| `grammaticalFeatures` | Validated grammatical features only |
| `regionalVariants` | Documented, verified variants: `{ community, description, signEntryId? }` |
| `signDefinition` | Linguistic description of the sign's form |
| `nonManualMarkers` | **Lexical** markers that are part of the sign (facial expression, eyebrows, gaze, head, mouthing) |
| `dominantHand` | one_handed, two_handed_symmetric, two_handed_asymmetric, not_applicable |
| `isDefaultVariant` | Reviewer-chosen default among variants of one concept |
| `validationStatus`, `reviewerRef`, `reviewedAt` | Linguistic review state and the expert reviewer reference (required for approval) |
| `sourceReference`, `licenseRef`, `licenseStatus` | Provenance and licence |
| `version` | Incremented on every change; snapshots are kept in revisions |

Animations are separate assets (`animation_assets`) linked to entries, each with its own licence, approval status, version and checksum. See [ISL-PIPELINE.md](ISL-PIPELINE.md).

## 3. Starter concept inventory

Migration `0004` seeds **114 candidate concepts** in 10 categories:

| Category | Concepts |
|---|---|
| People & family | 15 |
| Greetings & courtesy | 9 |
| Actions | 14 |
| Questions | 9 |
| Feelings & states | 10 |
| Time | 13 |
| Places & transport | 11 |
| Health & help | 9 |
| Service & money | 10 |
| Descriptions & quantities | 14 |

They are **not** ISL translations. Each one needs a real ISL sign or structure, verified by experts and Deaf community signers, before anything is published. Track progress with:

- `GET /api/v1/admin/dictionary/coverage`: per category, the number of concepts with a published entry and with a renderable (animated) entry
- `GET /api/v1/admin/dictionary/concepts?category=&status=&coverage=missing|covered`
- `GET /api/v1/admin/dictionary/concepts/:key`: the concept and its entries

These are **lexical coverage** metrics. They are not a measure of translation quality.

## 4. Recommended build order

1. **Collect sources:** review ISL-LEX, the ISL corpus and the online dictionary, including licensing.
2. **Map concepts:** extend the concept list in Hebrew and English with sense descriptions and contexts (`POST/PATCH /admin/dictionary/concepts`).
3. **Verify signs:** create entries linked to concepts and take them through `draft → in_review → needs_expert → approved` (approval requires `reviewerRef`).
4. **Produce animations:** record or create animations under a suitable licence, including facial expressions and body movement. Upload them through single-use grants and approve each one once its licence is confirmed.
5. **Document variation:** record `regionalVariants` without assuming the whole community uses one form. When several published entries share a concept, mark one `isDefaultVariant`; otherwise the term is treated as ambiguous.
6. **Publish dictionary versions:** `POST /admin/dictionary/versions` snapshots every published entry.
7. **Build or connect the translation engine** only once verified data exists (`SIGN_PROVIDER=http`).
8. **Test with users:** measure comprehension, linguistic accuracy, sequence completeness and viewing comfort.

Meanwhile the emoji engine can ship as a working product, while sign output stays clearly labelled **experimental**.
