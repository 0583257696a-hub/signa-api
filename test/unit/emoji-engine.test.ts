import { describe, expect, it } from 'vitest';
import { RuleBasedEmojiEngine, normalizeInput } from '../../src/modules/emoji/engine';

const engine = new RuleBasedEmojiEngine();
const t = (text: string, style: 'minimal' | 'standard' | 'expressive' = 'standard', mode: 'emoji_only' | 'text_and_emoji' = 'text_and_emoji', variant = 0) =>
  engine.translate({ text, mode, style, language: 'auto', variant });

describe('RuleBasedEmojiEngine', () => {
  it('translates the Hebrew greeting from the design', async () => {
    const r = await t('שלום! אני שמח לראות אותך');
    expect(r.language).toBe('he');
    expect(r.textWithEmoji).toBe('שלום! 👋 אני שמח 😊 לראות אותך 🤗');
    expect(r.emojiOnly).toBe('👋😊🤗');
    expect(r.result).toBe(r.textWithEmoji);
  });

  it('preserves the original text in text_and_emoji mode', async () => {
    const input = 'Thank you so much, see you tomorrow!';
    const r = await t(input);
    expect(r.textWithEmoji.replace(/ ?\p{Extended_Pictographic}[\u{FE0F}\u{200D}\p{Extended_Pictographic}]*/gu, '')).toBe(input);
  });

  it('returns emoji only output', async () => {
    const r = await t('I love pizza and coffee', 'standard', 'emoji_only');
    expect(r.result).toBe('❤️🍕☕');
  });

  it('handles Hebrew prefixes and plural suffixes', async () => {
    const r = await t('והחתולים ישנים בבית', 'standard', 'emoji_only');
    expect(r.emojis).toContain('🐱');
    expect(r.emojis).toContain('🏠');
  });

  it('suppresses negated concepts', async () => {
    const r = await t('אני לא שמח', 'standard', 'emoji_only');
    expect(r.emojis).not.toContain('😊');
    const e = await t('I am not happy', 'standard', 'emoji_only');
    expect(e.emojis).not.toContain('😊');
  });

  it('minimal style uses at most one emoji per sentence at its end', async () => {
    const r = await t('שלום! אני שמח לראות אותך', 'minimal');
    expect(r.emojis.length).toBeLessThanOrEqual(2);
    expect(r.textWithEmoji.startsWith('שלום! 👋')).toBe(true);
  });

  it('does not repeat emojis excessively', async () => {
    const r = await t('happy happy happy happy happy', 'standard', 'emoji_only');
    expect(r.emojis).toEqual(['😊']);
    const x = await t('happy happy happy. happy!', 'expressive', 'emoji_only');
    expect(x.emojis.length).toBeLessThanOrEqual(2);
  });

  it('is deterministic and supports variants', async () => {
    const a = await t('שלום תודה');
    const b = await t('שלום תודה');
    expect(a).toEqual(b);
    const v = await t('שלום תודה', 'standard', 'text_and_emoji', 1);
    expect(v.textWithEmoji).not.toBe(a.textWithEmoji);
  });

  it('returns no emoji (not invented ones) when nothing matches', async () => {
    const r = await t('qwerty zxcv', 'standard', 'emoji_only');
    expect(r.result).toBe('');
    expect(r.matchedConcepts).toBe(0);
  });

  it('strips control and bidi override characters', () => {
    expect(normalizeInput('  he‮llo\u0000 ')).toBe('hello');
  });
});
