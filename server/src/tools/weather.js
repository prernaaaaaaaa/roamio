/**
 * Weather lookup via Open-Meteo (free, no API key).
 *  - trip within the 16-day forecast window  -> real forecast
 *  - trip further out (or in the past)       -> the same calendar dates one year earlier ("typical")
 */

const DAY_MS = 86_400_000;
const fmt = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(`${s}T00:00:00Z`);

export function planWindow({ startDate, days, today = new Date() }) {
  const start = parse(startDate);
  const end = new Date(start.getTime() + (days - 1) * DAY_MS);
  const t0 = parse(fmt(today));
  const limit = new Date(t0.getTime() + 15 * DAY_MS);
  if (start >= t0 && end <= limit) return { mode: 'forecast', from: fmt(start), to: fmt(end) };
  // Same dates last year (or the actual dates when they are already in the past).
  const shift = start >= t0 ? 1 : 0;
  const s = new Date(start);
  const e = new Date(end);
  s.setUTCFullYear(s.getUTCFullYear() - shift);
  e.setUTCFullYear(e.getUTCFullYear() - shift);
  return { mode: 'typical', from: fmt(s), to: fmt(e) };
}

export async function getWeather({ lat, lng, startDate, days, fetchImpl = fetch, timeoutMs = 6000, today = new Date() }) {
  const w = planWindow({ startDate, days, today });
  const base = w.mode === 'forecast' ? 'https://api.open-meteo.com/v1/forecast' : 'https://archive-api.open-meteo.com/v1/archive';
  const daily = w.mode === 'forecast' ? 'temperature_2m_max,temperature_2m_min,precipitation_probability_max' : 'temperature_2m_max,temperature_2m_min,precipitation_sum';
  const url = `${base}?latitude=${lat}&longitude=${lng}&daily=${daily}&timezone=auto&start_date=${w.from}&end_date=${w.to}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Open-Meteo responded ${res.status}`);
  const j = await res.json();
  const d = j.daily;
  if (!d?.time?.length) throw new Error('Open-Meteo returned no daily data');

  const rows = d.time.map((date, i) => ({
    date,
    tmax: Math.round(d.temperature_2m_max[i]),
    tmin: Math.round(d.temperature_2m_min[i]),
    rain: w.mode === 'forecast' ? d.precipitation_probability_max[i] : d.precipitation_sum[i],
  }));
  const hi = Math.max(...rows.map((r) => r.tmax));
  const lo = Math.min(...rows.map((r) => r.tmin));
  const rainy = rows.filter((r) => (w.mode === 'forecast' ? r.rain >= 50 : r.rain >= 2.5)).length;
  const label = w.mode === 'forecast' ? 'Forecast' : `Typical weather (same dates, ${w.from.slice(0, 4)})`;
  const summary = `${label}: ${lo}-${hi} C${rainy ? `, rain likely on ${rainy} of ${rows.length} days` : ', mostly dry'}.`;
  return { source: w.mode === 'forecast' ? 'forecast' : 'historical-same-dates', days: rows, summary };
}
