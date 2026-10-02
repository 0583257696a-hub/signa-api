/** Shapes returned by the Signa API (subset used by the UI). */
export type VerificationStatus = 'verified' | 'partially_verified' | 'experimental' | 'unsupported' | 'failed';
export type SegmentStatus = 'verified_sign' | 'fingerspelled' | 'unknown_sign' | 'missing_asset' | 'unsupported' | 'pause';

export interface Job {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'partially_completed' | 'failed' | 'cancelled' | 'expired';
  verificationStatus: VerificationStatus | null;
  failureCode: string | null;
  resultAvailable: boolean;
}

export interface Segment {
  index: number;
  kind: 'sign' | 'fingerspelling' | 'pause' | 'unsupported';
  status: SegmentStatus;
  gloss: string | null;
  signEntry: { id: string; code: string; label: string | null; conceptKey: string | null } | null;
  assets: { id: string; mimeType: string; durationMs: number | null; url: string | null }[];
  timing: { startMs: number; durationMs: number };
  sourceSpan: { start: number; end: number } | null;
  renderable: boolean;
}

export interface SignResult {
  jobId: string;
  engine: { name: string; version: string; validated: boolean };
  verificationStatus: VerificationStatus;
  segments: Segment[];
  missing: { index: number; reason: string }[];
  quality: { lexicalCoverage: number; renderable: boolean; totalDurationMs: number; segmentsTotal: number };
}

export interface EmojiResult {
  result: string;
  mode: 'emoji_only' | 'text_and_emoji';
  style: 'minimal' | 'standard' | 'expressive';
  language: 'he' | 'en';
  alternatives: { textAndEmoji: string; emojiOnly: string };
  emojis: string[];
  variant: number;
}
