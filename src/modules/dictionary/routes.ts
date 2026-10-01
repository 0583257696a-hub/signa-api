import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, Services } from '../../context';
import { newId, randomToken, sha256Hex, timingSafeEqual } from '../../lib/crypto';
import { all, batch, first, parseJson, run, stmt } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { body, ok, page, PageQuery, query } from '../../lib/http';
import { iso, MINUTE } from '../../lib/time';
import { requirePlatformRole } from '../../middleware';
import { audit } from '../audit/service';
import { ALLOWED_ASSET_TYPES, publicAssetUrl, signedAssetUrl, verifyAssetSignature } from './asset-store';

export interface SignEntryRow {
  id: string;
  sign_code: string;
  canonical_label: string;
  label_he: string | null;
  label_en: string | null;
  concept_key: string | null;
  hebrew_terms_json: string;
  english_terms_json: string;
  sense_description: string | null;
  part_of_speech: string | null;
  grammatical_features_json: string;
  regional_variants_json: string;
  sign_definition: string | null;
  non_manual_markers_json: string;
  dominant_hand: string | null;
  source_reference: string | null;
  license_ref: string | null;
  is_default_variant: number;
  locale: string;
  validation_status: 'draft' | 'in_review' | 'needs_expert' | 'approved' | 'rejected';
  license_status: 'pending' | 'needs_source' | 'confirmed' | 'rejected';
  reviewer_ref: string | null;
  reviewed_at: number | null;
  publication_status: 'draft' | 'published' | 'unpublished';
  version: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface AssetRow {
  id: string;
  sign_entry_id: string;
  r2_key: string;
  mime_type: string;
  size_bytes: number | null;
  max_size_bytes: number;
  duration_ms: number | null;
  asset_version: number;
  license_json: string;
  attribution_text: string | null;
  approval_status: 'pending_upload' | 'uploaded' | 'approved' | 'rejected' | 'retired';
  visibility: 'private' | 'public';
  checksum_sha256: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const publicEntryView = (e: SignEntryRow) => ({
  id: e.id,
  code: e.sign_code,
  conceptKey: e.concept_key,
  gloss: e.canonical_label,
  label: { he: e.label_he, en: e.label_en },
  hebrewTerms: parseJson<string[]>(e.hebrew_terms_json, []),
  englishTerms: parseJson<string[]>(e.english_terms_json, []),
  senseDescription: e.sense_description,
  partOfSpeech: e.part_of_speech,
  grammaticalFeatures: parseJson(e.grammatical_features_json, {}),
  regionalVariants: parseJson(e.regional_variants_json, []),
  signDefinition: e.sign_definition,
  nonManualMarkers: parseJson(e.non_manual_markers_json, []),
  dominantHand: e.dominant_hand,
  isDefaultVariant: e.is_default_variant === 1,
  sourceReference: e.source_reference,
  licenseRef: e.license_ref,
  locale: e.locale,
  version: e.version,
  verification: 'expert_approved' as const,
  updatedAt: iso(e.updated_at),
});

const adminEntryView = (e: SignEntryRow) => ({
  ...publicEntryView(e),
  verification: e.validation_status,
  validationStatus: e.validation_status,
  licenseStatus: e.license_status,
  publicationStatus: e.publication_status,
  reviewerRef: e.reviewer_ref,
  reviewedAt: iso(e.reviewed_at),
  createdAt: iso(e.created_at),
});

const assetView = (a: AssetRow, url: string | null) => ({
  id: a.id,
  signEntryId: a.sign_entry_id,
  mimeType: a.mime_type,
  sizeBytes: a.size_bytes,
  durationMs: a.duration_ms,
  version: a.asset_version,
  license: parseJson(a.license_json, {}),
  attribution: a.attribution_text,
  url,
});

const adminAssetView = (a: AssetRow) => ({
  ...assetView(a, null),
  approvalStatus: a.approval_status,
  visibility: a.visibility,
  checksumSha256: a.checksum_sha256,
  createdAt: iso(a.created_at),
  updatedAt: iso(a.updated_at),
});

async function permittedAssetUrl(svc: Services, a: AssetRow) {
  return a.visibility === 'public' ? publicAssetUrl(svc, a.id) : signedAssetUrl(svc, a.id);
}

// ===========================================================================
// PUBLIC dictionary: published (expert-approved + licence-confirmed) data only.
// ===========================================================================
export const dictionaryRoutes = new Hono<AppEnv>();

dictionaryRoutes.get('/entries', async (c) => {
  const svc = c.get('services');
  const q = query(c, PageQuery.extend({ q: z.string().trim().max(100).optional() }));
  const rows = await all<SignEntryRow>(
    svc.db,
    `SELECT * FROM sign_entries WHERE publication_status = 'published'
        AND (?1 IS NULL OR instr(lower(canonical_label), lower(?1)) > 0 OR instr(label_he, ?1) > 0 OR instr(hebrew_terms_json, ?1) > 0
             OR instr(lower(label_en), lower(?1)) > 0 OR instr(lower(english_terms_json), lower(?1)) > 0)
      ORDER BY sign_code LIMIT ?2 OFFSET ?3`,
    q.q || null, q.limit + 1, q.cursor,
  );
  const p = page(rows, q.limit, q.cursor);
  return ok(c, { entries: p.items.map(publicEntryView), nextCursor: p.nextCursor });
});

dictionaryRoutes.get('/entries/:id', async (c) => {
  const svc = c.get('services');
  const e = await first<SignEntryRow>(svc.db, `SELECT * FROM sign_entries WHERE id = ? AND publication_status = 'published'`, c.req.param('id'));
  if (!e) throw new AppError('not_found');
  const assets = await all<AssetRow>(svc.db, `SELECT * FROM animation_assets WHERE sign_entry_id = ? AND approval_status = 'approved' ORDER BY asset_version DESC`, e.id);
  const views = [];
  for (const a of assets) views.push(assetView(a, await permittedAssetUrl(svc, a)));
  return ok(c, { entry: publicEntryView(e), assets: views });
});

dictionaryRoutes.get('/versions', async (c) => {
  const svc = c.get('services');
  const rows = await all<{ version: number; notes: string | null; entry_count: number; published_at: number }>(
    svc.db,
    'SELECT version, notes, entry_count, published_at FROM dictionary_versions ORDER BY version DESC LIMIT 100',
  );
  return ok(c, { versions: rows.map((r) => ({ version: r.version, notes: r.notes, entryCount: r.entry_count, publishedAt: iso(r.published_at) })) });
});

dictionaryRoutes.get('/versions/:version', async (c) => {
  const svc = c.get('services');
  const v = Number(c.req.param('version'));
  if (!Number.isInteger(v) || v < 1) throw new AppError('not_found');
  const ver = await first<{ id: string; version: number; notes: string | null; entry_count: number; published_at: number }>(svc.db, 'SELECT * FROM dictionary_versions WHERE version = ?', v);
  if (!ver) throw new AppError('not_found');
  const entries = await all<{ sign_entry_id: string; sign_entry_version: number; sign_code: string | null; canonical_label: string | null }>(
    svc.db,
    `SELECT dve.sign_entry_id, dve.sign_entry_version, e.sign_code, e.canonical_label FROM dictionary_version_entries dve
       LEFT JOIN sign_entries e ON e.id = dve.sign_entry_id WHERE dve.dictionary_version_id = ? ORDER BY e.sign_code`,
    ver.id,
  );
  return ok(c, {
    version: ver.version,
    notes: ver.notes,
    publishedAt: iso(ver.published_at),
    entries: entries.map((e) => ({ id: e.sign_entry_id, version: e.sign_entry_version, code: e.sign_code, gloss: e.canonical_label })),
  });
});

/** Asset delivery through the Worker: public approved assets, or private ones with a valid short-lived signature. */
export const assetContentRoutes = new Hono<AppEnv>();
assetContentRoutes.get('/:assetId/content', async (c) => {
  const svc = c.get('services');
  if (!svc.assetStore) throw new AppError('service_unavailable');
  const a = await first<AssetRow & { publication_status: string }>(
    svc.db,
    `SELECT a.*, e.publication_status FROM animation_assets a JOIN sign_entries e ON e.id = a.sign_entry_id
      WHERE a.id = ? AND a.approval_status = 'approved'`,
    c.req.param('assetId'),
  );
  if (!a) throw new AppError('not_found');
  const isPublic = a.visibility === 'public' && a.publication_status === 'published';
  if (!isPublic && !(await verifyAssetSignature(svc, a.id, c.req.query('exp'), c.req.query('sig')))) throw new AppError('not_found');
  const obj = await svc.assetStore.get(a.r2_key);
  if (!obj) throw new AppError('not_found');
  return new Response(obj.body, {
    headers: {
      'content-type': a.mime_type,
      'content-length': String(obj.size),
      etag: obj.etag,
      'cache-control': isPublic ? 'public, max-age=86400, immutable' : 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
    },
  });
});

// ===========================================================================
// ADMIN dictionary & asset management (platform role ≥ admin)
// ===========================================================================
export const adminDictionaryRoutes = new Hono<AppEnv>();
adminDictionaryRoutes.use('*', requirePlatformRole('admin'));

const NonManualMarkerSchema = z
  .object({
    type: z.enum(['facial_expression', 'eyebrows', 'eye_gaze', 'head_movement', 'mouthing', 'body_shift', 'other']),
    value: z.string().trim().min(1).max(100),
  })
  .strict();

const Terms = z.array(z.string().trim().min(1).max(100)).max(30);

const EntryFields = z
  .object({
    canonicalLabel: z.string().trim().min(1).max(100).regex(/^[A-Z0-9][A-Z0-9_\-:]*$/u, 'gloss_format'),
    conceptKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
    labelHe: z.string().trim().max(100).nullable(),
    labelEn: z.string().trim().max(100).nullable(),
    hebrewTerms: Terms,
    englishTerms: Terms,
    senseDescription: z.string().trim().max(2000).nullable(),
    partOfSpeech: z.enum(['noun', 'verb', 'adjective', 'adverb', 'pronoun', 'question', 'numeral', 'classifier', 'greeting', 'particle', 'other']).nullable(),
    grammaticalFeatures: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()])),
    regionalVariants: z
      .array(z.object({ community: z.string().trim().min(1).max(100), description: z.string().trim().max(500), signEntryId: z.string().max(40).optional() }).strict())
      .max(20),
    signDefinition: z.string().trim().max(2000).nullable(),
    nonManualMarkers: z.array(NonManualMarkerSchema).max(16),
    dominantHand: z.enum(['one_handed', 'two_handed_symmetric', 'two_handed_asymmetric', 'not_applicable']).nullable(),
    isDefaultVariant: z.boolean(),
    sourceReference: z.string().trim().max(500).nullable(),
    licenseRef: z.string().trim().max(200).nullable(),
    locale: z.string().max(10),
  })
  .partial();

type EntryInput = z.infer<typeof EntryFields>;

/**
 * API field → column. `linguistic` fields define the sign's form or meaning: changing them on
 * an approved entry sends it back to review. Changing `licenseRef` resets licence confirmation.
 */
const ENTRY_FIELDS: Record<keyof EntryInput, { column: string; kind: 'text' | 'json' | 'bool'; linguistic: boolean }> = {
  canonicalLabel: { column: 'canonical_label', kind: 'text', linguistic: true },
  conceptKey: { column: 'concept_key', kind: 'text', linguistic: true },
  labelHe: { column: 'label_he', kind: 'text', linguistic: true },
  labelEn: { column: 'label_en', kind: 'text', linguistic: false },
  hebrewTerms: { column: 'hebrew_terms_json', kind: 'json', linguistic: true },
  englishTerms: { column: 'english_terms_json', kind: 'json', linguistic: false },
  senseDescription: { column: 'sense_description', kind: 'text', linguistic: true },
  partOfSpeech: { column: 'part_of_speech', kind: 'text', linguistic: true },
  grammaticalFeatures: { column: 'grammatical_features_json', kind: 'json', linguistic: true },
  regionalVariants: { column: 'regional_variants_json', kind: 'json', linguistic: true },
  signDefinition: { column: 'sign_definition', kind: 'text', linguistic: true },
  nonManualMarkers: { column: 'non_manual_markers_json', kind: 'json', linguistic: true },
  dominantHand: { column: 'dominant_hand', kind: 'text', linguistic: true },
  isDefaultVariant: { column: 'is_default_variant', kind: 'bool', linguistic: true },
  sourceReference: { column: 'source_reference', kind: 'text', linguistic: false },
  licenseRef: { column: 'license_ref', kind: 'text', linguistic: false },
  locale: { column: 'locale', kind: 'text', linguistic: false },
};

function entryColumns(input: EntryInput): { columns: string[]; values: (string | number | null)[] } {
  const columns: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(input) as [keyof EntryInput, unknown][]) {
    if (value === undefined) continue;
    const f = ENTRY_FIELDS[key];
    columns.push(f.column);
    values.push(f.kind === 'json' ? JSON.stringify(value) : f.kind === 'bool' ? (value ? 1 : 0) : (value as string | null));
  }
  return { columns, values };
}

async function assertConceptExists(svc: Services, conceptKey: string | null | undefined) {
  if (conceptKey && !(await first(svc.db, 'SELECT concept_key FROM lexical_concepts WHERE concept_key = ?', conceptKey))) {
    throw new AppError('validation_error', { details: { issues: [{ path: 'conceptKey', code: 'unknown_concept' }] } });
  }
}

async function snapshotEntry(svc: Services, e: SignEntryRow, reason: string, actorId: string) {
  await run(
    svc.db,
    `INSERT INTO sign_entry_revisions (id, sign_entry_id, version, snapshot_json, change_reason, changed_by, created_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (sign_entry_id, version) DO NOTHING`,
    newId('rev'), e.id, e.version, JSON.stringify(e), reason, actorId, svc.now(),
  );
}

async function loadEntry(svc: Services, id: string): Promise<SignEntryRow> {
  const e = await first<SignEntryRow>(svc.db, 'SELECT * FROM sign_entries WHERE id = ?', id);
  if (!e) throw new AppError('not_found');
  return e;
}

const actor = (c: Context<AppEnv>) => c.get('auth')!.user;

adminDictionaryRoutes.get('/entries', async (c) => {
  const svc = c.get('services');
  const q = query(
    c,
    PageQuery.extend({
      q: z.string().trim().max(100).optional(),
      validationStatus: z.enum(['draft', 'in_review', 'needs_expert', 'approved', 'rejected']).optional(),
      publicationStatus: z.enum(['draft', 'published', 'unpublished']).optional(),
      conceptKey: z.string().max(64).optional(),
    }),
  );
  const rows = await all<SignEntryRow>(
    svc.db,
    `SELECT * FROM sign_entries
      WHERE (?1 IS NULL OR instr(lower(canonical_label), lower(?1)) > 0 OR instr(label_he, ?1) > 0 OR instr(hebrew_terms_json, ?1) > 0 OR instr(lower(sign_code), lower(?1)) > 0)
        AND (?2 IS NULL OR validation_status = ?2) AND (?3 IS NULL OR publication_status = ?3) AND (?6 IS NULL OR concept_key = ?6)
      ORDER BY sign_code LIMIT ?4 OFFSET ?5`,
    q.q || null, q.validationStatus ?? null, q.publicationStatus ?? null, q.limit + 1, q.cursor, q.conceptKey ?? null,
  );
  const p = page(rows, q.limit, q.cursor);
  return ok(c, { entries: p.items.map(adminEntryView), nextCursor: p.nextCursor });
});

adminDictionaryRoutes.post('/entries', async (c) => {
  const svc = c.get('services');
  const input = await body(c, EntryFields.required({ canonicalLabel: true }).strict());
  await assertConceptExists(svc, input.conceptKey);
  const now = svc.now();
  const next = ((await first<{ n: number }>(svc.db, `SELECT COALESCE(MAX(CAST(substr(sign_code, 4) AS INTEGER)), 0) AS n FROM sign_entries`))?.n ?? 0) + 1;
  const id = newId('sgn');
  const code = `SG-${String(next).padStart(4, '0')}`;
  const { columns, values } = entryColumns(input);
  await run(
    svc.db,
    `INSERT INTO sign_entries (id, sign_code, ${columns.join(', ')}, validation_status, license_status, publication_status, version, created_by, created_at, updated_at)
     VALUES (?, ?, ${columns.map(() => '?').join(', ')}, 'draft', 'pending', 'draft', 1, ?, ?, ?)`,
    id, code, ...values, actor(c).id, now, now,
  );
  await audit(svc, { action: 'dictionary.entry_created', actorUserId: actor(c).id, actorRole: actor(c).platform_role, targetType: 'sign_entry', targetId: id, requestId: c.get('requestId') });
  return ok(c, { entry: adminEntryView(await loadEntry(svc, id)) }, {}, 201);
});

adminDictionaryRoutes.get('/entries/:id', async (c) => {
  const svc = c.get('services');
  const e = await loadEntry(svc, c.req.param('id'));
  const assets = await all<AssetRow>(svc.db, 'SELECT * FROM animation_assets WHERE sign_entry_id = ? ORDER BY asset_version DESC', e.id);
  return ok(c, { entry: adminEntryView(e), assets: assets.map(adminAssetView) });
});

/**
 * Editing linguistic content of an approved entry invalidates its approval: it goes
 * back to `in_review` and is unpublished until re-approved. Every change is versioned.
 */
adminDictionaryRoutes.patch('/entries/:id', async (c) => {
  const svc = c.get('services');
  const input = await body(c, EntryFields.strict());
  const e = await loadEntry(svc, c.req.param('id'));
  await assertConceptExists(svc, input.conceptKey);
  const { columns, values } = entryColumns(input);
  if (columns.length === 0) return ok(c, { entry: adminEntryView(e) });
  await snapshotEntry(svc, e, 'before_edit', actor(c).id);
  const linguistic = (Object.keys(input) as (keyof EntryInput)[]).some((k) => input[k] !== undefined && ENTRY_FIELDS[k].linguistic);
  const resetApproval = linguistic && e.validation_status === 'approved';
  const resetLicense = input.licenseRef !== undefined && input.licenseRef !== e.license_ref && e.license_status === 'confirmed';
  const unpublish = (resetApproval || resetLicense) && e.publication_status === 'published';
  await run(
    svc.db,
    `UPDATE sign_entries SET ${columns.map((col) => `${col} = ?`).join(', ')},
       validation_status = ?, license_status = ?, publication_status = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    ...values,
    resetApproval ? 'in_review' : e.validation_status,
    resetLicense ? 'pending' : e.license_status,
    unpublish ? 'unpublished' : e.publication_status,
    svc.now(), e.id,
  );
  await audit(svc, { action: 'dictionary.entry_updated', actorUserId: actor(c).id, actorRole: actor(c).platform_role, targetType: 'sign_entry', targetId: e.id, requestId: c.get('requestId'), metadata: { approvalReset: resetApproval, licenseReset: resetLicense } });
  return ok(c, { entry: adminEntryView(await loadEntry(svc, e.id)) });
});

adminDictionaryRoutes.post('/entries/:id/review', async (c) => {
  const svc = c.get('services');
  const input = await body(
    c,
    z.object({ decision: z.enum(['in_review', 'needs_expert', 'approved', 'rejected']), reviewerRef: z.string().trim().min(2).max(100).optional() }).strict(),
  );
  // Approval must reference the ISL expert / review record that validated the sign.
  if (input.decision === 'approved' && !input.reviewerRef) {
    throw new AppError('validation_error', { details: { issues: [{ path: 'reviewerRef', code: 'required_for_approval' }] } });
  }
  const e = await loadEntry(svc, c.req.param('id'));
  await snapshotEntry(svc, e, `review:${input.decision}`, actor(c).id);
  const unpublish = input.decision !== 'approved' && e.publication_status === 'published';
  await run(
    svc.db,
    `UPDATE sign_entries SET validation_status = ?, reviewer_ref = ?, reviewed_at = ?, publication_status = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    input.decision, input.reviewerRef ?? e.reviewer_ref, svc.now(), unpublish ? 'unpublished' : e.publication_status, svc.now(), e.id,
  );
  await audit(svc, { action: 'dictionary.entry_reviewed', actorUserId: actor(c).id, actorRole: actor(c).platform_role, targetType: 'sign_entry', targetId: e.id, requestId: c.get('requestId'), metadata: { decision: input.decision } });
  return ok(c, { entry: adminEntryView(await loadEntry(svc, e.id)) });
});

adminDictionaryRoutes.post('/entries/:id/license', async (c) => {
  const svc = c.get('services');
  const input = await body(c, z.object({ status: z.enum(['pending', 'needs_source', 'confirmed', 'rejected']) }).strict());
  const e = await loadEntry(svc, c.req.param('id'));
  await snapshotEntry(svc, e, `license:${input.status}`, actor(c).id);
  const unpublish = input.status !== 'confirmed' && e.publication_status === 'published';
  await run(
    svc.db,
    'UPDATE sign_entries SET license_status = ?, publication_status = ?, version = version + 1, updated_at = ? WHERE id = ?',
    input.status, unpublish ? 'unpublished' : e.publication_status, svc.now(), e.id,
  );
  await audit(svc, { action: 'dictionary.entry_license_changed', actorUserId: actor(c).id, targetType: 'sign_entry', targetId: e.id, requestId: c.get('requestId'), metadata: { status: input.status } });
  return ok(c, { entry: adminEntryView(await loadEntry(svc, e.id)) });
});

adminDictionaryRoutes.post('/entries/:id/publish', async (c) => {
  const svc = c.get('services');
  const e = await loadEntry(svc, c.req.param('id'));
  if (e.validation_status !== 'approved' || e.license_status !== 'confirmed') {
    throw new AppError('conflict', { details: { reason: 'requires_expert_approval_and_confirmed_license', validationStatus: e.validation_status, licenseStatus: e.license_status } });
  }
  await run(svc.db, `UPDATE sign_entries SET publication_status = 'published', updated_at = ? WHERE id = ?`, svc.now(), e.id);
  await audit(svc, { action: 'dictionary.entry_published', actorUserId: actor(c).id, targetType: 'sign_entry', targetId: e.id, requestId: c.get('requestId') });
  return ok(c, { entry: adminEntryView(await loadEntry(svc, e.id)) });
});

adminDictionaryRoutes.post('/entries/:id/unpublish', async (c) => {
  const svc = c.get('services');
  const e = await loadEntry(svc, c.req.param('id'));
  await run(svc.db, `UPDATE sign_entries SET publication_status = 'unpublished', updated_at = ? WHERE id = ? AND publication_status = 'published'`, svc.now(), e.id);
  await audit(svc, { action: 'dictionary.entry_unpublished', actorUserId: actor(c).id, targetType: 'sign_entry', targetId: e.id, requestId: c.get('requestId') });
  return ok(c, { entry: adminEntryView(await loadEntry(svc, e.id)) });
});

adminDictionaryRoutes.get('/entries/:id/revisions', async (c) => {
  const svc = c.get('services');
  const rows = await all<{ version: number; change_reason: string; changed_by: string | null; created_at: number; snapshot_json: string }>(
    svc.db,
    'SELECT version, change_reason, changed_by, created_at, snapshot_json FROM sign_entry_revisions WHERE sign_entry_id = ? ORDER BY version DESC LIMIT 100',
    c.req.param('id'),
  );
  return ok(c, { revisions: rows.map((r) => ({ version: r.version, reason: r.change_reason, changedBy: r.changed_by, at: iso(r.created_at), snapshot: parseJson(r.snapshot_json, {}) })) });
});

/** Publishes an immutable dictionary version: a snapshot of all published entries at their current versions. */
adminDictionaryRoutes.post('/versions', async (c) => {
  const svc = c.get('services');
  const input = await body(c, z.object({ notes: z.string().trim().max(500).optional() }).strict());
  const entries = await all<{ id: string; version: number }>(svc.db, `SELECT id, version FROM sign_entries WHERE publication_status = 'published'`);
  const next = ((await first<{ v: number }>(svc.db, 'SELECT COALESCE(MAX(version), 0) AS v FROM dictionary_versions'))?.v ?? 0) + 1;
  const id = newId('dv');
  await batch(svc.db, [
    stmt(svc.db, 'INSERT INTO dictionary_versions (id, version, notes, entry_count, created_by, published_at) VALUES (?,?,?,?,?,?)', id, next, input.notes ?? null, entries.length, actor(c).id, svc.now()),
    ...entries.map((e) => stmt(svc.db, 'INSERT INTO dictionary_version_entries (dictionary_version_id, sign_entry_id, sign_entry_version) VALUES (?,?,?)', id, e.id, e.version)),
  ]);
  await audit(svc, { action: 'dictionary.version_published', actorUserId: actor(c).id, targetType: 'dictionary_version', targetId: id, requestId: c.get('requestId'), metadata: { version: next, entries: entries.length } });
  return ok(c, { version: next, entryCount: entries.length }, {}, 201);
});

// --- Lexical concepts ------------------------------------------------------
// Concepts are a planning inventory (what Signa should eventually cover). A concept is
// "covered" only through published entries; seeded concepts carry no sign data.
interface ConceptRow {
  concept_key: string;
  category: string;
  hebrew_terms_json: string;
  english_terms_json: string;
  sense_description: string | null;
  status: 'candidate' | 'in_progress' | 'deferred' | 'rejected';
  created_at: number;
  updated_at: number;
  entries: number;
  published_entries: number;
  published_with_animation: number;
}

const CONCEPT_COUNTS = `
  (SELECT COUNT(*) FROM sign_entries e WHERE e.concept_key = c.concept_key) AS entries,
  (SELECT COUNT(*) FROM sign_entries e WHERE e.concept_key = c.concept_key AND e.publication_status = 'published') AS published_entries,
  (SELECT COUNT(*) FROM sign_entries e WHERE e.concept_key = c.concept_key AND e.publication_status = 'published'
      AND EXISTS (SELECT 1 FROM animation_assets a WHERE a.sign_entry_id = e.id AND a.approval_status = 'approved')) AS published_with_animation`;

const conceptView = (r: ConceptRow) => ({
  conceptKey: r.concept_key,
  category: r.category,
  hebrewTerms: parseJson<string[]>(r.hebrew_terms_json, []),
  englishTerms: parseJson<string[]>(r.english_terms_json, []),
  senseDescription: r.sense_description,
  status: r.status,
  entries: r.entries,
  publishedEntries: r.published_entries,
  renderable: r.published_with_animation > 0,
  updatedAt: iso(r.updated_at),
});

const ConceptFields = z
  .object({
    category: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    hebrewTerms: Terms,
    englishTerms: Terms,
    senseDescription: z.string().trim().max(2000).nullable(),
    status: z.enum(['candidate', 'in_progress', 'deferred', 'rejected']),
  })
  .partial();

async function loadConcept(svc: Services, key: string): Promise<ConceptRow> {
  const r = await first<ConceptRow>(svc.db, `SELECT c.*, ${CONCEPT_COUNTS} FROM lexical_concepts c WHERE c.concept_key = ?`, key);
  if (!r) throw new AppError('not_found');
  return r;
}

adminDictionaryRoutes.get('/concepts', async (c) => {
  const svc = c.get('services');
  const q = query(
    c,
    PageQuery.extend({
      q: z.string().trim().max(100).optional(),
      category: z.string().max(40).optional(),
      status: z.enum(['candidate', 'in_progress', 'deferred', 'rejected']).optional(),
      coverage: z.enum(['missing', 'covered']).optional(),
    }),
  );
  const rows = await all<ConceptRow>(
    svc.db,
    `SELECT * FROM (SELECT c.*, ${CONCEPT_COUNTS} FROM lexical_concepts c) c
      WHERE (?1 IS NULL OR instr(c.concept_key, upper(?1)) > 0 OR instr(c.hebrew_terms_json, ?1) > 0 OR instr(lower(c.english_terms_json), lower(?1)) > 0)
        AND (?2 IS NULL OR c.category = ?2) AND (?3 IS NULL OR c.status = ?3)
        AND (?4 IS NULL OR (?4 = 'covered' AND c.published_with_animation > 0) OR (?4 = 'missing' AND c.published_with_animation = 0))
      ORDER BY c.category, c.concept_key LIMIT ?5 OFFSET ?6`,
    q.q || null, q.category ?? null, q.status ?? null, q.coverage ?? null, q.limit + 1, q.cursor,
  );
  const p = page(rows, q.limit, q.cursor);
  return ok(c, { concepts: p.items.map(conceptView), nextCursor: p.nextCursor });
});

adminDictionaryRoutes.get('/concepts/:key', async (c) => {
  const svc = c.get('services');
  const concept = await loadConcept(svc, c.req.param('key'));
  const entries = await all<SignEntryRow>(svc.db, 'SELECT * FROM sign_entries WHERE concept_key = ? ORDER BY sign_code', concept.concept_key);
  return ok(c, { concept: conceptView(concept), entries: entries.map(adminEntryView) });
});

adminDictionaryRoutes.post('/concepts', async (c) => {
  const svc = c.get('services');
  const input = await body(c, ConceptFields.required({ category: true }).extend({ conceptKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) }).strict());
  const now = svc.now();
  const inserted = await run(
    svc.db,
    `INSERT INTO lexical_concepts (concept_key, category, hebrew_terms_json, english_terms_json, sense_description, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (concept_key) DO NOTHING`,
    input.conceptKey, input.category, JSON.stringify(input.hebrewTerms ?? []), JSON.stringify(input.englishTerms ?? []),
    input.senseDescription ?? null, input.status ?? 'candidate', now, now,
  );
  if (!inserted) throw new AppError('conflict', { details: { reason: 'concept_exists' } });
  await audit(svc, { action: 'dictionary.concept_created', actorUserId: actor(c).id, targetType: 'concept', targetId: input.conceptKey, requestId: c.get('requestId') });
  return ok(c, { concept: conceptView(await loadConcept(svc, input.conceptKey)) }, {}, 201);
});

adminDictionaryRoutes.patch('/concepts/:key', async (c) => {
  const svc = c.get('services');
  const input = await body(c, ConceptFields.strict());
  const cur = await loadConcept(svc, c.req.param('key'));
  await run(
    svc.db,
    `UPDATE lexical_concepts SET category = ?, hebrew_terms_json = ?, english_terms_json = ?, sense_description = ?, status = ?, updated_at = ? WHERE concept_key = ?`,
    input.category ?? cur.category,
    input.hebrewTerms ? JSON.stringify(input.hebrewTerms) : cur.hebrew_terms_json,
    input.englishTerms ? JSON.stringify(input.englishTerms) : cur.english_terms_json,
    input.senseDescription !== undefined ? input.senseDescription : cur.sense_description,
    input.status ?? cur.status,
    svc.now(), cur.concept_key,
  );
  await audit(svc, { action: 'dictionary.concept_updated', actorUserId: actor(c).id, targetType: 'concept', targetId: cur.concept_key, requestId: c.get('requestId') });
  return ok(c, { concept: conceptView(await loadConcept(svc, cur.concept_key)) });
});

/** Lexical coverage by category — a planning metric, not a measure of translation quality. */
adminDictionaryRoutes.get('/coverage', async (c) => {
  const svc = c.get('services');
  const rows = await all<{ category: string; concepts: number; with_published_entry: number; renderable: number }>(
    svc.db,
    `SELECT c.category, COUNT(*) AS concepts,
            SUM(CASE WHEN c.published_entries > 0 THEN 1 ELSE 0 END) AS with_published_entry,
            SUM(CASE WHEN c.published_with_animation > 0 THEN 1 ELSE 0 END) AS renderable
       FROM (SELECT c.*, ${CONCEPT_COUNTS} FROM lexical_concepts c WHERE c.status <> 'rejected') c
      GROUP BY c.category ORDER BY c.category`,
  );
  const totals = rows.reduce((t, r) => ({ concepts: t.concepts + r.concepts, withPublishedEntry: t.withPublishedEntry + r.with_published_entry, renderable: t.renderable + r.renderable }), { concepts: 0, withPublishedEntry: 0, renderable: 0 });
  return ok(c, {
    categories: rows.map((r) => ({ category: r.category, concepts: r.concepts, withPublishedEntry: r.with_published_entry, renderable: r.renderable })),
    totals,
    note: 'lexical_coverage_only_not_translation_quality',
  });
});

// --- Animation assets ------------------------------------------------------
const LicenseSchema = z
  .object({
    licenseId: z.string().trim().min(1).max(100), // e.g. contract or licence identifier
    holder: z.string().trim().min(1).max(200),
    terms: z.string().trim().max(500).optional(),
    status: z.enum(['pending', 'confirmed', 'rejected']),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();

const UPLOAD_GRANT_TTL = 15 * MINUTE;

async function snapshotAsset(svc: Services, a: AssetRow, reason: string, actorId: string) {
  const rev = ((await first<{ r: number }>(svc.db, 'SELECT COALESCE(MAX(revision), 0) AS r FROM animation_asset_revisions WHERE asset_id = ?', a.id))?.r ?? 0) + 1;
  await run(
    svc.db,
    'INSERT INTO animation_asset_revisions (id, asset_id, revision, snapshot_json, change_reason, changed_by, created_at) VALUES (?,?,?,?,?,?,?)',
    newId('arv'), a.id, rev, JSON.stringify({ ...a, r2_key: undefined }), reason, actorId, svc.now(),
  );
}

async function loadAsset(svc: Services, id: string): Promise<AssetRow> {
  const a = await first<AssetRow>(svc.db, 'SELECT * FROM animation_assets WHERE id = ?', id);
  if (!a) throw new AppError('not_found');
  return a;
}

/** Registers asset metadata and returns a single-use, short-lived upload grant. */
adminDictionaryRoutes.post('/entries/:id/assets', async (c) => {
  const svc = c.get('services');
  const e = await loadEntry(svc, c.req.param('id'));
  const input = await body(
    c,
    z.object({
      mimeType: z.enum(Object.keys(ALLOWED_ASSET_TYPES) as [string, ...string[]]),
      durationMs: z.number().int().min(1).max(60_000).optional(),
      license: LicenseSchema,
      attributionText: z.string().trim().max(500).optional(),
    }).strict(),
  );
  const now = svc.now();
  const id = newId('ast');
  const version = ((await first<{ v: number }>(svc.db, 'SELECT COALESCE(MAX(asset_version), 0) AS v FROM animation_assets WHERE sign_entry_id = ?', e.id))?.v ?? 0) + 1;
  // Opaque, server-generated object key: no user-controlled path segments (no traversal).
  const r2Key = `animations/${randomToken(18)}`;
  const token = randomToken();
  await batch(svc.db, [
    stmt(
      svc.db,
      `INSERT INTO animation_assets (id, sign_entry_id, r2_key, mime_type, max_size_bytes, duration_ms, asset_version, license_json, attribution_text,
         approval_status, visibility, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?, 'pending_upload', 'private', ?, ?, ?)`,
      id, e.id, r2Key, input.mimeType, ALLOWED_ASSET_TYPES[input.mimeType]!.maxBytes, input.durationMs ?? null, version,
      JSON.stringify(input.license), input.attributionText ?? null, actor(c).id, now, now,
    ),
    stmt(svc.db, 'INSERT INTO asset_upload_grants (id, asset_id, token_hash, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)', newId('upg'), id, await sha256Hex(token), actor(c).id, now, now + UPLOAD_GRANT_TTL),
  ]);
  await audit(svc, { action: 'assets.registered', actorUserId: actor(c).id, targetType: 'animation_asset', targetId: id, requestId: c.get('requestId'), metadata: { signEntryId: e.id, mimeType: input.mimeType } });
  return ok(
    c,
    {
      asset: adminAssetView(await loadAsset(svc, id)),
      upload: { method: 'PUT', url: `${svc.config.API_BASE_URL}/api/v1/admin/dictionary/assets/${id}/upload`, header: 'X-Upload-Token', token, expiresAt: iso(now + UPLOAD_GRANT_TTL), maxBytes: ALLOWED_ASSET_TYPES[input.mimeType]!.maxBytes, contentType: input.mimeType },
    },
    {},
    201,
  );
});

adminDictionaryRoutes.put('/assets/:assetId/upload', async (c) => {
  const svc = c.get('services');
  if (!svc.assetStore) throw new AppError('service_unavailable');
  const a = await loadAsset(svc, c.req.param('assetId'));
  const token = c.req.header('x-upload-token') ?? '';
  const grant = await first<{ id: string; token_hash: string }>(
    svc.db,
    'SELECT id, token_hash FROM asset_upload_grants WHERE asset_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
    a.id, svc.now(),
  );
  if (!grant || !timingSafeEqual(await sha256Hex(token), grant.token_hash)) throw new AppError('forbidden', { details: { reason: 'invalid_upload_grant' } });
  if (a.approval_status !== 'pending_upload') throw new AppError('conflict', { details: { reason: 'already_uploaded' } });
  const ct = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (ct !== a.mime_type) throw new AppError('unsupported_media_type');
  const declared = Number(c.req.header('content-length') ?? 'NaN');
  if (!Number.isFinite(declared) || declared <= 0 || declared > a.max_size_bytes) throw new AppError('payload_too_large');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > a.max_size_bytes) throw new AppError('payload_too_large');
  if (!ALLOWED_ASSET_TYPES[a.mime_type]!.magic(bytes)) throw new AppError('unsupported_media_type', { details: { reason: 'content_does_not_match_type' } });
  const checksum = await sha256Hex(bytes);
  const claimed = await run(svc.db, 'UPDATE asset_upload_grants SET used_at = ? WHERE id = ? AND used_at IS NULL', svc.now(), grant.id);
  if (!claimed) throw new AppError('conflict');
  await svc.assetStore.put(a.r2_key, bytes, { contentType: a.mime_type, sha256: checksum });
  await run(svc.db, `UPDATE animation_assets SET approval_status = 'uploaded', size_bytes = ?, checksum_sha256 = ?, updated_at = ? WHERE id = ?`, bytes.byteLength, checksum, svc.now(), a.id);
  await audit(svc, { action: 'assets.uploaded', actorUserId: actor(c).id, targetType: 'animation_asset', targetId: a.id, requestId: c.get('requestId'), metadata: { sizeBytes: bytes.byteLength } });
  return ok(c, { asset: adminAssetView(await loadAsset(svc, a.id)) });
});

adminDictionaryRoutes.patch('/assets/:assetId', async (c) => {
  const svc = c.get('services');
  const input = await body(
    c,
    z.object({ durationMs: z.number().int().min(1).max(60_000), license: LicenseSchema, attributionText: z.string().trim().max(500).nullable(), visibility: z.enum(['private', 'public']) }).partial().strict(),
  );
  const a = await loadAsset(svc, c.req.param('assetId'));
  if (input.visibility === 'public' && a.approval_status !== 'approved') throw new AppError('conflict', { details: { reason: 'only_approved_assets_can_be_public' } });
  await snapshotAsset(svc, a, 'before_edit', actor(c).id);
  // A licence change sends an approved asset back for review.
  const licenseChanged = input.license !== undefined && JSON.stringify(input.license) !== a.license_json;
  const reReview = licenseChanged && a.approval_status === 'approved';
  await run(
    svc.db,
    `UPDATE animation_assets SET duration_ms = ?, license_json = ?, attribution_text = ?, visibility = ?, approval_status = ?, updated_at = ? WHERE id = ?`,
    input.durationMs ?? a.duration_ms,
    input.license ? JSON.stringify(input.license) : a.license_json,
    input.attributionText !== undefined ? input.attributionText : a.attribution_text,
    reReview ? 'private' : (input.visibility ?? a.visibility),
    reReview ? 'uploaded' : a.approval_status,
    svc.now(), a.id,
  );
  await audit(svc, { action: 'assets.updated', actorUserId: actor(c).id, targetType: 'animation_asset', targetId: a.id, requestId: c.get('requestId'), metadata: { licenseChanged } });
  return ok(c, { asset: adminAssetView(await loadAsset(svc, a.id)) });
});

adminDictionaryRoutes.post('/assets/:assetId/review', async (c) => {
  const svc = c.get('services');
  const { decision } = await body(c, z.object({ decision: z.enum(['approved', 'rejected', 'retired']) }).strict());
  const a = await loadAsset(svc, c.req.param('assetId'));
  if (decision === 'approved') {
    if (a.approval_status !== 'uploaded') throw new AppError('conflict', { details: { reason: 'asset_not_uploaded' } });
    if (parseJson<{ status?: string }>(a.license_json, {}).status !== 'confirmed') throw new AppError('conflict', { details: { reason: 'license_not_confirmed' } });
  }
  await snapshotAsset(svc, a, `review:${decision}`, actor(c).id);
  await run(
    svc.db,
    `UPDATE animation_assets SET approval_status = ?, visibility = CASE WHEN ? = 'approved' THEN visibility ELSE 'private' END, updated_at = ? WHERE id = ?`,
    decision, decision, svc.now(), a.id,
  );
  await audit(svc, { action: 'assets.reviewed', actorUserId: actor(c).id, targetType: 'animation_asset', targetId: a.id, requestId: c.get('requestId'), metadata: { decision } });
  return ok(c, { asset: adminAssetView(await loadAsset(svc, a.id)) });
});

adminDictionaryRoutes.get('/assets/:assetId/revisions', async (c) => {
  const svc = c.get('services');
  const rows = await all<{ revision: number; change_reason: string; changed_by: string | null; created_at: number; snapshot_json: string }>(
    svc.db,
    'SELECT revision, change_reason, changed_by, created_at, snapshot_json FROM animation_asset_revisions WHERE asset_id = ? ORDER BY revision DESC LIMIT 100',
    c.req.param('assetId'),
  );
  return ok(c, { revisions: rows.map((r) => ({ revision: r.revision, reason: r.change_reason, changedBy: r.changed_by, at: iso(r.created_at), snapshot: parseJson(r.snapshot_json, {}) })) });
});
