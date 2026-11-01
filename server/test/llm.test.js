import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ScriptedProvider, makeClient } from './helpers.js';
import { createLimiter } from '../src/llm/limiter.js';
import { DailyBudget, RunStats } from '../src/llm/stats.js';
import { LLMError, StructuredOutputError } from '../src/llm/errors.js';
import { extractJson, generateStructured } from '../src/llm/structured.js';
import { parseRetryDelayMs, toLLMError } from '../src/llm/gemini.js';

test('extractJson: handles fences, prose around JSON and garbage', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here you go: {"a":{"b":2}} hope it helps'), { a: { b: 2 } });
  assert.throws(() => extractJson('no json here'));
  assert.throws(() => extractJson('{"a":'));
  assert.throws(() => extractJson(''));
});

test('limiter: never exceeds the concurrency limit', async () => {
  const limiter = createLimiter({ concurrency: 3 });
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      limiter.run(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    ),
  );
  assert.equal(peak, 3);
});

test('limiter: honours requests-per-minute by delaying the overflow', async () => {
  const limiter = createLimiter({ concurrency: 10, rpm: 2 });
  const started = [];
  const t0 = Date.now();
  const jobs = [0, 1, 2].map((i) => limiter.run(async () => started.push([i, Date.now() - t0])));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(started.length, 2, 'third call is held back');
  assert.equal(limiter.stats().queued, 1);
  // Do not wait a full minute in a unit test: just confirm the queue is parked, then abort it.
  const ac = new AbortController();
  const parked = limiter.run(async () => {}, { signal: ac.signal });
  ac.abort();
  await assert.rejects(parked, { name: 'AbortError' });
  void jobs;
});

test('client: retries retryable errors with backoff and then succeeds', async () => {
  const provider = new ScriptedProvider((_req, n) => {
    if (n < 3) throw new LLMError('busy', { code: 'rate_limited', retryable: true });
    return 'ok';
  });
  const stats = new RunStats();
  const res = await makeClient(provider, { maxRetries: 3 }).generate({ task: 't', prompt: 'p' }, { stats });
  assert.equal(res.text, 'ok');
  assert.equal(provider.calls, 3);
  assert.equal(stats.retries, 2);
});

test('client: does not retry non-retryable errors, and gives up after maxRetries', async () => {
  const bad = new ScriptedProvider(() => { throw new LLMError('nope', { code: 'auth' }); });
  await assert.rejects(makeClient(bad).generate({ task: 't' }), { code: 'auth' });
  assert.equal(bad.calls, 1);

  const flaky = new ScriptedProvider(() => { throw new LLMError('busy', { retryable: true, code: 'upstream_error' }); });
  await assert.rejects(makeClient(flaky, { maxRetries: 2 }).generate({ task: 't' }), { code: 'upstream_error' });
  assert.equal(flaky.calls, 3);
});

test('client: enforces the per-request call cap and the daily allowance', async () => {
  const ok = new ScriptedProvider(() => 'x');
  const stats = new RunStats({ maxCalls: 2 });
  const c = makeClient(ok);
  await c.generate({ task: 't' }, { stats });
  await c.generate({ task: 't' }, { stats });
  await assert.rejects(c.generate({ task: 't' }, { stats }), { code: 'call_cap' });

  const capped = makeClient(ok, { daily: 1 });
  await capped.generate({ task: 't' });
  assert.equal(capped.exhausted, true);
  await assert.rejects(capped.generate({ task: 't' }), { code: 'daily_budget' });
  const d = new DailyBudget(0);
  assert.ok(d.consume() && !d.exhausted(), '0 means unlimited');
});

test('gemini error mapping: 429 is retryable and carries the server delay', () => {
  const e = toLLMError(Object.assign(new Error('{"error":{"details":[{"retryDelay":"23s"}]}}'), { status: 429 }));
  assert.equal(e.retryable, true);
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.retryAfterMs, 23000);
  assert.equal(parseRetryDelayMs('Please retry in 4.2s'), 4200);
  assert.equal(toLLMError(Object.assign(new Error('API key not valid'), { status: 400 })).code, 'auth');
  assert.equal(toLLMError(Object.assign(new Error('bad field'), { status: 400 })).retryable, false);
  assert.equal(toLLMError(new TypeError('fetch failed')).retryable, true);
});

const Schema = z.object({ n: z.number().int() });
const repair = ({ prompt, issues }) => `${prompt} FIX ${issues.join(',')}`;

test('generateStructured: returns first-pass output untouched', async () => {
  const p = new ScriptedProvider(() => '{"n": 3}');
  const out = await generateStructured(makeClient(p), { task: 'x', system: 's', prompt: 'p', schema: Schema, repairPrompt: repair });
  assert.deepEqual(out, { data: { n: 3 }, attempts: 1, repaired: false });
});

test('generateStructured: repairs bad JSON, wrong shape and domain violations, quoting the problems back', async () => {
  const seen = [];
  const p = new ScriptedProvider((req, n) => {
    seen.push(req.prompt);
    return ['{"n": ', '{"n": "three"}', '{"n": 99}', '{"n": 5}'][n - 1];
  });
  const out = await generateStructured(makeClient(p), {
    task: 'x', system: 's', prompt: 'p', schema: Schema, repairPrompt: repair, maxRepairs: 3,
    validate: (d) => (d.n > 10 ? [`n=${d.n} is too big`] : []),
  });
  assert.equal(out.data.n, 5);
  assert.equal(out.attempts, 4);
  assert.ok(out.repaired);
  assert.match(seen[1], /not valid JSON/);
  assert.match(seen[2], /n:/);
  assert.match(seen[3], /too big/);
});

test('generateStructured: after the repair budget it throws, carrying the last schema-valid object', async () => {
  const p = new ScriptedProvider(() => '{"n": 99}');
  await assert.rejects(
    generateStructured(makeClient(p), { task: 'x', system: 's', prompt: 'p', schema: Schema, repairPrompt: repair, maxRepairs: 1, validate: () => ['always wrong'] }),
    (err) => {
      assert.ok(err instanceof StructuredOutputError);
      assert.deepEqual(err.lastData, { n: 99 });
      assert.equal(p.calls, 2);
      return true;
    },
  );
});

test('gemini provider: a model timeout is retryable, a caller cancellation is not swallowed', async () => {
  const { GeminiProvider } = await import('../src/llm/gemini.js');
  const p = new GeminiProvider({ apiKey: 'test-key', model: 'm', embedModel: 'e', timeoutMs: 5000 });
  const abortErr = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

  // 1. The SDK reports our own timeout as an AbortError: must become a retryable timeout.
  p.ai = { models: { generateContent: async () => { throw abortErr(); } } };
  await assert.rejects(p.generateOnce({ prompt: 'x' }), (e) => e.code === 'timeout' && e.retryable === true);

  // 2. The caller really cancelled: the abort passes through untouched.
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(p.generateOnce({ prompt: 'x' }, { signal: ac.signal }), { name: 'AbortError' });

  // 3. Unknown model id falls back to the fallback model once.
  const calls = [];
  const q = new GeminiProvider({ apiKey: 'test-key', model: 'bad-model', fallbackModel: 'good-model', embedModel: 'e' });
  q.ai = { models: { generateContent: async ({ model }) => { calls.push(model); if (model === 'bad-model') throw Object.assign(new Error('not found'), { status: 404 }); return { text: '{"ok":1}', usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }; } } };
  const res = await q.generateOnce({ prompt: 'x', json: true });
  assert.equal(res.text, '{"ok":1}');
  assert.deepEqual(calls, ['bad-model', 'good-model']);
});
