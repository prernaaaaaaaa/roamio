import { haversineKm } from './geo.js';
import { dayWindow, placeFitsDay } from './scheduler.js';
import { activitiesCost } from './costs.js';
import { isAvailable } from '../kb/loader.js';

/**
 * Deterministic place selection. This is the offline fallback and what the mock provider
 * "decides" with; the real model is asked to do the same job and is validated against the
 * same rules (see validate.js).
 */

export const PACE = {
  relaxed: { maxPlaces: 2, maxHours: 5 },
  moderate: { maxPlaces: 3, maxHours: 7 },
  packed: { maxPlaces: 4, maxHours: 9 },
};

export function dayCaps(pace, day, totalDays) {
  const base = PACE[pace] || PACE.moderate;
  const w = dayWindow(day, totalDays);
  const windowHours = (w.end - w.start) / 60;
  const edge = totalDays > 1 && (day === 1 || day === totalDays);
  return {
    maxPlaces: edge ? Math.max(1, base.maxPlaces - 1) : base.maxPlaces,
    maxHours: Math.min(base.maxHours, windowHours * 0.6),
  };
}

const THEME = {
  heritage: 'Heritage & history',
  nature: 'Nature & viewpoints',
  food: 'Food trail',
  adventure: 'Adventure',
  shopping: 'Markets & shopping',
  spiritual: 'Spiritual & temples',
  nightlife: 'Evening out',
  relaxation: 'Slow & scenic',
  culture: 'Culture & arts',
};

export function themeFor(places) {
  if (!places.length) return 'Free day';
  const counts = new Map();
  for (const p of places) counts.set(p.category, (counts.get(p.category) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2);
  return top.map(([c]) => THEME[c]).join(' & ');
}

export function areaFor(places) {
  if (!places.length) return '';
  const counts = new Map();
  for (const p of places) counts.set(p.area, (counts.get(p.area) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/** Which places a tier is willing to consider. */
function eligible(place, tier, activityBudgetINR, travelers) {
  if (!place.premium) return true;
  if (tier === 'budget') return false;
  const groupCost = place.costINR * travelers;
  if (tier === 'mid') return groupCost <= activityBudgetINR * 0.35;
  return groupCost <= activityBudgetINR;
}

function baseScore(c, { tier, interests }) {
  const p = c.place;
  let s = c.relevance * 2;
  if (interests?.includes(p.category)) s += 1.5;
  if (tier === 'budget') s += p.costINR === 0 ? 0.6 : -Math.min(p.costINR / 3000, 1);
  if (tier === 'mid' && p.premium) s -= 0.3;
  if (tier === 'comfort' && p.premium) s += 0.8;
  return s;
}

/**
 * @param {object} args
 * @param {Array<{place:object, relevance:number}>} args.candidates
 * @returns {Array<{day:number, theme:string, area:string, placeIds:string[]}>}
 */
export function selectPlacesForDays({ candidates, days, pace, tier, activityBudget: budgetINR, travelers, interests = [], month, exclude = new Set() }) {
  const pool = candidates.filter(
    (c) => !exclude.has(c.place.id) && isAvailable(c.place, month) && eligible(c.place, tier, budgetINR, travelers),
  );
  const used = new Set();
  let spent = 0;
  const out = [];

  for (let day = 1; day <= days; day++) {
    const caps = dayCaps(pace, day, days);
    const chosen = [];
    let hours = 0;
    const daysLeft = days - day + 1;

    for (;;) {
      if (chosen.length >= caps.maxPlaces) break;
      const remaining = budgetINR - spent;
      const allowance = (remaining / daysLeft) * 1.8;
      const options = pool.filter((c) => {
        const p = c.place;
        if (used.has(p.id) || !placeFitsDay(p, day, days)) return false;
        if (hours + p.durationHrs > caps.maxHours + 1e-6) return false;
        const group = p.costINR * travelers;
        if (group > remaining) return false;
        if (chosen.length > 0 && group > allowance) return false;
        return true;
      });
      if (!options.length) break;

      const anchor = chosen.length ? chosen[chosen.length - 1] : null;
      let best = null;
      for (const c of options) {
        const dist = anchor ? haversineKm(anchor, c.place) : 0;
        const value = baseScore(c, { tier, interests }) - 0.12 * dist;
        if (!best || value > best.value + 1e-9 || (Math.abs(value - best.value) <= 1e-9 && c.place.id < best.c.place.id)) {
          best = { c, value };
        }
      }
      chosen.push(best.c.place);
      used.add(best.c.place.id);
      hours += best.c.place.durationHrs;
      spent += best.c.place.costINR * travelers;
    }

    out.push({ day, theme: themeFor(chosen), area: areaFor(chosen), placeIds: chosen.map((p) => p.id) });
  }
  return out;
}

/** Remove the most expensive paid place (whole-group cost) until activities fit the budget. */
export function trimToBudget(outlineDays, { placesById, travelers, activityBudget: budgetINR }) {
  const days = outlineDays.map((d) => ({ ...d, placeIds: [...d.placeIds] }));
  const total = () => activitiesCost(days.flatMap((d) => d.placeIds.map((id) => placesById.get(id))), travelers);
  let guard = 200;
  while (total() > budgetINR && guard-- > 0) {
    let worst = null;
    days.forEach((d, di) =>
      d.placeIds.forEach((id, pi) => {
        const cost = placesById.get(id).costINR;
        if (!worst || cost > worst.cost) worst = { di, pi, cost };
      }),
    );
    if (!worst || worst.cost <= 0) break;
    days[worst.di].placeIds.splice(worst.pi, 1);
  }
  for (const d of days) {
    const ps = d.placeIds.map((id) => placesById.get(id));
    d.theme = themeFor(ps);
    d.area = areaFor(ps);
  }
  return days;
}
