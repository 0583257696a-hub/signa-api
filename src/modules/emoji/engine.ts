import { CONCEPTS, type Concept } from './lexicon';

export type EmojiMode = 'emoji_only' | 'text_and_emoji';
export type EmojiStyle = 'minimal' | 'standard' | 'expressive';
export type EmojiLanguage = 'he' | 'en';

export interface EmojiTranslationInput {
  text: string;
  mode: EmojiMode;
  style: EmojiStyle;
  language: EmojiLanguage | 'auto';
  /** Deterministic alternative selection for "regenerate" (0 = default). */
  variant: number;
}

export interface EmojiTranslationOutput {
  /** The output for the requested mode — a plain, copyable Unicode string. */
  result: string;
  textWithEmoji: string;
  emojiOnly: string;
  emojis: string[];
  language: EmojiLanguage;
  matchedConcepts: number;
  /** Share of words that matched a lexicon concept (0..1). Not a measure of semantic accuracy. */
  coverage: number;
}

/** Replaceable engine contract (rule-based now; an AI-backed engine could implement it later). */
export interface EmojiEngine {
  readonly name: string;
  readonly version: string;
  translate(input: EmojiTranslationInput): Promise<EmojiTranslationOutput>;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
const NIQQUD = /[֑-ׇ]/g;
// C0/C1 controls (except \t \n), bidi overrides/isolates ("trojan source"), BOM, replacement char.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩﻿�]/g;

/** Cleans user input: NFC, strips unsafe/invisible control characters, normalizes newlines. */
export function normalizeInput(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').replace(UNSAFE_CHARS, '').trim();
}

export function detectLanguage(text: string): EmojiLanguage {
  const he = (text.match(/[א-ת]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  return he >= en ? 'he' : 'en';
}

const keyOf = (w: string) =>
  w.toLowerCase().replace(NIQQUD, '').replace(/[׳']/g, "'").replace(/[״"]/g, '"').replace(/^['"-]+|['"-]+$/g, '');

// ---------------------------------------------------------------------------
// Lexicon index
// ---------------------------------------------------------------------------
const INDEX = new Map<string, Concept>();
let MAX_PHRASE_WORDS = 1;
for (const c of CONCEPTS) {
  for (const term of [...c.he, ...c.en]) {
    const k = term.split(/\s+/).map(keyOf).join(' ');
    if (!INDEX.has(k)) INDEX.set(k, c);
    MAX_PHRASE_WORDS = Math.max(MAX_PHRASE_WORDS, k.split(' ').length);
  }
}

const HE_PREFIXES = ['וה', 'וב', 'ול', 'ומ', 'וש', 'שה', 'שב', 'של', 'כש', 'מה', 'בה', 'לה', 'ו', 'ה', 'ב', 'ל', 'מ', 'ש', 'כ'];
const NEGATIONS = new Set(['לא', 'אין', 'בלי', 'אינני', 'אינו', 'not', 'no', 'never', "don't", 'dont', "didn't", "isn't", "aren't", "won't", "can't", 'without']);

function lookupWord(k: string): Concept | undefined {
  const direct = INDEX.get(k);
  if (direct) return direct;
  if (/[א-ת]/.test(k)) {
    for (const p of HE_PREFIXES) {
      if (k.startsWith(p) && k.length - p.length >= 3) {
        const hit = INDEX.get(k.slice(p.length)) ?? suffixVariants(k.slice(p.length));
        if (hit) return hit;
      }
    }
    return suffixVariants(k);
  }
  // Light English stemming.
  for (const [suffix, repl] of [['ies', 'y'], ['es', ''], ['s', ''], ['ing', ''], ['ed', ''], ['ed', 'e'], ['ing', 'e']] as const) {
    if (k.endsWith(suffix) && k.length - suffix.length >= 3) {
      const hit = INDEX.get(k.slice(0, -suffix.length) + repl);
      if (hit) return hit;
    }
  }
  return undefined;
}

function suffixVariants(k: string): Concept | undefined {
  for (const [suffix, repls] of [['ים', ['', 'ה']], ['ות', ['ה', '']], ['ה', ['']]] as const) {
    if (k.endsWith(suffix) && k.length - suffix.length >= 2) {
      for (const r of repls) {
        const hit = INDEX.get(k.slice(0, -suffix.length) + r);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
interface Token {
  key: string;
  start: number;
  end: number;
}

interface Match {
  concept: Concept;
  start: number;
  end: number; // char offset after the last matched word
  sentence: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(/[\p{L}\p{M}\p{N}]+(?:['"׳״][\p{L}\p{M}\p{N}]+)*/gu)) {
    tokens.push({ key: keyOf(m[0]), start: m.index!, end: m.index! + m[0].length });
  }
  return tokens;
}

function sentenceBounds(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = /[^.!?\n…]+[.!?…]*\s*/g;
  for (const m of text.matchAll(re)) {
    const trimmedEnd = m.index! + m[0].trimEnd().length;
    if (trimmedEnd > m.index!) out.push({ start: m.index!, end: trimmedEnd });
  }
  return out.length ? out : [{ start: 0, end: text.length }];
}

function findMatches(text: string, tokens: Token[]): Match[] {
  const sentences = sentenceBounds(text);
  const sentenceOf = (offset: number) => Math.max(0, sentences.findIndex((s) => offset >= s.start && offset < s.end));
  const matches: Match[] = [];
  let negateUntil = -1;
  for (let i = 0; i < tokens.length; ) {
    const tok = tokens[i]!;
    if (NEGATIONS.has(tok.key)) {
      negateUntil = i + 2; // suppress the next concept within two words ("not happy", "לא טוב")
      i++;
      continue;
    }
    let matched: { concept: Concept; len: number } | undefined;
    for (let n = Math.min(MAX_PHRASE_WORDS, tokens.length - i); n >= 1 && !matched; n--) {
      const slice = tokens.slice(i, i + n);
      // Phrases must be contiguous (only whitespace between words).
      if (n > 1 && slice.some((t, j) => j > 0 && /[^\s]/.test(text.slice(slice[j - 1]!.end, t.start)))) continue;
      const key = slice.map((t) => t.key).join(' ');
      let concept = n === 1 ? lookupWord(key) : INDEX.get(key);
      if (!concept && n > 1) {
        // Allow a Hebrew prefix on the first word of a phrase ("ובוקר טוב").
        for (const p of HE_PREFIXES) {
          if (slice[0]!.key.startsWith(p) && slice[0]!.key.length - p.length >= 2) {
            concept = INDEX.get([slice[0]!.key.slice(p.length), ...slice.slice(1).map((t) => t.key)].join(' '));
            if (concept) break;
          }
        }
      }
      if (concept) matched = { concept, len: n };
    }
    if (matched) {
      const last = tokens[i + matched.len - 1]!;
      if (i > negateUntil) matches.push({ concept: matched.concept, start: tok.start, end: last.end, sentence: sentenceOf(tok.start) });
      i += matched.len;
    } else {
      i++;
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Style policies
// ---------------------------------------------------------------------------
const CAPS: Record<EmojiStyle, number> = { minimal: 3, standard: 6, expressive: 12 };

function pickEmoji(c: Concept, style: EmojiStyle, variant: number): string {
  if (style === 'expressive' && variant === 0 && c.expressive) return c.expressive;
  return c.emojis[variant % c.emojis.length]!;
}

interface Placed {
  emoji: string;
  insertAt: number;
  order: number;
}

function select(text: string, matches: Match[], style: EmojiStyle, variant: number): Placed[] {
  const placed: Placed[] = [];
  if (style === 'minimal') {
    const sentences = sentenceBounds(text);
    const best = new Map<number, Match>();
    for (const m of matches) {
      const cur = best.get(m.sentence);
      if (!cur || m.concept.weight > cur.concept.weight) best.set(m.sentence, m);
    }
    const seen = new Set<string>();
    for (const [sIdx, m] of [...best.entries()].sort((a, b) => a[0] - b[0])) {
      if (seen.has(m.concept.id) || placed.length >= CAPS.minimal) continue;
      seen.add(m.concept.id);
      placed.push({ emoji: pickEmoji(m.concept, style, variant), insertAt: sentences[sIdx]?.end ?? text.length, order: m.start });
    }
    return placed;
  }

  const seenConcepts = new Set<string>();
  const seenEmoji = new Set<string>();
  // Keep the highest-weight matches if over the cap, then restore reading order.
  const ranked = [...matches].sort((a, b) => b.concept.weight - a.concept.weight || a.start - b.start);
  const kept: Match[] = [];
  for (const m of ranked) {
    const conceptKey = style === 'expressive' ? `${m.sentence}:${m.concept.id}` : m.concept.id;
    if (seenConcepts.has(conceptKey)) continue;
    const e = pickEmoji(m.concept, style, variant);
    if (style === 'standard' && seenEmoji.has(e)) continue; // no repeated emoji in standard style
    seenConcepts.add(conceptKey);
    seenEmoji.add(e);
    kept.push(m);
    if (kept.length >= CAPS[style]) break;
  }
  kept.sort((a, b) => a.start - b.start);
  let prev = '';
  for (const m of kept) {
    const e = pickEmoji(m.concept, style, variant);
    if (e === prev) continue; // never the same emoji twice in a row
    prev = e;
    placed.push({ emoji: e, insertAt: afterPunctuation(text, m.end), order: m.start });
  }
  return placed;
}

/** Moves an insertion point past punctuation attached to the word ("שלום!" → after "!"). */
function afterPunctuation(text: string, pos: number): number {
  let p = pos;
  while (p < text.length && /[!?.,:;…)"'״׳\]]/.test(text[p]!)) p++;
  return p;
}

function render(text: string, placed: Placed[]): string {
  const byPos = new Map<number, string[]>();
  for (const p of placed) byPos.set(p.insertAt, [...(byPos.get(p.insertAt) ?? []), p.emoji]);
  let out = '';
  let cursor = 0;
  for (const pos of [...byPos.keys()].sort((a, b) => a - b)) {
    out += text.slice(cursor, pos) + ' ' + byPos.get(pos)!.join('');
    cursor = pos;
  }
  return out + text.slice(cursor);
}

export class RuleBasedEmojiEngine implements EmojiEngine {
  readonly name = 'rules';
  readonly version = '1.0.0';

  async translate(input: EmojiTranslationInput): Promise<EmojiTranslationOutput> {
    const text = normalizeInput(input.text);
    const language = input.language === 'auto' ? detectLanguage(text) : input.language;
    const tokens = tokenize(text);
    const matches = findMatches(text, tokens);
    const placed = select(text, matches, input.style, Math.max(0, Math.floor(input.variant)));
    const emojis = [...placed].sort((a, b) => a.order - b.order).map((p) => p.emoji);
    const textWithEmoji = render(text, placed);
    const emojiOnly = emojis.join('');
    const matchedWords = matches.reduce((n, m) => n + tokens.filter((t) => t.start >= m.start && t.end <= m.end).length, 0);
    return {
      result: input.mode === 'emoji_only' ? emojiOnly : textWithEmoji,
      textWithEmoji,
      emojiOnly,
      emojis,
      language,
      matchedConcepts: new Set(matches.map((m) => m.concept.id)).size,
      coverage: tokens.length ? Math.round((matchedWords / tokens.length) * 100) / 100 : 0,
    };
  }
}
