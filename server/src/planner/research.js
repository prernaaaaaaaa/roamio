import { buildTools, seasonFor } from '../tools/registry.js';
import { RESEARCH_SYSTEM, researchPrompt } from './prompts.js';
import { isAbort } from '../llm/errors.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const seasonLine = (s) => (s ? `${s.label}: ${s.tempC[0]}-${s.tempC[1]} C, rain ${s.rain}. ${s.note}` : '');

/**
 * Research step: the model may call tools (season data, weather, currency) to learn the
 * conditions for this trip. The numbers that reach the planning prompt come from the tool
 * results, never from the model's prose, so the model cannot make up weather.
 *
 * The step is skipped entirely (no model call) when there is nothing to look up.
 */
export async function runResearch({ llm, city, input, stats, signal, fetchImpl, today }) {
  const season = seasonFor(city, input.month);
  const bestTime = !season && !input.month ? `Best time to visit: ${city.bestMonths.map((m) => MONTHS[m - 1]).join(', ')}.` : '';
  const out = { season, weather: null, currency: null, narration: '', brief: seasonLine(season) || bestTime, source: 'knowledge-base' };
  if (!input.startDate && input.currency === 'INR') return out;

  const { declarations, handlers } = buildTools({ city, fetchImpl, today });
  const before = stats.toolCalls.length;
  try {
    const res = await llm.generate(
      {
        task: 'research',
        system: RESEARCH_SYSTEM,
        prompt: researchPrompt({ city, input }),
        tools: declarations,
        handlers,
        maxOutputTokens: 400,
        mock: { month: input.month, startDate: input.startDate, days: input.days, displayCurrency: input.currency, budget: input.budget },
      },
      { stats, signal },
    );
    out.narration = res.text.trim().slice(0, 400);
    out.source = 'model+tools';
  } catch (err) {
    if (isAbort(err) || signal?.aborted) throw err;
    stats.warnings.push(`Research step used built-in data (${err.code || err.message}).`);
  }

  // Guarantee the facts even if the model skipped a tool: call it ourselves and label it.
  const called = new Set(stats.toolCalls.slice(before).map((c) => c.name));
  const direct = async (name, args) => {
    const t0 = Date.now();
    const result = await handlers[name](args);
    stats.toolCalls.push({ name, args, result, ms: Date.now() - t0, source: 'pipeline' });
  };
  if (input.startDate && !called.has('get_weather_forecast')) await direct('get_weather_forecast', { startDate: input.startDate, days: input.days });
  if (input.currency !== 'INR' && !called.has('convert_currency')) {
    await direct('convert_currency', { amount: input.budget, from: 'INR', to: input.currency });
  }

  for (const c of stats.toolCalls.slice(before)) {
    if (c.name === 'get_weather_forecast' && c.result && !c.result.error && !out.weather) out.weather = c.result;
    if (c.name === 'convert_currency' && c.result && !c.result.error && c.args?.from === 'INR' && c.args?.to === input.currency) {
      out.currency = c.result;
    }
  }
  out.brief = [seasonLine(season) || bestTime, out.weather?.summary].filter(Boolean).join(' ');
  return out;
}
