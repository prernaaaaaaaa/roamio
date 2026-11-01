import { hashEmbed } from '../kb/embeddings.js';
import { selectPlacesForDays, themeFor, areaFor } from '../planner/heuristics.js';
import { seededRng } from '../util/text.js';

const delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    });
  });

function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

const approxTokens = (s) => Math.ceil(String(s || '').length / 4);

export const FAULTS = ['bad_json', 'unknown_id', 'duplicate', 'over_budget', 'overpacked'];

/**
 * Deterministic stand-in for the model. It lets the whole system (API, SSE, validation, repair,
 * fallback, evaluation, CI) run offline, and it can inject the failure modes real models show
 * (truncated JSON, invented place ids, duplicates, overspending) at a configurable rate so the
 * repair and fallback paths are exercised on purpose.
 *
 * The mock only "decides" with the same heuristics the real fallback uses. Its eval numbers
 * therefore say nothing about Gemini's quality; they only prove the pipeline's machinery.
 */
export class MockProvider {
  constructor({ latencyMs = 0, faultRate = 0 } = {}) {
    this.name = 'mock';
    this.model = 'mock-planner-1';
    this.latencyMs = latencyMs;
    this.faultRate = faultRate;
  }

  async generateOnce(req, { signal } = {}) {
    if (this.latencyMs) await delay(this.latencyMs, signal);
    let text;
    const toolCalls = [];
    switch (req.task) {
      case 'research':
        text = await this.#research(req, toolCalls);
        break;
      case 'plan':
      case 'repair':
        text = this.#plan(req);
        break;
      case 'judge':
        text = JSON.stringify({ coherence: 4, fit: 4, variety: 4, notes: 'mock judge' });
        break;
      default:
        text = '{}';
    }
    return { text, usage: { inputTokens: approxTokens(req.prompt) + approxTokens(req.system), outputTokens: approxTokens(text) }, toolCalls };
  }

  async embed(texts) {
    return texts.map((t) => Array.from(hashEmbed(t)));
  }

  async #research(req, toolCalls) {
    const m = req.mock || {};
    const facts = [];
    const call = async (name, args) => {
      const handler = req.handlers?.[name];
      if (!handler) return null;
      const t0 = Date.now();
      const result = await handler(args);
      toolCalls.push({ name, args, result, ms: Date.now() - t0, source: 'model' });
      return result;
    };
    const season = await call('get_season_info', { month: m.month });
    if (season?.label) facts.push(`${season.label} (${season.tempC?.[0]}-${season.tempC?.[1]} C, rain: ${season.rain}).`);
    if (m.startDate) {
      const w = await call('get_weather_forecast', { startDate: m.startDate, days: m.days });
      if (w?.summary) facts.push(w.summary);
    }
    if (m.displayCurrency && m.displayCurrency !== 'INR') {
      const r = await call('convert_currency', { amount: m.budget, from: 'INR', to: m.displayCurrency });
      if (r?.converted) facts.push(`Budget is about ${r.converted} ${m.displayCurrency}.`);
    }
    return facts.join(' ') || 'No special weather conditions to report.';
  }

  #plan(req) {
    const m = req.mock;
    const { city, candidates, params, variantLabel, repair = false, attempt = 0 } = m;
    const rng = seededRng(
      seedFrom(`${city.id}|${params.tier}|${params.days}|${params.travelers}|${params.activityBudget}|${attempt}|${m.instruction || ''}`),
    );

    const base = selectPlacesForDays({ ...params, candidates });
    const days = base.map((d) => ({
      day: d.day,
      theme: d.theme,
      placeIds: [...d.placeIds],
      tip: d.placeIds.length
        ? `Start early to enjoy ${candidates.find((c) => c.place.id === d.placeIds[0])?.place.name ?? 'the first stop'} before the crowds.`
        : 'A light day: sleep in, wander and eat well.',
    }));

    const faultRate = repair ? this.faultRate * 0.35 : this.faultRate;
    const fault = rng() < faultRate ? FAULTS[Math.floor(rng() * FAULTS.length)] : null;
    if (fault) applyFault(fault, days, candidates, city, rng);

    const picked = days.flatMap((d) => d.placeIds).map((id) => candidates.find((c) => c.place.id === id)?.place).filter(Boolean);
    const plan = {
      title: `${variantLabel} in ${city.city}`.slice(0, 70),
      summary: `${params.days} day${params.days > 1 ? 's' : ''} of ${themeFor(picked).toLowerCase()} around ${areaFor(picked) || city.city}, planned for ${params.travelers} traveller${params.travelers > 1 ? 's' : ''} at a ${params.pace} pace.`.slice(0, 300),
      days,
      packing: packingFor(city, params.month),
    };
    let text = JSON.stringify(plan);
    if (fault === 'bad_json') text = text.slice(0, Math.max(10, text.length - 14));
    return text;
  }
}

function applyFault(fault, days, candidates, city, rng) {
  const withPlaces = days.filter((d) => d.placeIds.length);
  if (!withPlaces.length) return;
  const target = withPlaces[Math.floor(rng() * withPlaces.length)];
  const used = new Set(days.flatMap((d) => d.placeIds));
  const unused = candidates.filter((c) => !used.has(c.place.id)).map((c) => c.place);
  switch (fault) {
    case 'unknown_id':
      target.placeIds[0] = `${city.id}-hidden-gem-cafe`;
      break;
    case 'duplicate': {
      const other = days.find((d) => d !== target) || target;
      other.placeIds.push(target.placeIds[0]);
      break;
    }
    case 'over_budget': {
      const priciest = [...unused].sort((a, b) => b.costINR - a.costINR)[0];
      if (priciest) target.placeIds.push(priciest.id);
      break;
    }
    case 'overpacked':
      for (const p of unused.slice(0, 4)) target.placeIds.push(p.id);
      break;
    default:
  }
}

function packingFor(city, month) {
  const season = city.seasons.find((s) => (month ? s.months.includes(month) : true)) || city.seasons[0];
  const items = ['Comfortable walking shoes', 'Power bank and a reusable water bottle'];
  if (season?.rain === 'heavy') items.push('Light rain jacket or umbrella');
  else items.push('Sunscreen and a hat');
  if (season?.tempC?.[0] <= 12) items.push('Warm layers for the evening');
  return items;
}
