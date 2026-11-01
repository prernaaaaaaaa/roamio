import test from 'node:test';
import assert from 'node:assert/strict';
import { kb } from './helpers.js';
import { getWeather, planWindow } from '../src/tools/weather.js';
import { convertCurrency, _clearCurrencyCache } from '../src/tools/currency.js';
import { buildTools } from '../src/tools/registry.js';

const today = new Date('2026-11-01T00:00:00Z');
const json = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });

test('weather window: forecast inside 16 days, same dates last year beyond it', () => {
  assert.equal(planWindow({ startDate: '2026-11-05', days: 3, today }).mode, 'forecast');
  const far = planWindow({ startDate: '2026-12-20', days: 3, today });
  assert.deepEqual([far.mode, far.from, far.to], ['typical', '2025-12-20', '2025-12-22']);
  assert.equal(planWindow({ startDate: '2026-11-10', days: 10, today }).mode, 'typical', 'window crossing the limit uses history');
});

test('weather: summarises a forecast and surfaces upstream failures', async () => {
  const body = { daily: { time: ['2026-11-05', '2026-11-06'], temperature_2m_max: [29, 31], temperature_2m_min: [18, 19], precipitation_probability_max: [10, 70] } };
  const w = await getWeather({ lat: 1, lng: 2, startDate: '2026-11-05', days: 2, fetchImpl: json(body), today });
  assert.equal(w.source, 'forecast');
  assert.match(w.summary, /18-31 C, rain likely on 1 of 2 days/);
  await assert.rejects(getWeather({ lat: 1, lng: 2, startDate: '2026-11-05', days: 2, fetchImpl: json({}, false), today }));
});

test('currency: live rate, caching, static fallback, and bad input', async () => {
  _clearCurrencyCache();
  let hits = 0;
  const live = async () => { hits++; return { ok: true, json: async () => ({ date: '2026-10-30', rates: { USD: 0.012 } }) }; };
  const a = await convertCurrency({ amount: 50000, from: 'INR', to: 'USD', fetchImpl: live });
  assert.equal(a.converted, 600);
  assert.equal(a.source, 'live');
  await convertCurrency({ amount: 1, from: 'INR', to: 'USD', fetchImpl: live });
  assert.equal(hits, 1, 'second call served from cache');
  _clearCurrencyCache();
  const down = await convertCurrency({ amount: 1000, to: 'EUR', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(down.source, 'static-approx');
  assert.ok((await convertCurrency({ amount: 1, to: 'XXX' })).error);
  assert.equal((await convertCurrency({ amount: 5, from: 'INR', to: 'INR' })).converted, 5);
});

test('tool handlers validate untrusted model arguments', async () => {
  const { handlers, declarations } = buildTools({ city: kb.getCity('goa'), fetchImpl: json({}, false), today });
  assert.equal(declarations.length, 3);
  assert.ok((await handlers.get_season_info({ month: 13 })).error);
  assert.ok((await handlers.get_weather_forecast({ startDate: 'tomorrow', days: 2 })).error);
  assert.match((await handlers.get_weather_forecast({ startDate: '2026-11-05', days: 2 })).error, /unavailable/);
  assert.equal((await handlers.get_season_info({ month: 12 })).label, 'Peak season');
});
