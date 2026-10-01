import type { Services } from '../../context';
import { all, first, parseJson } from '../../lib/db';
import { publicAssetUrl, signedAssetUrl } from '../dictionary/asset-store';
import type {
  NonManualMarker,
  NormalizedSegment,
  NormalizedSignResult,
  OutputFormat,
  SegmentStatus,
  SignTranslationResult,
  VerificationStatus,
} from './types';

const DEFAULT_SIGN_MS = 800;
const DEFAULT_LETTER_MS = 400;
const PAUSE_MS = 300;

interface EntryRow {
  id: string;
  sign_code: string;
  canonical_label: string;
  label_he: string | null;
  concept_key: string | null;
  non_manual_markers_json: string;
}
interface AssetRow {
  id: string;
  sign_entry_id: string;
  mime_type: string;
  duration_ms: number | null;
  visibility: 'public' | 'private';
}

/** Fingerspelling letters are dictionary entries whose canonical label is `FS-<letter>`. */
const letterLabel = (letter: string) => `FS-${letter}`;

export async function currentDictionaryVersion(svc: Services): Promise<number | null> {
  return (await first<{ version: number }>(svc.db, 'SELECT MAX(version) AS version FROM dictionary_versions'))?.version ?? null;
}

/**
 * Validates a provider proposal against the approved dictionary and the animation
 * catalog and computes the verification status. Rules:
 *  - `verified` requires: a linguistically validated engine, every segment an approved,
 *    published sign with an approved animation asset, and nothing unsupported.
 *  - `partially_verified` (validated engine only): renderable, but some segments are
 *    fingerspelled or not covered by reviewed signs.
 *  - `experimental`: the engine is not validated, but at least one segment is renderable.
 *  - `unsupported`: nothing renderable, or the provider declined the input.
 */
export async function validateProposal(
  svc: Services,
  args: { jobId: string; text: string; outputFormat: OutputFormat; dictionaryVersion: number | null; proposal: SignTranslationResult; urlTtlMs: number },
): Promise<NormalizedSignResult> {
  const { proposal } = args;
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const s of proposal.segments) {
    if (s.kind === 'sign' && s.signEntryId) ids.add(s.signEntryId);
    if (s.kind === 'fingerspelling') for (const l of s.letters ?? []) labels.add(letterLabel(l));
  }

  // Only published entries are eligible (publication implies expert approval + confirmed licence — DB CHECK).
  const entries = new Map<string, EntryRow>();
  const byLabel = new Map<string, EntryRow>();
  if (ids.size || labels.size) {
    const rows = await all<EntryRow & { canonical_label: string }>(
      svc.db,
      `SELECT id, sign_code, canonical_label, label_he, concept_key, non_manual_markers_json FROM sign_entries
        WHERE publication_status = 'published'
          AND (id IN (SELECT value FROM json_each(?)) OR canonical_label IN (SELECT value FROM json_each(?)))`,
      JSON.stringify([...ids]),
      JSON.stringify([...labels]),
    );
    for (const r of rows) {
      entries.set(r.id, r);
      byLabel.set(r.canonical_label, r);
    }
  }
  const assetsByEntry = new Map<string, AssetRow[]>();
  if (entries.size) {
    const assets = await all<AssetRow>(
      svc.db,
      `SELECT id, sign_entry_id, mime_type, duration_ms, visibility FROM animation_assets
        WHERE approval_status = 'approved' AND sign_entry_id IN (SELECT value FROM json_each(?))
        ORDER BY asset_version DESC`,
      JSON.stringify([...entries.keys()]),
    );
    for (const a of assets) {
      const list = assetsByEntry.get(a.sign_entry_id) ?? [];
      if (list.length === 0) list.push(a); // latest approved version only
      assetsByEntry.set(a.sign_entry_id, list);
    }
  }

  const assetView = async (a: AssetRow) => ({
    id: a.id,
    mimeType: a.mime_type,
    durationMs: a.duration_ms,
    url: a.visibility === 'public' ? publicAssetUrl(svc, a.id) : await signedAssetUrl(svc, a.id, args.urlTtlMs),
  });

  const segments: NormalizedSegment[] = [];
  let cursor = 0;
  for (const [index, s] of proposal.segments.entries()) {
    let status: SegmentStatus;
    let entry: EntryRow | null = null;
    const assets: NormalizedSegment['assets'] = [];
    let duration = s.durationMs ?? 0;

    if (s.kind === 'pause') {
      status = 'pause';
      duration ||= PAUSE_MS;
    } else if (s.kind === 'unsupported') {
      status = 'unsupported';
    } else if (s.kind === 'sign') {
      entry = (s.signEntryId && entries.get(s.signEntryId)) || null;
      const asset = entry ? assetsByEntry.get(entry.id)?.[0] : undefined;
      if (!entry) status = 'unknown_sign';
      else if (!asset) status = 'missing_asset';
      else {
        status = 'verified_sign';
        assets.push(await assetView(asset));
        duration ||= asset.duration_ms ?? DEFAULT_SIGN_MS;
      }
    } else {
      const letters = s.letters ?? [];
      const letterAssets = letters.map((l) => {
        const e = byLabel.get(letterLabel(l));
        return e ? assetsByEntry.get(e.id)?.[0] : undefined;
      });
      if (letters.length === 0 || letterAssets.some((a) => !a)) status = 'missing_asset';
      else {
        status = 'fingerspelled';
        for (const a of letterAssets) assets.push(await assetView(a!));
        duration ||= letterAssets.reduce((n, a) => n + (a!.duration_ms ?? DEFAULT_LETTER_MS), 0);
      }
    }

    const renderable = status === 'verified_sign' || status === 'fingerspelled' || status === 'pause';
    segments.push({
      index,
      kind: s.kind,
      status,
      gloss: entry?.canonical_label ?? s.gloss ?? null,
      signEntry: entry ? { id: entry.id, code: entry.sign_code, label: entry.label_he, conceptKey: entry.concept_key } : null,
      assets,
      timing: { startMs: cursor, durationMs: renderable ? duration : 0 },
      // Lexical markers belong to the expert-approved sign itself.
      lexicalNonManualMarkers: status === 'verified_sign' && entry ? parseJson<NonManualMarker[]>(entry.non_manual_markers_json, []) : [],
      // Sentence-level markers are passed through only for renderable segments of a validated engine;
      // otherwise they would imply linguistic content nobody reviewed.
      nonManualMarkers: renderable && proposal.engineValidated ? (s.nonManualMarkers ?? []) : [],
      sourceSpan: s.sourceSpan && s.sourceSpan.end <= args.text.length && s.sourceSpan.start <= s.sourceSpan.end ? s.sourceSpan : null,
      renderable,
    });
    if (renderable) cursor += duration;
  }

  const content = segments.filter((s) => s.status !== 'pause');
  const verified = content.filter((s) => s.status === 'verified_sign').length;
  const fingerspelled = content.filter((s) => s.status === 'fingerspelled').length;
  const notRenderable = content.filter((s) => !s.renderable);
  const anyRenderable = content.some((s) => s.renderable);
  const allRenderable = content.length > 0 && notRenderable.length === 0;

  let status: VerificationStatus;
  if (proposal.unsupportedReason || content.length === 0 || !anyRenderable) status = 'unsupported';
  else if (!proposal.engineValidated) status = 'experimental';
  else if (allRenderable && verified === content.length) status = 'verified';
  else status = 'partially_verified';

  const coveredChars = content
    .filter((s) => s.status === 'verified_sign' && s.sourceSpan)
    .reduce((n, s) => n + args.text.slice(s.sourceSpan!.start, s.sourceSpan!.end).replace(/[^\p{L}\p{N}]/gu, '').length, 0);
  const letterChars = args.text.replace(/[^\p{L}\p{N}]/gu, '').length || 1;

  const notices: string[] = [];
  if (status === 'experimental') notices.push('engine_not_linguistically_validated');
  if (!proposal.engineValidated && anyRenderable) notices.push('segmentation_is_illustrative_not_isl_grammar');
  if (notRenderable.length) notices.push('some_segments_cannot_be_rendered');
  if (proposal.unsupportedReason) notices.push(`provider:${proposal.unsupportedReason}`);

  return {
    jobId: args.jobId,
    sourceLanguage: 'he',
    outputFormat: args.outputFormat,
    engine: { ...proposal.engine, validated: proposal.engineValidated },
    dictionaryVersion: args.dictionaryVersion,
    verificationStatus: status,
    segments,
    missing: notRenderable.map((s) => ({
      index: s.index,
      status: s.status,
      sourceSpan: s.sourceSpan,
      reason:
        s.status === 'unknown_sign'
          ? 'not_in_approved_dictionary'
          : s.status === 'missing_asset'
            ? 'no_approved_animation'
            : (proposal.segments[s.index]?.reason ?? 'unsupported_by_engine'),
    })),
    quality: {
      segmentsTotal: content.length,
      verifiedSegments: verified,
      fingerspelledSegments: fingerspelled,
      unsupportedSegments: notRenderable.length,
      lexicalCoverage: Math.min(1, Math.round((coveredChars / letterChars) * 100) / 100),
      renderable: allRenderable,
      totalDurationMs: cursor,
    },
    sourceTextStored: false,
    notices,
    createdAt: new Date(svc.now()).toISOString(),
  };
}
