import { dayCaps, themeFor, trimToBudget } from './heuristics.js';
import { dayWindow, placeFitsDay } from './scheduler.js';
import { isAvailable } from '../kb/loader.js';
import { fmtTime } from '../util/time.js';

/**
 * Domain validation for a model-proposed itinerary.
 *
 * Schema validation (Zod) only proves the JSON has the right shape. These rules prove the plan is
 * actually possible: every place exists and was offered, nothing is used twice, each place can be
 * visited on its day, the pace limits hold and the activity spend fits the budget. The model is
 * a proposer; this file is the referee.
 *
 * ctx = { days, pace, month, travelers, activityBudget, offered:Set<string>, placesById:Map }
 */
export function validateSelection(sel, ctx) {
  const { days: n, pace, month, travelers, activityBudget, offered, placesById } = ctx;
  const issues = [];

  if (sel.days.length !== n) issues.push(`Expected exactly ${n} day entries, got ${sel.days.length}.`);
  const numbers = sel.days.map((d) => d.day);
  for (let i = 1; i <= n; i++) {
    const count = numbers.filter((x) => x === i).length;
    if (count === 0) issues.push(`Day ${i} is missing.`);
    if (count > 1) issues.push(`Day ${i} appears ${count} times; each day number must appear once.`);
  }

  const seen = new Map();
  let activityTotal = 0;
  const spend = [];

  for (const d of sel.days) {
    if (d.day < 1 || d.day > n) {
      issues.push(`Day number ${d.day} is outside 1..${n}.`);
      continue;
    }
    const caps = dayCaps(pace, d.day, n);
    const w = dayWindow(d.day, n);
    let count = 0;
    let hours = 0;
    for (const id of d.placeIds) {
      const p = placesById.get(id);
      if (!p || !offered.has(id)) {
        issues.push(`Day ${d.day}: "${id}" is not in the candidate list. Use only ids from the list.`);
        continue;
      }
      if (seen.has(id)) {
        issues.push(`"${p.name}" (${id}) is used on day ${seen.get(id)} and day ${d.day}. Use each place at most once.`);
        continue;
      }
      seen.set(id, d.day);
      if (!isAvailable(p, month)) {
        issues.push(`Day ${d.day}: ${p.name} is not available in this month.`);
      } else if (!placeFitsDay(p, d.day, n)) {
        issues.push(
          `Day ${d.day}: ${p.name} cannot fit this day (open ${p.hours[0]}-${p.hours[1]}h, needs ${p.durationHrs}h, day window ${fmtTime(w.start)}-${fmtTime(w.end)}).`,
        );
      }
      count++;
      hours += p.durationHrs;
      activityTotal += p.costINR * travelers;
      spend.push(p);
    }
    if (count > caps.maxPlaces) issues.push(`Day ${d.day}: ${count} places exceeds the limit of ${caps.maxPlaces} for a ${pace} pace.`);
    if (hours > caps.maxHours + 1e-6) issues.push(`Day ${d.day}: ${hours}h of sightseeing exceeds the ${Math.round(caps.maxHours * 10) / 10}h limit.`);
  }

  if (activityTotal > activityBudget) {
    const top = [...spend].sort((a, b) => b.costINR - a.costINR).slice(0, 2).map((p) => `${p.name} (${p.id}, INR ${p.costINR}/person)`);
    issues.push(
      `Activities cost INR ${activityTotal} for ${travelers} traveller(s) but the activity budget is INR ${Math.max(0, activityBudget)}. Remove or swap the most expensive places${top.length ? `, e.g. ${top.join(', ')}` : ''}.`,
    );
  }
  return issues;
}

/**
 * Deterministic clean-up of a schema-valid but rule-breaking plan: keep what is valid, drop what
 * is not, then trim spend to the budget. Used when repair attempts run out.
 */
export function sanitizeSelection(sel, ctx) {
  const { days: n, pace, month, travelers, activityBudget, offered, placesById } = ctx;
  const used = new Set();
  const dropped = [];
  const out = [];

  for (let day = 1; day <= n; day++) {
    const entry = sel.days.find((d) => d.day === day);
    const caps = dayCaps(pace, day, n);
    const kept = [];
    let hours = 0;
    for (const id of entry?.placeIds ?? []) {
      const p = placesById.get(id);
      let reason = null;
      if (!p || !offered.has(id)) reason = 'not in the candidate list';
      else if (used.has(id)) reason = 'already used on another day';
      else if (!isAvailable(p, month)) reason = 'not available this month';
      else if (!placeFitsDay(p, day, n)) reason = 'does not fit this day';
      else if (kept.length >= caps.maxPlaces) reason = 'day is full';
      else if (hours + p.durationHrs > caps.maxHours + 1e-6) reason = 'too many hours';
      if (reason) {
        dropped.push({ id, day, reason });
        continue;
      }
      kept.push(id);
      used.add(id);
      hours += p.durationHrs;
    }
    const places = kept.map((id) => placesById.get(id));
    out.push({ day, theme: entry?.theme || themeFor(places), tip: entry?.tip ?? '', placeIds: kept, area: '' });
  }

  const before = out.map((d) => d.placeIds.length);
  const trimmed = trimToBudget(out, { placesById, travelers, activityBudget });
  const days = trimmed.map((d, i) => {
    if (d.placeIds.length === before[i]) return { ...d, theme: out[i].theme };
    return d;
  });
  for (const [i, d] of days.entries()) {
    for (const id of out[i].placeIds) if (!d.placeIds.includes(id)) dropped.push({ id, day: d.day, reason: 'over the activity budget' });
  }
  return { days, dropped, keptCount: days.reduce((s, d) => s + d.placeIds.length, 0) };
}
