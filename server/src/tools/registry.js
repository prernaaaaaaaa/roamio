import { getWeather } from './weather.js';
import { convertCurrency, DISPLAY_CURRENCIES } from './currency.js';

/** Season record for a city and month (1-12), or null. Pure knowledge-base lookup. */
export function seasonFor(city, month) {
  if (!month) return null;
  return city.seasons.find((s) => s.months.includes(month)) ?? null;
}

export function cityCenter(city) {
  const n = city.places.length;
  return {
    lat: city.places.reduce((s, p) => s + p.lat, 0) / n,
    lng: city.places.reduce((s, p) => s + p.lng, 0) / n,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Tools the model may call while researching a trip. The declarations are what the model sees;
 * the handlers validate every argument themselves because model-supplied arguments are untrusted.
 * The destination is fixed by the server, so the model cannot be steered to look up anything else.
 */
export function buildTools({ city, fetchImpl = fetch, today = new Date() }) {
  const center = cityCenter(city);

  const declarations = [
    {
      name: 'get_season_info',
      description: 'Typical climate and travel notes for the destination in a given month. Always available, no network.',
      parametersJsonSchema: {
        type: 'object',
        properties: { month: { type: 'integer', minimum: 1, maximum: 12, description: 'Month number, 1 = January' } },
        required: ['month'],
      },
    },
    {
      name: 'get_weather_forecast',
      description:
        'Weather for the trip dates at the destination. Returns a real forecast if the trip starts within 16 days, otherwise typical weather for the same dates last year.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'First day of the trip, YYYY-MM-DD' },
          days: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['startDate', 'days'],
      },
    },
    {
      name: 'convert_currency',
      description: 'Convert an amount between currencies using current reference rates.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          from: { type: 'string', enum: DISPLAY_CURRENCIES },
          to: { type: 'string', enum: DISPLAY_CURRENCIES },
        },
        required: ['amount', 'from', 'to'],
      },
    },
  ];

  const handlers = {
    async get_season_info({ month }) {
      const m = Number(month);
      if (!Number.isInteger(m) || m < 1 || m > 12) return { error: 'month must be 1-12' };
      const s = seasonFor(city, m);
      return s ? { city: city.city, month: m, ...s } : { city: city.city, month: m, label: 'No seasonal data', tempC: null, rain: 'unknown', note: '' };
    },
    async get_weather_forecast({ startDate, days }) {
      const d = Math.min(10, Math.max(1, Number(days) || 1));
      if (!DATE_RE.test(String(startDate)) || Number.isNaN(Date.parse(startDate))) return { error: 'startDate must be YYYY-MM-DD' };
      try {
        return await getWeather({ ...center, startDate, days: d, fetchImpl, today });
      } catch (err) {
        return { error: `Weather service unavailable: ${err.message}` };
      }
    },
    async convert_currency({ amount, from, to }) {
      return convertCurrency({ amount, from, to, fetchImpl });
    },
  };

  return { declarations, handlers };
}
