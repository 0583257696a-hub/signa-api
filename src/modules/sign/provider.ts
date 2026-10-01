import { z } from 'zod';
import type { Services } from '../../context';
import { all } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { selectCandidate, type LexicalCandidate } from './candidates';
import type { ProposedSegment, SignTranslationInput, SignTranslationResult } from './types';

/** Translation engine contract. Implementations must never fabricate dictionary or asset IDs. */
export interface SignTranslationProvider {
  readonly name: string;
  translate(input: SignTranslationInput): Promise<SignTranslationResult>;
  health(): Promise<{ status: 'ok' | 'degraded' | 'not_configured' }>;
}

/** No engine configured: every request is explicitly `unsupported`. */
export class NoSignProvider implements SignTranslationProvider {
  readonly name = 'none';
  async translate(): Promise<SignTranslationResult> {
    return { engine: { name: 'none', version: '0' }, engineValidated: false, segments: [], unsupportedReason: 'no_translation_engine_configured' };
  }
  async health() {
    return { status: 'not_configured' as const };
  }
}

/**
 * DEVELOPMENT / EXPERIMENTAL adapter.
 *
 * Looks up Hebrew terms of published, approved entries (label + `hebrew_terms`), longest
 * match first, preserving source order, and picks an entry per term with
 * `selectCandidate` — an ambiguous term (several eligible entries, no reviewer-chosen
 * default) becomes an explicit `unsupported` segment rather than a guess.
 *
 * This is NOT a translation into ISL grammar: Hebrew word order is kept and no sentence
 * analysis (questions, negation, time, spatial reference, grammatical non-manual markers)
 * is performed. It therefore always reports engineValidated = false, which caps results
 * at `experimental`. It only references entries that exist in the approved dictionary.
 */
export class DictionaryLookupProvider implements SignTranslationProvider {
  readonly name = 'dictionary-lookup';
  constructor(private readonly db: D1Database) {}

  async translate(input: SignTranslationInput): Promise<SignTranslationResult> {
    const entries = await all<{
      id: string;
      label_he: string | null;
      hebrew_terms_json: string;
      canonical_label: string;
      concept_key: string | null;
      is_default_variant: number;
      has_asset: number;
    }>(
      this.db,
      `SELECT e.id, e.label_he, e.hebrew_terms_json, e.canonical_label, e.concept_key, e.is_default_variant,
              EXISTS (SELECT 1 FROM animation_assets a WHERE a.sign_entry_id = e.id AND a.approval_status = 'approved') AS has_asset
         FROM sign_entries e
        WHERE e.publication_status = 'published' AND e.validation_status = 'approved' AND e.license_status = 'confirmed'`,
    );
    const index = new Map<string, Indexed[]>();
    let maxWords = 1;
    for (const e of entries) {
      const terms = new Set([e.label_he, ...safeArray(e.hebrew_terms_json)].filter((l): l is string => !!l).map(normalizeHe).filter(Boolean));
      for (const k of terms) {
        const list = index.get(k) ?? [];
        list.push({
          gloss: e.canonical_label,
          candidate: {
            entryId: e.id,
            conceptKey: e.concept_key,
            // No context model here: every sense of a term fits equally well, so genuinely
            // different senses tie and are reported as ambiguous.
            contextMatch: 1,
            linguisticValidation: 'verified',
            animationAvailable: e.has_asset === 1,
            isDefaultVariant: e.is_default_variant === 1,
          },
        });
        index.set(k, list);
        maxWords = Math.max(maxWords, k.split(' ').length);
      }
    }
    const tokens = [...input.text.matchAll(/[\p{L}\p{M}\p{N}]+(?:['"׳״][\p{L}\p{M}\p{N}]+)*/gu)].map((m) => ({
      key: normalizeHe(m[0]),
      start: m.index!,
      end: m.index! + m[0].length,
    }));
    if (tokens.length === 0) {
      return { engine: { name: this.name, version: '1.1.0' }, engineValidated: false, segments: [], unsupportedReason: 'no_words' };
    }
    const segments: ProposedSegment[] = [];
    for (let i = 0; i < tokens.length; ) {
      let hit: { list: Indexed[]; len: number } | undefined;
      for (let n = Math.min(maxWords, tokens.length - i); n >= 1 && !hit; n--) {
        const key = tokens.slice(i, i + n).map((t) => t.key).join(' ');
        const found = index.get(key) ?? (n === 1 ? stripPrefix(key, index) : undefined);
        if (found) hit = { list: found, len: n };
      }
      const span = { start: tokens[i]!.start, end: tokens[i + (hit?.len ?? 1) - 1]!.end };
      if (!hit) {
        segments.push({ kind: 'unsupported', sourceSpan: span, reason: 'no_approved_sign' });
        i++;
        continue;
      }
      const choice = selectCandidate(hit.list.map((x) => x.candidate));
      if (choice.kind === 'selected') {
        const gloss = hit.list.find((x) => x.candidate.entryId === choice.candidate.entryId)!.gloss;
        segments.push({ kind: 'sign', signEntryId: choice.candidate.entryId, gloss, sourceSpan: span });
      } else {
        segments.push({ kind: 'unsupported', sourceSpan: span, reason: choice.kind === 'ambiguous' ? 'ambiguous_term' : 'no_animation_available' });
      }
      i += hit.len;
    }
    return { engine: { name: this.name, version: '1.1.0' }, engineValidated: false, segments };
  }

  async health() {
    return { status: 'ok' as const };
  }
}

interface Indexed {
  gloss: string;
  candidate: LexicalCandidate;
}

const normalizeHe = (s: string) => s.toLowerCase().replace(/[֑-ׇ]/g, '').replace(/[^\p{L}\p{N}\s'"׳״]/gu, '').trim().replace(/\s+/g, ' ');
const safeArray = (json: string): string[] => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
function stripPrefix<T>(key: string, index: Map<string, T>): T | undefined {
  for (const p of ['ו', 'ה', 'ב', 'ל', 'מ', 'ש', 'כ']) {
    if (key.startsWith(p) && key.length - p.length >= 2) {
      const hit = index.get(key.slice(p.length));
      if (hit) return hit;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// External engine adapter (HTTP). The response is treated as untrusted input.
// ---------------------------------------------------------------------------
const MarkerSchema = z.object({
  type: z.enum(['facial_expression', 'eyebrows', 'eye_gaze', 'head_movement', 'mouthing', 'body_shift', 'other']),
  value: z.string().max(100),
  startMs: z.number().int().min(0).max(600_000).optional(),
  endMs: z.number().int().min(0).max(600_000).optional(),
});
const ProviderResponseSchema = z.object({
  engine: z.object({ name: z.string().max(60), version: z.string().max(40) }),
  validated: z.boolean().default(false),
  unsupportedReason: z.string().max(100).optional(),
  segments: z
    .array(
      z.object({
        kind: z.enum(['sign', 'fingerspelling', 'pause', 'unsupported']),
        signEntryId: z.string().max(64).optional(),
        gloss: z.string().max(100).optional(),
        letters: z.array(z.string().max(4)).max(64).optional(),
        durationMs: z.number().int().min(0).max(60_000).optional(),
        sourceSpan: z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }).optional(),
        nonManualMarkers: z.array(MarkerSchema).max(16).optional(),
        reason: z.string().max(100).optional(),
      }),
    )
    .max(500),
});

export class HttpSignProvider implements SignTranslationProvider {
  readonly name = 'http';
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly configValidated: boolean,
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  async translate(input: SignTranslationInput): Promise<SignTranslationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, 'idempotency-key': input.jobId },
        body: JSON.stringify({ text: input.text, language: input.language, outputFormat: input.outputFormat, dictionaryVersion: input.dictionaryVersion }),
        signal: controller.signal,
      });
      if (!res.ok) throw new AppError('provider_error', { message: `sign provider status ${res.status}` });
      const parsed = ProviderResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new AppError('provider_error', { message: 'sign provider returned an invalid payload' });
      const r = parsed.data;
      return {
        engine: r.engine,
        // Both the operator (config) and the engine must assert validation.
        engineValidated: this.configValidated && r.validated,
        segments: r.segments as ProposedSegment[],
        ...(r.unsupportedReason ? { unsupportedReason: r.unsupportedReason } : {}),
      };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('provider_error', { message: e instanceof Error && e.name === 'AbortError' ? 'sign provider timeout' : 'sign provider request failed' });
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    return { status: 'ok' as const };
  }
}

export function createSignProvider(svc: Pick<Services, 'config' | 'db' | 'fetch'>): SignTranslationProvider {
  const c = svc.config;
  if (c.SIGN_PROVIDER === 'http') return new HttpSignProvider(c.SIGN_PROVIDER_URL!, c.SIGN_PROVIDER_API_KEY!, c.SIGN_PROVIDER_VALIDATED, svc.fetch);
  if (c.SIGN_PROVIDER === 'dictionary_lookup') return new DictionaryLookupProvider(svc.db);
  return new NoSignProvider();
}
