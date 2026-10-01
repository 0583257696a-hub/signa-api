import { describe, expect, it } from 'vitest';
import { selectCandidate, type LexicalCandidate } from '../../src/modules/sign/candidates';
import { Client, createHarness, seedSign, signUp } from '../helpers/harness';

const cand = (o: Partial<LexicalCandidate> & { entryId: string }): LexicalCandidate => ({
  conceptKey: 'X',
  contextMatch: 1,
  linguisticValidation: 'verified',
  animationAvailable: true,
  ...o,
});

describe('selectCandidate', () => {
  it('only considers verified entries with an animation', () => {
    expect(selectCandidate([cand({ entryId: 'a', linguisticValidation: 'unreviewed' }), cand({ entryId: 'b', animationAvailable: false })])).toEqual({ kind: 'none' });
  });

  it('picks the clear best match', () => {
    const r = selectCandidate([cand({ entryId: 'a', contextMatch: 0.9 }), cand({ entryId: 'b', contextMatch: 0.6 })]);
    expect(r).toMatchObject({ kind: 'selected', candidate: { entryId: 'a' } });
  });

  it('refuses to guess when candidates are within the ambiguity margin', () => {
    const r = selectCandidate([cand({ entryId: 'a', conceptKey: 'BANK_MONEY', contextMatch: 0.8 }), cand({ entryId: 'b', conceptKey: 'BANK_RIVER', contextMatch: 0.78 })]);
    expect(r).toEqual({ kind: 'ambiguous', candidateCount: 2 });
  });

  it('resolves ties between variants of one concept only via a reviewer-chosen default', () => {
    const a = cand({ entryId: 'a', conceptKey: 'HELLO' });
    const b = cand({ entryId: 'b', conceptKey: 'HELLO' });
    expect(selectCandidate([a, b]).kind).toBe('ambiguous');
    expect(selectCandidate([a, { ...b, isDefaultVariant: true }])).toMatchObject({ kind: 'selected', candidate: { entryId: 'b' } });
    // A default never wins across different concepts.
    expect(selectCandidate([cand({ entryId: 'c', conceptKey: 'OTHER' }), { ...b, isDefaultVariant: true }]).kind).toBe('ambiguous');
  });
});

describe('lexical dictionary model', () => {
  it('seeds candidate concepts without creating any sign data', async () => {
    const h = createHarness();
    expect(h.d1.q('SELECT COUNT(*) AS n FROM lexical_concepts')[0]!.n).toBe(114);
    expect(h.d1.q(`SELECT COUNT(*) AS n FROM lexical_concepts WHERE status <> 'candidate'`)[0]!.n).toBe(0);
    expect(h.d1.q('SELECT COUNT(*) AS n FROM sign_entries')[0]!.n).toBe(0);
    const admin = await signUp(h, { role: 'admin' });
    const cov = await admin.client.get('/api/v1/admin/dictionary/coverage');
    expect(cov.body.data.totals).toEqual({ concepts: 114, withPublishedEntry: 0, renderable: 0 });
    expect(cov.body.data.note).toBe('lexical_coverage_only_not_translation_quality');
    const help = await admin.client.get('/api/v1/admin/dictionary/concepts?category=health_help&coverage=missing&limit=100');
    expect(help.body.data.concepts.map((c: { conceptKey: string }) => c.conceptKey)).toContain('HELP');
  });

  it('stores the full lexical entry schema and validates concept links', async () => {
    const h = createHarness();
    const admin = await signUp(h, { role: 'admin' });
    const base = '/api/v1/admin/dictionary';
    expect((await admin.client.post(`${base}/entries`, { canonicalLabel: 'HELP', conceptKey: 'NO_SUCH_CONCEPT' })).status).toBe(422);
    const r = await admin.client.post(`${base}/entries`, {
      canonicalLabel: 'NEED-HELP',
      conceptKey: 'HELP',
      labelHe: 'עזרה',
      hebrewTerms: ['לעזור', 'צריך עזרה'],
      englishTerms: ['help'],
      senseDescription: 'Request for assistance',
      partOfSpeech: 'noun',
      grammaticalFeatures: { directional: true },
      regionalVariants: [{ community: 'north', description: 'documented variant' }],
      signDefinition: 'linguistic description of the form',
      nonManualMarkers: [{ type: 'eyebrows', value: 'raised' }],
      dominantHand: 'two_handed_asymmetric',
      sourceReference: 'elicitation session 12',
      licenseRef: 'AGR-2026-01',
    });
    expect(r.status).toBe(201);
    expect(r.body.data.entry).toMatchObject({
      conceptKey: 'HELP',
      hebrewTerms: ['לעזור', 'צריך עזרה'],
      partOfSpeech: 'noun',
      nonManualMarkers: [{ type: 'eyebrows', value: 'raised' }],
      dominantHand: 'two_handed_asymmetric',
      validationStatus: 'draft',
    });
    const concept = await admin.client.get(`${base}/concepts/HELP`);
    expect(concept.body.data.concept).toMatchObject({ entries: 1, publishedEntries: 0, renderable: false });
    expect(concept.body.data.entries).toHaveLength(1);
  });

  it('resets licence confirmation and unpublishes when the licence reference changes', async () => {
    const h = createHarness();
    const admin = await signUp(h, { role: 'admin' });
    const id = seedSign(h, { code: 'SG-0001', gloss: 'HELLO', labelHe: 'שלום', conceptKey: 'HELLO' });
    const r = await admin.client.patch(`/api/v1/admin/dictionary/entries/${id}`, { licenseRef: 'NEW-AGREEMENT' });
    expect(r.body.data.entry).toMatchObject({ licenseStatus: 'pending', publicationStatus: 'unpublished', validationStatus: 'approved' });
    // Non-linguistic edits keep expert approval.
    const id2 = seedSign(h, { code: 'SG-0002', gloss: 'I', labelHe: 'אני' });
    const r2 = await admin.client.patch(`/api/v1/admin/dictionary/entries/${id2}`, { englishTerms: ['I', 'me'] });
    expect(r2.body.data.entry).toMatchObject({ validationStatus: 'approved', publicationStatus: 'published' });
  });
});

describe('ISL lookup with candidate selection', () => {
  const translateAndGet = async (h: ReturnType<typeof createHarness>, c: Client, text: string) => {
    const job = (await c.post('/api/v1/sign/translate', { text })).body.data.job;
    return (await c.get(`/api/v1/sign/jobs/${job.id}/result`)).body.data.result;
  };

  it('marks an ambiguous term as unsupported instead of guessing', async () => {
    const h = createHarness({ withQueue: false });
    seedSign(h, { code: 'SG-0001', gloss: 'HELLO', labelHe: 'שלום', conceptKey: 'HELLO' });
    seedSign(h, { code: 'SG-0002', gloss: 'PEACE', labelHe: 'שלום' });
    const { client } = await signUp(h);
    const r = await translateAndGet(h, client, 'שלום');
    expect(r.verificationStatus).toBe('unsupported');
    expect(r.missing).toEqual([{ index: 0, status: 'unsupported', sourceSpan: { start: 0, end: 4 }, reason: 'ambiguous_term' }]);
  });

  it('uses the reviewer-chosen default among variants and returns lexical non-manual markers', async () => {
    const h = createHarness({ withQueue: false });
    seedSign(h, { code: 'SG-0001', gloss: 'HELLO', labelHe: 'שלום', conceptKey: 'HELLO' });
    const preferred = seedSign(h, { code: 'SG-0002', gloss: 'HELLO-2', labelHe: 'שלום', conceptKey: 'HELLO', isDefault: true, nmm: [{ type: 'facial_expression', value: 'smile' }] });
    const { client } = await signUp(h);
    const r = await translateAndGet(h, client, 'שלום');
    expect(r.verificationStatus).toBe('experimental');
    expect(r.segments[0].signEntry).toMatchObject({ id: preferred, conceptKey: 'HELLO' });
    expect(r.segments[0].lexicalNonManualMarkers).toEqual([{ type: 'facial_expression', value: 'smile' }]);
    expect(r.segments[0].nonManualMarkers).toEqual([]); // no sentence-level markers from an unvalidated engine
    expect(r.sourceTextStored).toBe(false);
    expect(r.quality.lexicalCoverage).toBe(1);
    expect(r.quality).not.toHaveProperty('coverage');
  });

  it('skips entries that have no approved animation', async () => {
    const h = createHarness({ withQueue: false });
    seedSign(h, { code: 'SG-0001', gloss: 'HELLO', labelHe: 'שלום', withAsset: false });
    const { client } = await signUp(h);
    const r = await translateAndGet(h, client, 'שלום');
    expect(r.missing[0].reason).toBe('no_animation_available');
  });
});
