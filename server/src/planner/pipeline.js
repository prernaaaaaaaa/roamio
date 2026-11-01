import crypto from 'node:crypto';
import { generateStructured } from '../llm/structured.js';
import { RunStats } from '../llm/stats.js';
import { StructuredOutputError, isAbort } from '../llm/errors.js';
import { clean } from '../util/text.js';
import { VARIANTS, activityBudget as activityBudgetFor, baseline, minimumBudget, CONTINGENCY_RATE } from './costs.js';
import { normalizeRequest, PlanSelectionSchema } from './schemas.js';
import { PLAN_SYSTEM, planPrompt, repairPrompt } from './prompts.js';
import { validateSelection, sanitizeSelection } from './validate.js';
import { selectPlacesForDays, trimToBudget, themeFor, areaFor } from './heuristics.js';
import { assembleVariant } from './assemble.js';
import { runResearch } from './research.js';

export class PlanError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'PlanError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const ASSUMPTIONS = [
  'An N-day trip includes N-1 nights of stay; a 1-day trip has no stay.',
  'Rooms are double occupancy: one room per two travellers.',
  'One vehicle per four travellers for local transport each day.',
  'Food is a daily per-person allowance for the tier; meals are not itemised.',
  'Activity prices are per person, in INR, from the knowledge base (approximate, check before you book).',
  `A ${Math.round(CONTINGENCY_RATE * 100)}% contingency is added on top. Travel to and from the destination is not included.`,
];

/** Plan against the nearest lower round budget so identical-looking requests share a cache entry. */
export function bucketBudget(budget) {
  const step = budget < 50_000 ? 1000 : budget < 200_000 ? 2500 : 10_000;
  return Math.max(1000, Math.floor(budget / step) * step);
}

const MAX_CANDIDATES = 18;

export function createPlanner({ kb, retriever, llm, config, cache, fetchImpl = fetch, now = () => new Date() }) {
  const placesCache = new Map();
  const placesOf = (city) => {
    if (!placesCache.has(city.id)) placesCache.set(city.id, new Map(city.places.map((p) => [p.id, p])));
    return placesCache.get(city.id);
  };

  function cacheKey(input, only, instruction) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify({ v: kb.version, m: llm.info.model, input, only, instruction, d: input.startDate ? now().toISOString().slice(0, 10) : '' }))
      .digest('hex');
  }

  function fallbackSelection({ city, variant, input, candidates, ab, placesById }) {
    const raw = selectPlacesForDays({
      candidates,
      days: input.days,
      pace: input.pace,
      tier: variant.tier,
      activityBudget: ab,
      travelers: input.travelers,
      interests: input.interests,
      month: input.month,
    });
    const trimmed = trimToBudget(raw, { placesById, travelers: input.travelers, activityBudget: ab });
    const all = trimmed.flatMap((d) => d.placeIds.map((id) => placesById.get(id)));
    return {
      title: `${variant.label} in ${city.city}`,
      summary: `${input.days} day${input.days > 1 ? 's' : ''} of ${themeFor(all).toLowerCase()} around ${areaFor(all) || city.city}, planned at a ${input.pace} pace.`,
      days: trimmed.map((d) => {
        const first = placesById.get(d.placeIds[0]);
        return { day: d.day, theme: d.theme, placeIds: d.placeIds, tip: first ? `Begin at ${first.name} (${first.area}) while it is quiet.` : '' };
      }),
      packing: [],
    };
  }

  async function buildVariant(variant, { city, input, plannedBudget, candidatesAll, brief, instruction, stats, signal }) {
    const placesById = placesOf(city);
    const ab = activityBudgetFor({ city, tier: variant.tier, travelers: input.travelers, days: input.days, budget: plannedBudget });
    const candidates = candidatesAll.filter((c) => {
      if (variant.tier === 'budget' && c.place.premium) return false;
      return c.place.costINR * input.travelers <= ab;
    });
    const offered = new Set(candidates.map((c) => c.place.id));
    const vctx = { days: input.days, pace: input.pace, month: input.month, travelers: input.travelers, activityBudget: ab, offered, placesById };
    const params = { days: input.days, pace: input.pace, tier: variant.tier, activityBudget: ab, travelers: input.travelers, interests: input.interests, month: input.month };
    const maxRepairs = config.llm.maxRepairs ?? 2;

    let selection;
    let source = 'llm';
    let outcome = 'firstPass';
    let attempts = 1;
    const notes = [];
    const useFallback = (why) => {
      selection = fallbackSelection({ city, variant, input, candidates, ab, placesById });
      source = 'fallback';
      outcome = 'fallback';
      notes.push(why);
    };

    if (llm.exhausted) {
      useFallback('The daily AI allowance is used up, so this plan was built by the built-in planner.');
    } else {
      try {
        const out = await generateStructured(llm, {
          task: 'plan',
          system: PLAN_SYSTEM,
          prompt: planPrompt({ city, variant, input, candidates, activityBudget: ab, brief, instruction }),
          schema: PlanSelectionSchema,
          validate: (s) => validateSelection(s, vctx),
          repairPrompt,
          maxRepairs,
          maxOutputTokens: 8192,
          mock: { city, candidates, params, variantLabel: variant.label, instruction },
          ctx: { stats, signal },
        });
        selection = out.data;
        attempts = out.attempts;
        if (out.repaired) {
          source = 'llm-repaired';
          outcome = 'repaired';
          notes.push(`The first AI draft broke planning rules and was repaired (${out.attempts - 1} retr${out.attempts - 1 === 1 ? 'y' : 'ies'}).`);
        }
      } catch (err) {
        if (isAbort(err) || signal?.aborted) throw err;
        attempts = maxRepairs + 1;
        if (err instanceof StructuredOutputError && err.lastData) {
          const san = sanitizeSelection(err.lastData, vctx);
          const proposed = err.lastData.days.reduce((s, d) => s + d.placeIds.length, 0);
          if (proposed > 0 && san.keptCount >= Math.ceil(proposed * 0.6)) {
            selection = { ...err.lastData, days: san.days };
            source = 'llm-sanitized';
            outcome = 'sanitized';
            notes.push(`The AI draft still broke ${san.dropped.length} rule(s) after repairs; those places were removed automatically.`);
          }
        }
        if (!selection) {
          useFallback(
            err instanceof StructuredOutputError
              ? 'The AI could not produce a valid plan, so this one was built by the built-in planner.'
              : `The AI service was unavailable (${err.code || 'error'}), so this plan was built by the built-in planner.`,
          );
          if (!(err instanceof StructuredOutputError)) stats.warnings.push(`plan/${variant.id}: ${err.code || err.message}`);
        }
      }
    }

    stats.outcome(outcome, outcome === 'firstPass' || outcome === 'fallback' ? 0 : attempts - 1);
    return assembleVariant({ city, variant, input, plannedBudget, selection, source, notes, attempts });
  }

  /**
   * Plan a trip. Emits progress events as it goes and returns the full result.
   * @param {object} rawInput untrusted request body
   * @param {{emit?:(event:string, data:object)=>void, signal?:AbortSignal, only?:string, instruction?:string}} [opts]
   */
  async function plan(rawInput, { emit = () => {}, signal, only, instruction = '' } = {}) {
    const input = normalizeRequest(rawInput);
    instruction = clean(instruction, 200);

    const { city } = kb.findCity(input.destination);
    if (!city) {
      throw new PlanError(404, 'unknown_destination', `We don't cover "${input.destination}" yet.`, {
        destinations: kb.listCities().map((c) => c.city),
      });
    }
    const minBudget = minimumBudget({ city, travelers: input.travelers, days: input.days });
    if (input.budget < minBudget) {
      throw new PlanError(
        422,
        'budget_too_low',
        `INR ${input.budget.toLocaleString('en-IN')} is not enough for ${input.travelers} traveller(s) for ${input.days} day(s) in ${city.city}. The lowest workable budget is about INR ${minBudget.toLocaleString('en-IN')}.`,
        { minimumBudget: minBudget },
      );
    }
    if (only && !input.variants.includes(only)) throw new PlanError(400, 'bad_variant', `Unknown variant "${only}".`);

    const plannedBudget = Math.max(minBudget, bucketBudget(input.budget));
    const wanted = VARIANTS.filter((v) => (only ? v.id === only : input.variants.includes(v.id)));
    const skipped = [];
    const runnable = [];
    for (const v of wanted) {
      const ab = activityBudgetFor({ city, tier: v.tier, travelers: input.travelers, days: input.days, budget: plannedBudget });
      if (ab < 0) {
        const need = Math.ceil(baseline({ city, tier: v.tier, travelers: input.travelers, days: input.days }).base * (1 + CONTINGENCY_RATE)) + 1;
        skipped.push({ id: v.id, label: v.label, reason: `Needs a budget of about INR ${need.toLocaleString('en-IN')}.` });
      } else runnable.push(v);
    }

    const key = cacheKey(input, only, instruction);
    const hit = cache?.get(key);
    const meta = {
      requestId: crypto.randomUUID(),
      city: { id: city.id, name: city.city, state: city.state, tagline: city.tagline },
      input,
      plannedBudget,
      minimumBudget: minBudget,
      assumptions: ASSUMPTIONS,
      variantsPlanned: runnable.map((v) => v.id),
      skipped,
      model: llm.info,
      embeddingMode: retriever.embeddingMode,
      kbVersion: kb.version,
      cached: Boolean(hit),
    };
    emit('meta', meta);

    if (hit) {
      emit('research', hit.research);
      for (const v of hit.variants) emit('variant', v);
      const stats = { ...hit.stats, cached: true, totalMs: 0, timeToFirstVariantMs: 0 };
      emit('done', { stats });
      return { ...hit, meta, stats };
    }

    const stats = new RunStats({
      maxCalls: config.llm.maxCallsPerRequest,
      priceInPerM: config.llm.priceInPerM,
      priceOutPerM: config.llm.priceOutPerM,
    });

    const research = await runResearch({ llm, city, input, stats, signal, fetchImpl, today: now() });
    emit('research', research);

    const query = [input.interests.join(' '), input.notes, instruction].filter(Boolean).join(' ');
    const found = await retriever.search({ cityId: city.id, query, limit: MAX_CANDIDATES, month: input.month });
    const top = Math.max(...found.map((f) => f.score), 1e-9);
    const candidatesAll = found.map((f) => ({ place: f.place, relevance: f.score / top }));

    const variants = [];
    await Promise.all(
      runnable.map(async (v) => {
        const built = await buildVariant(v, { city, input, plannedBudget, candidatesAll, brief: research.brief, instruction, stats, signal });
        variants.push(built);
        stats.markFirstVariant();
        emit('variant', built);
      }),
    );
    variants.sort((a, b) => VARIANTS.findIndex((x) => x.id === a.id) - VARIANTS.findIndex((x) => x.id === b.id));

    const summary = stats.summary();
    const result = { meta, research, variants, skipped, stats: summary };
    emit('done', { stats: summary });
    if (cache && variants.every((v) => v.source !== 'fallback')) cache.set(key, { research, variants, stats: summary, skipped });
    return result;
  }

  return { plan };
}
