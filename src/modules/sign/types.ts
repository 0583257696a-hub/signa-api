/**
 * ISL translation data model.
 *
 * Design notes:
 *  - ISL has its own grammar (word order, spatial reference, classifiers) and conveys
 *    meaning through NON-MANUAL markers (facial expression, eyebrows, gaze, head and
 *    body movement, mouthing). A segment therefore carries optional non-manual markers
 *    and a source span, rather than assuming a one-to-one word mapping.
 *  - A provider PROPOSES a representation. Signa VALIDATES it against the approved
 *    dictionary and animation catalog and computes the verification status itself.
 *    Providers cannot mark their own output as verified.
 */
export type VerificationStatus = 'verified' | 'partially_verified' | 'experimental' | 'unsupported' | 'failed';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'partially_completed' | 'failed' | 'cancelled' | 'expired';
export const TERMINAL_JOB_STATUSES: JobStatus[] = ['completed', 'partially_completed', 'failed', 'cancelled', 'expired'];

export type OutputFormat = 'avatar_sequence' | 'gloss';

export interface NonManualMarker {
  type: 'facial_expression' | 'eyebrows' | 'eye_gaze' | 'head_movement' | 'mouthing' | 'body_shift' | 'other';
  value: string;
  /** Offsets relative to the segment start. */
  startMs?: number;
  endMs?: number;
}

export interface SourceSpan {
  start: number;
  end: number;
}

/** A segment as proposed by a provider (untrusted until validated). */
export interface ProposedSegment {
  kind: 'sign' | 'fingerspelling' | 'pause' | 'unsupported';
  signEntryId?: string;
  gloss?: string;
  letters?: string[];
  durationMs?: number;
  sourceSpan?: SourceSpan;
  nonManualMarkers?: NonManualMarker[];
  reason?: string;
}

export interface SignTranslationInput {
  jobId: string;
  text: string;
  language: 'he';
  outputFormat: OutputFormat;
  dictionaryVersion: number | null;
}

export interface SignTranslationResult {
  engine: { name: string; version: string };
  /**
   * True only if the engine itself has passed linguistic validation by ISL experts
   * against an approved test set. Combined with SIGN_PROVIDER_VALIDATED config.
   */
  engineValidated: boolean;
  segments: ProposedSegment[];
  /** Set when the provider could not produce a representation (e.g. unsupported grammar). */
  unsupportedReason?: string;
}

export type SegmentStatus = 'verified_sign' | 'fingerspelled' | 'unknown_sign' | 'missing_asset' | 'unsupported' | 'pause';

export interface NormalizedSegment {
  index: number;
  kind: ProposedSegment['kind'];
  status: SegmentStatus;
  gloss: string | null;
  signEntry: { id: string; code: string; label: string | null; conceptKey: string | null } | null;
  assets: { id: string; mimeType: string; durationMs: number | null; url: string | null }[];
  timing: { startMs: number; durationMs: number };
  /** Lexical non-manual markers that are part of the approved sign itself (from the dictionary). */
  lexicalNonManualMarkers: NonManualMarker[];
  /** Sentence-level (grammatical) markers proposed by the engine — only from a validated engine. */
  nonManualMarkers: NonManualMarker[];
  sourceSpan: SourceSpan | null;
  renderable: boolean;
}

export interface NormalizedSignResult {
  jobId: string;
  sourceLanguage: 'he';
  outputFormat: OutputFormat;
  engine: { name: string; version: string; validated: boolean };
  dictionaryVersion: number | null;
  verificationStatus: VerificationStatus;
  segments: NormalizedSegment[];
  missing: { index: number; status: SegmentStatus; sourceSpan: SourceSpan | null; reason: string }[];
  /** Always false: Signa does not store the source text with the result. */
  sourceTextStored: false;
  quality: {
    segmentsTotal: number;
    verifiedSegments: number;
    fingerspelledSegments: number;
    unsupportedSegments: number;
    /**
     * LEXICAL coverage: share of source letters inside segments rendered with approved signs (0..1).
     * This is NOT a measure of linguistic correctness or translation quality.
     */
    lexicalCoverage: number;
    renderable: boolean;
    totalDurationMs: number;
  };
  notices: string[];
  createdAt: string;
}
