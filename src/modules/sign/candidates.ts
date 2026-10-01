/**
 * Lexical candidate selection (one Hebrew term → one dictionary entry).
 *
 * Only expert-verified entries with an available approved animation are eligible.
 * If the best two candidates are too close to call, NO entry is chosen: an ambiguous
 * term is reported as unresolved instead of guessed.
 *
 * This selects a lexical entry only. It does not translate a sentence, and a confident
 * choice for every word does not by itself produce a correct ISL sentence.
 */
export interface LexicalCandidate {
  entryId: string;
  conceptKey: string | null;
  /** 0..1 — how well the entry's sense fits the context. */
  contextMatch: number;
  linguisticValidation: 'verified' | 'unreviewed';
  animationAvailable: boolean;
  /** Marked by reviewers as the default form among variants of the same concept. */
  isDefaultVariant?: boolean;
}

export type CandidateSelection =
  | { kind: 'selected'; candidate: LexicalCandidate }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidateCount: number };

export const AMBIGUITY_MARGIN = 0.05;

export function selectCandidate(candidates: LexicalCandidate[], margin = AMBIGUITY_MARGIN): CandidateSelection {
  const eligible = candidates.filter((c) => c.linguisticValidation === 'verified' && c.animationAvailable);
  if (eligible.length === 0) return { kind: 'none' };

  const sorted = [...eligible].sort((a, b) => b.contextMatch - a.contextMatch);
  const best = sorted[0]!;
  const tied = sorted.filter((c) => best.contextMatch - c.contextMatch < margin);
  if (tied.length === 1) return { kind: 'selected', candidate: best };

  // A tie between regional/community variants of ONE concept may be resolved only by
  // an explicit reviewer-chosen default. A tie across different concepts never is.
  const concepts = new Set(tied.map((c) => c.conceptKey ?? `entry:${c.entryId}`));
  if (concepts.size === 1) {
    const defaults = tied.filter((c) => c.isDefaultVariant);
    if (defaults.length === 1) return { kind: 'selected', candidate: defaults[0]! };
  }
  return { kind: 'ambiguous', candidateCount: tied.length };
}
