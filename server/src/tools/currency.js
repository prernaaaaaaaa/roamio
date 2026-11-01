export const DISPLAY_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'AUD', 'CAD', 'SGD'];

// Approximate rates used only when the live source is unreachable. Always flagged in the result.
const STATIC_PER_INR = { INR: 1, USD: 0.0115, EUR: 0.0099, GBP: 0.0086, AED: 0.042, AUD: 0.0175, CAD: 0.016, SGD: 0.0148 };

const cache = new Map();
const TTL = 60 * 60 * 1000;

/** Convert an amount using Frankfurter (ECB reference rates). Falls back to approximate static rates. */
export async function convertCurrency({ amount, from = 'INR', to, fetchImpl = fetch, timeoutMs = 5000 }) {
  from = String(from).toUpperCase();
  to = String(to).toUpperCase();
  if (!DISPLAY_CURRENCIES.includes(from) || !DISPLAY_CURRENCIES.includes(to)) {
    return { error: `Unsupported currency. Use one of ${DISPLAY_CURRENCIES.join(', ')}.` };
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0) return { error: 'amount must be a non-negative number' };
  if (from === to) return { amount: amt, from, to, rate: 1, converted: amt, source: 'identity' };

  const key = `${from}>${to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return build(amt, from, to, hit.rate, hit.asOf, 'live');

  try {
    const res = await fetchImpl(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`rate source responded ${res.status}`);
    const j = await res.json();
    const rate = j?.rates?.[to];
    if (!Number.isFinite(rate)) throw new Error('rate missing');
    cache.set(key, { rate, asOf: j.date, at: Date.now() });
    return build(amt, from, to, rate, j.date, 'live');
  } catch {
    const rate = STATIC_PER_INR[to] / STATIC_PER_INR[from];
    return build(amt, from, to, rate, null, 'static-approx');
  }
}

function build(amount, from, to, rate, asOf, source) {
  return { amount, from, to, rate: Number(rate.toPrecision(6)), converted: Math.round(amount * rate * 100) / 100, asOf, source };
}

export const _clearCurrencyCache = () => cache.clear();
