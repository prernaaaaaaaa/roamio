import test from 'node:test';
import assert from 'node:assert/strict';
import { kb, makePlanner, ScriptedProvider, baseRequest } from './helpers.js';
import { MockProvider } from '../src/llm/mock.js';
import { LLMError } from '../src/llm/errors.js';
import { PlanError } from '../src/planner/pipeline.js';
import { validateSelection, sanitizeSelection } from '../src/planner/validate.js';
import { buildCases } from '../eval/cases.js';

function audit(res, input) {
  const city = kb.getCity(res.meta.city.id);
  const ids = new Set(city.places.map((p) => p.id));
  for (const v of res.variants) {
    assert.ok(v.costs.total <= input.budget, `${v.id} total ${v.costs.total} within ${input.budget}`);
    const seen = new Set();
    for (const d of v.days) for (const it of d.items.filter((i) => i.kind === 'place')) {
      assert.ok(ids.has(it.placeId), `real place ${it.placeId}`);
      assert.ok(!seen.has(it.placeId), 'no duplicates');
      seen.add(it.placeId);
    }
  }
}

test('pipeline: clean model run produces first-pass variants within budget', async () => {
  const { planner } = makePlanner();
  const events = [];
  const res = await planner.plan(baseRequest, { emit: (e) => events.push(e) });
  assert.deepEqual(events.slice(0, 2), ['meta', 'research']);
  assert.equal(events.at(-1), 'done');
  assert.ok(res.variants.length >= 2);
  assert.ok(res.variants.every((v) => v.source === 'llm'));
  audit(res, baseRequest);
});

test('pipeline: invariants hold across 60 generated cases with 60% injected model faults', async () => {
  const { planner } = makePlanner({ provider: new MockProvider({ faultRate: 0.6 }) });
  const cases = buildCases(kb, { n: 64, seed: 11 }).filter((c) => c.kind === 'plan');
  let repaired = 0;
  for (const c of cases) {
    const res = await planner.plan(c.input);
    audit(res, c.input);
    repaired += res.variants.filter((v) => v.source !== 'llm').length;
  }
  assert.ok(repaired > 0, 'faults were actually injected and handled');
});

test('pipeline: a model that always returns garbage degrades to the built-in planner, still within budget', async () => {
  const { planner } = makePlanner({ provider: new ScriptedProvider(() => 'I am sorry, I cannot do that.') });
  const res = await planner.plan(baseRequest);
  assert.ok(res.variants.every((v) => v.source === 'fallback'));
  assert.ok(res.variants.every((v) => v.warnings.length > 0));
  audit(res, baseRequest);
});

test('pipeline: an unavailable model degrades the same way and records the reason', async () => {
  const { planner } = makePlanner({ provider: new ScriptedProvider(() => { throw new LLMError('down', { code: 'upstream_error' }); }) });
  const res = await planner.plan(baseRequest);
  assert.ok(res.variants.every((v) => v.source === 'fallback'));
  assert.ok(res.stats.warnings.length > 0);
  audit(res, baseRequest);
});

test('pipeline: invented place ids are never shown, even when the model insists on them', async () => {
  const { planner } = makePlanner({
    provider: new ScriptedProvider((req) => {
      const days = Number(/days: (\d+)/.exec(req.prompt)?.[1] ?? 1);
      return JSON.stringify({
        title: 'Secret trip', summary: 'A plan full of places that do not exist.',
        days: Array.from({ length: days }, (_, i) => ({ day: i + 1, theme: 'Hidden gems', placeIds: ['jaipur-secret-palace', 'jaipur-hawa-mahal'], tip: '' })),
        packing: [],
      });
    }),
  });
  const res = await planner.plan(baseRequest);
  audit(res, baseRequest);
  assert.ok(res.variants.every((v) => v.days.every((d) => d.items.every((i) => i.placeId !== 'jaipur-secret-palace'))));
});

test('pipeline: guardrails reject unknown cities and impossible budgets before any model call', async () => {
  const { planner, llm } = makePlanner();
  await assert.rejects(planner.plan({ ...baseRequest, destination: 'Atlantis' }), (e) => e instanceof PlanError && e.code === 'unknown_destination' && e.status === 404);
  await assert.rejects(planner.plan({ ...baseRequest, budget: 2000 }), (e) => e.code === 'budget_too_low' && e.details.minimumBudget > 2000);
  await assert.rejects(planner.plan({ ...baseRequest, days: 11 }), { name: 'ZodError' });
  await assert.rejects(planner.plan({ ...baseRequest, interests: ['crypto'] }), { name: 'ZodError' });
  assert.equal(llm.provider.calls ?? 0, 0);
});

test('pipeline: tiers the budget cannot afford are skipped with a reason, not faked', async () => {
  const { planner } = makePlanner();
  const res = await planner.plan({ ...baseRequest, budget: 20000 });
  assert.ok(res.meta.skipped.length >= 1);
  assert.ok(res.variants.every((v) => v.id !== res.meta.skipped[0].id));
});

test('pipeline: identical requests are served from the cache without model calls', async () => {
  const { planner } = makePlanner();
  const first = await planner.plan(baseRequest);
  const second = await planner.plan(baseRequest);
  assert.equal(first.meta.cached, false);
  assert.equal(second.meta.cached, true);
  assert.equal(second.stats.cached, true);
  assert.deepEqual(second.variants.map((v) => v.title), first.variants.map((v) => v.title));
});

test('pipeline: refine regenerates only the requested variant', async () => {
  const { planner } = makePlanner();
  const res = await planner.plan(baseRequest, { only: 'balanced', instruction: 'more food, less walking' });
  assert.deepEqual(res.variants.map((v) => v.id), ['balanced']);
});

test('pipeline: tool calls run (and are recorded) when a start date or currency is given', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const { planner } = makePlanner({ fetchImpl });
  const res = await planner.plan({ ...baseRequest, startDate: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), currency: 'USD' });
  const names = res.stats.toolCalls.map((t) => t.name);
  assert.ok(names.includes('get_weather_forecast') && names.includes('convert_currency'));
  assert.equal(res.research.currency.source, 'static-approx', 'falls back when the rate source is down');
  audit(res, baseRequest);
});

test('validate: catches every class of rule violation, and sanitize output then passes validation', () => {
  const city = kb.getCity('jaipur');
  const placesById = new Map(city.places.map((p) => [p.id, p]));
  const offered = new Set(city.places.map((p) => p.id));
  const ctx = { days: 2, pace: 'relaxed', month: null, travelers: 4, activityBudget: 1000, offered, placesById };
  const ids = city.places.map((p) => p.id);
  const bad = { title: 't', summary: 'long enough summary', packing: [], days: [
    { day: 1, theme: 'x', tip: '', placeIds: [ids[0], ids[1], ids[2], 'jaipur-made-up', ids[0]] },
    { day: 3, theme: 'y', tip: '', placeIds: [] },
  ] };
  const text = validateSelection(bad, ctx).join(' | ');
  for (const needle of ['not in the candidate list', 'Use each place at most once', 'outside 1..2', 'Day 2 is missing', 'exceeds the limit']) {
    assert.match(text, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const clean = sanitizeSelection(bad, ctx);
  const fixed = { ...bad, days: clean.days };
  assert.deepEqual(validateSelection(fixed, ctx), []);
});
