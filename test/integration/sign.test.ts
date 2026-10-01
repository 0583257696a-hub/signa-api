import { describe, expect, it } from 'vitest';
import { consumeSignJobs } from '../../src/modules/sign/queue';
import { HttpSignProvider, type SignTranslationProvider } from '../../src/modules/sign/provider';
import { AppError } from '../../src/lib/errors';
import { Client, createHarness, seedSign, signUp, type Harness } from '../helpers/harness';

const translate = (c: Client, text: string, headers?: Record<string, string>) =>
  c.post('/api/v1/sign/translate', { text, language: 'he', outputFormat: 'avatar_sequence' }, headers);

/** Delivers queued messages to the consumer like Cloudflare Queues would. */
async function drainQueue(h: Harness, opts: { deadLetter?: boolean } = {}) {
  const retried: string[] = [];
  const msgs = h.queue.messages.splice(0);
  const batch = {
    queue: opts.deadLetter ? 'signa-sign-jobs-dlq' : 'signa-sign-jobs',
    messages: msgs.map((body, i) => ({ id: String(i), body, attempts: 1, timestamp: new Date(), ack() {}, retry() { retried.push(body.jobId); } })),
  } as unknown as MessageBatch<unknown>;
  await consumeSignJobs(h.services(), batch, !!opts.deadLetter);
  return retried;
}

function seedDictionary(h: Harness) {
  seedSign(h, { code: 'SG-0001', gloss: 'HELLO', labelHe: 'שלום' });
  seedSign(h, { code: 'SG-0002', gloss: 'I', labelHe: 'אני' });
  seedSign(h, { code: 'SG-0003', gloss: 'NEED-HELP', labelHe: 'צריך עזרה', visibility: 'private' });
}

describe('ISL translation pipeline', () => {
  it('returns an explicit unsupported result (not fabricated signs) when the dictionary is empty', async () => {
    const h = createHarness({ withQueue: false });
    const { client } = await signUp(h);
    const r = await translate(client, 'שלום, אני צריך עזרה בבקשה');
    expect(r.status).toBe(200);
    expect(r.body.meta.processedInline).toBe(true);
    const job = r.body.data.job;
    expect(job.status).toBe('completed');
    expect(job.verificationStatus).toBe('unsupported');
    const res = await client.get(`/api/v1/sign/jobs/${job.id}/result`);
    expect(res.body.data.result.segments.every((s: { signEntry: unknown; assets: unknown[] }) => s.signEntry === null && s.assets.length === 0)).toBe(true);
    // Unsupported results are not billed.
    expect((await client.get('/api/v1/usage')).body.data.counters.sign.used).toBe(0);
  });

  it('marks dictionary-lookup output as experimental and lists missing segments', async () => {
    const h = createHarness({ withQueue: false });
    seedDictionary(h);
    const { client } = await signUp(h);
    const r = await translate(client, 'שלום, אני צריך עזרה בבקשה');
    const job = r.body.data.job;
    expect(job.verificationStatus).toBe('experimental');
    expect(job.status).toBe('partially_completed'); // "בבקשה" has no approved sign
    const { result } = (await client.get(`/api/v1/sign/jobs/${job.id}/result`)).body.data;
    expect(result.engine).toMatchObject({ name: 'dictionary-lookup', validated: false });
    expect(result.segments.map((s: { gloss: string | null }) => s.gloss)).toEqual(['HELLO', 'I', 'NEED-HELP', null]);
    expect(result.segments[0].sourceSpan).toEqual({ start: 0, end: 4 });
    expect(result.segments[2].assets[0].url).toMatch(/\/api\/v1\/assets\/ast_.+\/content\?exp=\d+&sig=[0-9a-f]+/);
    expect(result.segments[0].timing).toEqual({ startMs: 0, durationMs: 900 });
    expect(result.segments[1].timing.startMs).toBe(900);
    expect(result.missing).toEqual([{ index: 3, status: 'unsupported', sourceSpan: { start: 20, end: 25 }, reason: 'no_approved_sign' }]);
    expect(result.notices).toContain('segmentation_is_illustrative_not_isl_grammar');
    expect(result.quality.renderable).toBe(false);
    expect(result.segments.every((s: { nonManualMarkers: unknown[] }) => s.nonManualMarkers.length === 0)).toBe(true);
    expect((await client.get('/api/v1/usage')).body.data.counters.sign.used).toBe(1);
  });

  it('never marks unreviewed entries or entries without approved assets as renderable', async () => {
    const h = createHarness({ withQueue: false });
    seedSign(h, { code: 'SG-0001', gloss: 'HELLO', labelHe: 'שלום', withAsset: false });
    h.d1.q(`INSERT INTO sign_entries (id, sign_code, canonical_label, label_he, created_at, updated_at) VALUES ('sgn_draftdraftdraft01', 'SG-0009', 'DRAFT', 'אני', 0, 0)`);
    const { client } = await signUp(h);
    const job = (await translate(client, 'שלום אני')).body.data.job;
    expect(job.verificationStatus).toBe('unsupported');
  });

  it('only reports verified when the engine is validated and every segment is covered', async () => {
    const fakeFetch = (segments: unknown[], validated = true) =>
      (async () => new Response(JSON.stringify({ engine: { name: 'isl-engine', version: '2.1' }, validated, segments }), { status: 200 })) as unknown as typeof fetch;
    const h = createHarness({ withQueue: false, envOverrides: { SIGN_PROVIDER: 'http', SIGN_PROVIDER_URL: 'https://engine.example/translate', SIGN_PROVIDER_API_KEY: 'k', SIGN_PROVIDER_VALIDATED: 'true' } });
    seedDictionary(h);
    const { client } = await signUp(h);
    const ids = h.d1.q<{ id: string }>('SELECT id FROM sign_entries ORDER BY sign_code').map((r) => r.id);
    const marker = { type: 'facial_expression', value: 'raised_brows' };

    h.overrides.signProvider = new HttpSignProvider('https://e', 'k', true, fakeFetch([
      { kind: 'sign', signEntryId: ids[0], nonManualMarkers: [marker] },
      { kind: 'sign', signEntryId: ids[2] },
    ]));
    const verified = (await translate(client, 'שלום, צריך עזרה')).body.data.job;
    expect(verified.verificationStatus).toBe('verified');
    expect(verified.status).toBe('completed');
    const vr = (await client.get(`/api/v1/sign/jobs/${verified.id}/result`)).body.data.result;
    expect(vr.segments[0].nonManualMarkers).toEqual([marker]);

    h.overrides.signProvider = new HttpSignProvider('https://e', 'k', true, fakeFetch([
      { kind: 'sign', signEntryId: ids[0] },
      { kind: 'sign', signEntryId: 'sgn_fabricated_id_000' },
    ]));
    const partial = (await translate(client, 'שלום עולם')).body.data.job;
    expect(partial.verificationStatus).toBe('partially_verified');
    const pr = (await client.get(`/api/v1/sign/jobs/${partial.id}/result`)).body.data.result;
    expect(pr.segments[1]).toMatchObject({ status: 'unknown_sign', signEntry: null, renderable: false });

    // A provider claiming validation is capped at experimental when the operator has not validated it.
    h.overrides.signProvider = new HttpSignProvider('https://e', 'k', false, fakeFetch([{ kind: 'sign', signEntryId: ids[0] }]));
    expect((await translate(client, 'שלום')).body.data.job.verificationStatus).toBe('experimental');
  });

  it('processes jobs asynchronously via the queue, safely under duplicate delivery', async () => {
    const h = createHarness();
    seedDictionary(h);
    const { client } = await signUp(h);
    const r = await translate(client, 'שלום אני');
    expect(r.status).toBe(202);
    expect(r.body.data.job.status).toBe('queued');
    const jobId = r.body.data.job.id;
    expect(h.queue.messages).toEqual([{ jobId, enqueuedAt: h.clock.now }]);
    expect(JSON.stringify(h.queue.messages)).not.toContain('שלום');
    const notReady = await client.get(`/api/v1/sign/jobs/${jobId}/result`);
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe('job_not_ready');

    h.queue.messages.push({ jobId, enqueuedAt: 0 }, { jobId, enqueuedAt: 0 }); // duplicate deliveries
    await drainQueue(h);
    const status = await client.get(`/api/v1/sign/jobs/${jobId}`);
    expect(status.body.data.job).toMatchObject({ status: 'completed', verificationStatus: 'experimental', attempts: 1 });
    expect(h.d1.q('SELECT COUNT(*) AS n FROM translation_job_inputs')[0]!.n).toBe(0); // source text purged
    expect((await client.get('/api/v1/usage')).body.data.counters.sign.used).toBe(1);
  });

  it('enforces job ownership (IDOR protection)', async () => {
    const h = createHarness();
    const a = await signUp(h);
    const b = await signUp(h);
    const jobId = (await translate(a.client, 'שלום')).body.data.job.id;
    expect((await b.client.get(`/api/v1/sign/jobs/${jobId}`)).status).toBe(404);
    expect((await b.client.get(`/api/v1/sign/jobs/${jobId}/result`)).status).toBe(404);
    expect((await b.client.post(`/api/v1/sign/jobs/${jobId}/cancel`)).status).toBe(404);
  });

  it('cancels queued jobs, releases usage and purges input', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    const jobId = (await translate(client, 'שלום')).body.data.job.id;
    const c = await client.post(`/api/v1/sign/jobs/${jobId}/cancel`);
    expect(c.body.data.job.status).toBe('cancelled');
    expect(h.d1.q('SELECT COUNT(*) AS n FROM translation_job_inputs')[0]!.n).toBe(0);
    expect((await client.get('/api/v1/usage')).body.data.counters.translations.used).toBe(0);
    await drainQueue(h); // late delivery must not resurrect it
    expect((await client.get(`/api/v1/sign/jobs/${jobId}`)).body.data.job.status).toBe('cancelled');
    expect((await client.post(`/api/v1/sign/jobs/${jobId}/cancel`)).body.error.code).toBe('job_not_cancellable');
  });

  it('applies idempotency keys to job creation', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    const key = { 'idempotency-key': 'sign-key-000001' };
    const a = await translate(client, 'שלום', key);
    const b = await translate(client, 'שלום', key);
    expect(b.status).toBe(200);
    expect(b.body.meta.idempotentReplay).toBe(true);
    expect(b.body.data.job.id).toBe(a.body.data.job.id);
    expect(h.queue.messages).toHaveLength(1);
    expect((await translate(client, 'תודה', key)).body.error.code).toBe('idempotency_conflict');
  });

  it('limits concurrent jobs per plan', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    expect((await translate(client, 'שלום')).status).toBe(202);
    const second = await translate(client, 'שלום');
    expect(second.status).toBe(429);
    expect(second.body.error.details.reason).toBe('concurrent_jobs_limit');
    expect((await client.get('/api/v1/usage')).body.data.counters.translations.used).toBe(1);
  });

  it('retries transient provider failures with a bounded number of attempts, then fails', async () => {
    let calls = 0;
    const failing: SignTranslationProvider = {
      name: 'flaky',
      async translate() {
        calls++;
        throw new AppError('provider_error');
      },
      async health() {
        return { status: 'degraded' as const };
      },
    };
    const h = createHarness({ services: { signProvider: failing } });
    const { client } = await signUp(h);
    const jobId = (await translate(client, 'שלום')).body.data.job.id;
    for (let i = 0; i < 5; i++) {
      const retried = await drainQueue(h);
      for (const id of retried) h.queue.messages.push({ jobId: id, enqueuedAt: 0 });
    }
    expect(calls).toBe(3);
    const job = (await client.get(`/api/v1/sign/jobs/${jobId}`)).body.data.job;
    expect(job).toMatchObject({ status: 'failed', failureCode: 'provider_error', attempts: 3 });
    expect((await client.get('/api/v1/usage')).body.data.counters.translations.used).toBe(0);
    expect(h.d1.q(`SELECT outcome FROM usage_events`)[0]!.outcome).toBe('failed');
  });

  it('fails dead-lettered jobs explicitly', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    const jobId = (await translate(client, 'שלום')).body.data.job.id;
    await drainQueue(h, { deadLetter: true });
    expect((await client.get(`/api/v1/sign/jobs/${jobId}`)).body.data.job).toMatchObject({ status: 'failed', failureCode: 'dead_lettered' });
  });

  it('expires jobs past their deadline via the sweeper', async () => {
    const h = createHarness();
    const { client } = await signUp(h);
    const jobId = (await translate(client, 'שלום')).body.data.job.id;
    h.clock.now += 11 * 60 * 1000;
    const { sweepJobs } = await import('../../src/modules/sign/jobs');
    expect((await sweepJobs(h.services())).expired).toBe(1);
    expect((await client.get(`/api/v1/sign/jobs/${jobId}`)).body.data.job.status).toBe('expired');
  });

  it('expires results after the retention window', async () => {
    const h = createHarness({ withQueue: false });
    seedDictionary(h);
    const { client } = await signUp(h);
    const jobId = (await translate(client, 'שלום')).body.data.job.id;
    expect((await client.get(`/api/v1/sign/jobs/${jobId}/result`)).status).toBe(200);
    h.clock.now += 61 * 60 * 1000;
    const gone = await client.get(`/api/v1/sign/jobs/${jobId}/result`);
    expect(gone.status).toBe(404);
    expect(gone.body.error.details.reason).toBe('result_expired');
  });

  it('falls back to synchronous processing for short text when the queue fails, and errors for long text', async () => {
    const h = createHarness();
    seedDictionary(h);
    const { client } = await signUp(h);
    h.queue.fail = true;
    const short = await translate(client, 'שלום');
    expect(short.status).toBe(200);
    expect(short.body.meta.processedInline).toBe(true);
    h.d1.q(`UPDATE plan_entitlements SET value_json = '1000' WHERE key = 'sign.max_input_chars'`);
    const long = await translate(client, 'שלום '.repeat(80));
    expect(long.status).toBe(503);
    expect(long.body.error.code).toBe('queue_unavailable');
    expect((await client.get('/api/v1/usage')).body.data.counters.sign.used).toBe(1);
  });

  it('never logs source text', async () => {
    const lines: string[] = [];
    const { createLogger } = await import('../../src/lib/logger');
    const h = createHarness({ services: { logger: createLogger({}, (l) => lines.push(l), 'debug') } });
    const { client } = await signUp(h);
    await translate(client, 'סוד מאוד פרטי');
    await client.post('/api/v1/emoji/translate', { text: 'סוד מאוד פרטי שמח' });
    await drainQueue(h);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('סוד');
  });
});
