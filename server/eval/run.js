#!/usr/bin/env node
/**
 * Roamio evaluation harness.
 *
 *   node eval/run.js                       # mock provider (pipeline machinery only)
 *   GEMINI_API_KEY=... node eval/run.js    # real model: these are the numbers to publish
 *   node eval/run.js --n 40 --judge --out eval/results.json
 *
 * Flags: --n <cases>  --seed <int>  --judge  --fault <0-1> (mock only)  --out <file>  --md <file>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { loadConfig } from '../src/config.js';
import { bootstrap } from '../src/bootstrap.js';
import { MemoryStore } from '../src/store/memory.js';
import { PlanError } from '../src/planner/pipeline.js';
import { buildCases } from './cases.js';
import { generateStructured } from '../src/llm/structured.js';
import { RunStats } from '../src/llm/stats.js';
import { JudgeSchema } from '../src/planner/schemas.js';
import { JUDGE_SYSTEM, judgePrompt } from '../src/planner/prompts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const N = Number(flag('n', 30));
const SEED = Number(flag('seed', 42));
const JUDGE = Boolean(flag('judge', false));
const env = { ...process.env };
if (flag('fault', null) != null) env.MOCK_FAULT_RATE = String(flag('fault'));
if (!env.GEMINI_API_KEY && !env.LLM_PROVIDER) env.LLM_PROVIDER = 'mock';
if (env.LLM_PROVIDER === 'mock' && env.MOCK_FAULT_RATE == null) env.MOCK_FAULT_RATE = '0.3';
env.CACHE_MAX = '1'; // never let the cache hide model behaviour
env.LLM_MAX_CALLS_PER_DAY = '0'; // the eval is allowed to spend
env.NODE_ENV = 'test';

const config = loadConfig(env);
// Mock runs go to separate, git-ignored files so they can never be mistaken for real results.
const suffix = config.llm.provider === 'mock' ? '.mock' : '';
const OUT = String(flag('out', path.join(here, `results${suffix}.json`)));
const MD = String(flag('md', path.join(here, `RESULTS${suffix}.md`)));
const { planner, llm, kb, retriever } = await bootstrap(config, { store: new MemoryStore(), logger: { warn() {}, error() {} } });
const cases = buildCases(kb, { n: N, seed: SEED });

const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rate = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : 0);

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Independent re-check of a finished variant against the knowledge base. */
function auditVariant(v, city, input) {
  const byId = new Map(city.places.map((p) => [p.id, p]));
  const problems = [];
  const seen = new Set();
  for (const d of v.days) {
    for (const it of d.items.filter((i) => i.kind === 'place')) {
      const p = byId.get(it.placeId);
      if (!p) {
        problems.push(`unknown place ${it.placeId}`);
        continue;
      }
      if (seen.has(it.placeId)) problems.push(`duplicate ${it.placeId}`);
      seen.add(it.placeId);
      const s = toMin(it.startTime);
      const e = toMin(it.endTime);
      if (s < p.hours[0] * 60 - 1 || e > p.hours[1] * 60 + 1) problems.push(`${p.id} outside opening hours`);
    }
  }
  if (v.costs.total > input.budget) problems.push('over budget');
  return problems;
}

const rows = [];
const t0 = Date.now();
console.log(`Roamio eval | provider=${llm.info.provider} model=${llm.info.model} | embeddings=${retriever.embeddingMode} | cases=${cases.length} | seed=${SEED}`);
if (llm.info.provider === 'mock') {
  console.log('NOTE: mock provider. These numbers verify the pipeline, not model quality. Re-run with GEMINI_API_KEY to get publishable numbers.\n');
}

const keepAlive = setInterval(() => {}, 1000); // belt and braces: never let a long wait end the process

for (const c of cases) {
  const row = { id: c.id, kind: c.kind, expect: c.expect };
  const started = Date.now();
  try {
    const events = [];
    const res = await planner.plan(c.input, { emit: (e) => events.push(e) });
    row.outcome = 'ok';
    row.stats = res.stats;
    row.variants = res.variants.map((v) => ({ id: v.id, source: v.source, total: v.costs.total, fits: v.budget.fits }));
    const city = kb.getCity(res.meta.city.id);
    row.audit = res.variants.flatMap((v) => auditVariant(v, city, c.input));
    if (c.canary) {
      const text = JSON.stringify(res.variants.map((v) => [v.title, v.summary, v.days.map((d) => [d.theme, d.tip])]));
      row.canaryLeaked = text.includes(c.canary);
    }
    if (JUDGE) {
      row.judge = [];
      for (const v of res.variants) {
        try {
          const out = await generateStructured(llm, {
            task: 'judge',
            system: JUDGE_SYSTEM,
            prompt: judgePrompt({ city, input: res.meta.input, variant: v }),
            schema: JudgeSchema,
            repairPrompt: ({ prompt, issues }) => `${prompt}\nFix: ${issues.join('; ')}`,
            maxRepairs: 1,
            ctx: { stats: new RunStats({ maxCalls: 10 }) },
          });
          row.judge.push(out.data);
        } catch {
          /* a failed judgement is simply not counted */
        }
      }
    }
  } catch (err) {
    row.outcome = err instanceof PlanError ? err.code : err instanceof ZodError ? 'invalid_request' : `error:${err.message}`;
    if (row.outcome !== c.expect) row.error = String(err?.stack || err).split('\n').slice(0, 4).join(' | ');
  }
  row.wallMs = Date.now() - started;
  rows.push(row);
  process.stdout.write(row.outcome === c.expect ? '.' : 'x');
  if (row.outcome !== c.expect) console.log(`\n  ! ${c.id}: expected ${c.expect}, got ${row.outcome}${row.error ? `\n    ${row.error}` : ''}`);
}
clearInterval(keepAlive);
console.log('\n');

// ---- aggregate -----------------------------------------------------------------------------
const planned = rows.filter((r) => r.outcome === 'ok');
const variants = planned.flatMap((r) => r.variants);
const v = planned.reduce(
  (a, r) => {
    for (const k of ['firstPass', 'repaired', 'sanitized', 'fallback', 'total', 'repairAttempts']) a[k] += r.stats.validation[k];
    return a;
  },
  { firstPass: 0, repaired: 0, sanitized: 0, fallback: 0, total: 0, repairAttempts: 0 },
);
const guard = rows.filter((r) => r.kind === 'guardrail');
const judges = planned.flatMap((r) => r.judge ?? []);
const metrics = {
  provider: llm.info.provider,
  model: llm.info.model,
  embeddingMode: retriever.embeddingMode,
  date: new Date().toISOString().slice(0, 10),
  cases: rows.length,
  plans: planned.length,
  variants: variants.length,
  firstPassValidRate: rate(v.firstPass, v.total),
  repairedRate: rate(v.repaired, v.total),
  sanitizedRate: rate(v.sanitized, v.total),
  fallbackRate: rate(v.fallback, v.total),
  validAfterRepairRate: rate(v.firstPass + v.repaired, v.total),
  budgetComplianceRate: rate(variants.filter((x) => x.fits).length, variants.length),
  auditCleanRate: rate(planned.filter((r) => r.audit.length === 0).length, planned.length),
  guardrailAccuracy: rate(guard.filter((r) => r.outcome === r.expect).length, guard.length),
  injectionLeaks: rows.filter((r) => r.canaryLeaked).length,
  llmCallsPerPlan: Number(mean(planned.map((r) => r.stats.llmCalls)).toFixed(2)),
  inputTokensPerPlan: Math.round(mean(planned.map((r) => r.stats.inputTokens))),
  outputTokensPerPlan: Math.round(mean(planned.map((r) => r.stats.outputTokens))),
  costPerPlanUSD: Number(mean(planned.map((r) => r.stats.estimatedCostUSD)).toFixed(5)),
  timeToFirstVariantMs: { p50: pct(planned.map((r) => r.stats.timeToFirstVariantMs ?? 0), 50), p95: pct(planned.map((r) => r.stats.timeToFirstVariantMs ?? 0), 95) },
  totalMs: { p50: pct(planned.map((r) => r.stats.totalMs), 50), p95: pct(planned.map((r) => r.stats.totalMs), 95) },
  judge: judges.length
    ? {
        n: judges.length,
        coherence: Number(mean(judges.map((j) => j.coherence)).toFixed(2)),
        fit: Number(mean(judges.map((j) => j.fit)).toFixed(2)),
        variety: Number(mean(judges.map((j) => j.variety)).toFixed(2)),
      }
    : null,
  failures: rows.filter((r) => r.outcome !== r.expect).map((r) => ({ id: r.id, expected: r.expect, got: r.outcome })),
  auditProblems: planned.filter((r) => r.audit.length).map((r) => ({ id: r.id, problems: r.audit })),
  wallSeconds: Math.round((Date.now() - t0) / 100) / 10,
  seed: SEED,
};

fs.writeFileSync(OUT, JSON.stringify({ metrics, rows }, null, 2));

const m = metrics;
const md = `# Roamio evaluation

${m.provider === 'mock' ? '> **Mock provider.** These numbers verify the pipeline machinery (validation, repair, fallback, budget engine). They say nothing about Gemini. Run \`GEMINI_API_KEY=... npm run eval\` to regenerate with the real model.\n' : ''}
Provider \`${m.provider}\` / model \`${m.model}\` / embeddings \`${m.embeddingMode}\` / ${m.date} / ${m.cases} cases (seed ${m.seed}) / ${m.variants} itineraries

| Metric | Result |
| --- | --- |
| First-draft valid (no repair needed) | ${m.firstPassValidRate}% |
| Valid after repair prompts | ${m.validAfterRepairRate}% |
| Needed automatic clean-up (sanitised) | ${m.sanitizedRate}% |
| Fell back to the built-in planner | ${m.fallbackRate}% |
| Itineraries within budget | ${m.budgetComplianceRate}% |
| Plans passing independent audit (real places, opening hours, no duplicates, budget) | ${m.auditCleanRate}% |
| Guardrail cases handled correctly | ${m.guardrailAccuracy}% |
| Prompt-injection canary leaks | ${m.injectionLeaks} |
| Model calls per plan | ${m.llmCallsPerPlan} |
| Tokens per plan (in / out) | ${m.inputTokensPerPlan} / ${m.outputTokensPerPlan} |
| Estimated cost per plan | $${m.costPerPlanUSD} |
| Time to first itinerary (p50 / p95) | ${m.timeToFirstVariantMs.p50} ms / ${m.timeToFirstVariantMs.p95} ms |
| Time to full result (p50 / p95) | ${m.totalMs.p50} ms / ${m.totalMs.p95} ms |
${m.judge ? `| LLM-judge scores, 1-5 (coherence / fit / variety, n=${m.judge.n}) | ${m.judge.coherence} / ${m.judge.fit} / ${m.judge.variety} |\n` : ''}
${m.failures.length ? `Unexpected outcomes: ${m.failures.map((f) => `${f.id} (expected ${f.expected}, got ${f.got})`).join('; ')}\n` : 'Every case produced its expected outcome.\n'}`;
fs.writeFileSync(MD, md);

console.log(md);
console.log(`Wrote ${path.relative(process.cwd(), OUT)} and ${path.relative(process.cwd(), MD)}`);
process.exit(m.failures.length || m.auditProblems.length ? 1 : 0);
