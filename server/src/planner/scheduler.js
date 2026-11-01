import { travelBetween } from './geo.js';
import { fmtTime } from '../util/time.js';

export const LUNCH_MIN = 60;
export const DINNER_MIN = 90;
const EARLIEST_START = 5.5 * 60; // 05:30, for sunrise activities on non-arrival days

/** Nominal waking-hours window for each day of the trip (minutes since midnight). */
export function dayWindow(day, totalDays) {
  if (totalDays === 1) return { start: 540, end: 1380 }; // 09:00 - 23:00
  if (day === 1) return { start: 660, end: 1380 }; // arrival day: 11:00 - 23:00
  if (day === totalDays) return { start: 540, end: 960 }; // departure day: 09:00 - 16:00
  return { start: 540, end: 1380 };
}

const mins = (hours) => Math.round(hours * 60);

/** Can this place be visited at all on the given day, given its opening hours and the day window? */
export function placeFitsDay(place, day, totalDays) {
  const w = dayWindow(day, totalDays);
  const earliest = day === 1 && totalDays > 1 ? w.start : EARLIEST_START;
  const start = Math.max(mins(place.hours[0]), earliest);
  const end = Math.min(mins(place.hours[1]), w.end);
  return start + mins(place.durationHrs) <= end;
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  arr.forEach((x, i) => {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([x, ...p]);
  });
  return out;
}

function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [head, ...tail] = arr;
  return [...combinations(tail, k - 1).map((c) => [head, ...c]), ...combinations(tail, k)];
}

function partOfDay(startMin) {
  if (startMin < 720) return 'morning';
  if (startMin < 990) return 'afternoon';
  return 'evening';
}

/** Simulate a visiting order. Returns null when the order is infeasible. */
function simulate(order, window, city) {
  let t = window.start;
  let prev = null;
  let km = 0;
  let wait = 0;
  let lunchDone = false;
  let penalty = 0;
  const items = [];

  for (const p of order) {
    const tr = travelBetween(city, prev, p);
    let start = t + tr.minutes;

    if (!lunchDone && start >= 765 && p.category !== 'food') {
      const lunchStart = Math.max(t, 720);
      items.push({ kind: 'meal', meal: 'lunch', startMin: lunchStart, endMin: lunchStart + LUNCH_MIN, near: prev });
      t = lunchStart + LUNCH_MIN;
      lunchDone = true;
      start = t + tr.minutes;
    }

    const open = mins(p.hours[0]);
    const close = mins(p.hours[1]);
    if (start < open) {
      wait += open - start;
      start = open;
    }
    const end = start + mins(p.durationHrs);
    if (end > close || end > window.end) return null;

    if (p.category === 'food' && start >= 660 && start <= 930) lunchDone = true;

    const part = partOfDay(start);
    if (p.best === 'morning' && part !== 'morning') penalty += 4;
    if (p.best === 'afternoon' && part === 'evening') penalty += 2;
    if (p.best === 'evening' && part !== 'evening') penalty += 4;

    km += tr.km;
    items.push({ kind: 'place', place: p, startMin: start, endMin: end });
    t = end;
    prev = p;
  }

  const lastPlace = [...items].reverse().find((i) => i.kind === 'place');
  const hasDinnerPlace = items.some((i) => i.kind === 'place' && i.place.category === 'food' && i.startMin >= 1050);
  if (lastPlace && !hasDinnerPlace && t <= 1230 && window.end >= 1260 && t + DINNER_MIN <= window.end) {
    const dinnerStart = Math.max(t, 1170);
    items.push({ kind: 'meal', meal: 'dinner', startMin: dinnerStart, endMin: dinnerStart + DINNER_MIN, near: prev });
  }

  return { items, km, wait, score: km + wait * 0.05 + penalty, endMin: t };
}

function bestOrder(places, window, city) {
  if (!places.length) return { sim: { items: [], km: 0, wait: 0, score: 0, endMin: window.start } };
  const orders = places.length <= 7 ? permutations(places) : [[...places].sort((a, b) => a.hours[1] - b.hours[1])];
  let best = null;
  for (const order of orders) {
    const sim = simulate(order, window, city);
    if (sim && (!best || sim.score < best.sim.score - 1e-9)) best = { sim, order };
  }
  return best;
}

const mealNote = (city, near, meal) => {
  const food = city.signatureFood.split(',').slice(0, 3).map((s) => s.trim()).join(', ');
  const where = near ? ` near ${near.area}` : '';
  return meal === 'lunch' ? `Take a proper lunch break${where}. Local favourites: ${food}.` : `Dinner${where}. Local favourites: ${food}.`;
};

/**
 * Deterministic day scheduler. Finds the visiting order that respects opening hours with the least
 * travel, inserts meal breaks, and drops (and reports) any place that cannot fit the day. Used by the
 * mock provider, by the offline fallback, and to repair days that fail validation.
 *
 * @returns {{items:Array, dropped:string[], window:{start:number,end:number}}}
 */
export function scheduleDay({ places, day, totalDays, city }) {
  const base = dayWindow(day, totalDays);
  // Extend the window earlier only when a place needs a sunrise start (never on the arrival day).
  let start = base.start;
  if (!(day === 1 && totalDays > 1)) {
    for (const p of places) {
      if (mins(p.hours[0]) < start && mins(p.hours[1]) <= start + mins(p.durationHrs)) {
        start = Math.min(start, Math.max(mins(p.hours[0]), EARLIEST_START));
      }
    }
  }
  const window = { start, end: base.end };

  let best = bestOrder(places, window, city);
  let dropped = [];
  if (!best) {
    for (let k = 1; k <= places.length && !best; k++) {
      let candidate = null;
      for (const removal of combinations(places.map((p) => p.id), k)) {
        const keep = places.filter((p) => !removal.includes(p.id));
        const attempt = bestOrder(keep, window, city);
        if (attempt && (!candidate || attempt.sim.score < candidate.attempt.sim.score)) candidate = { attempt, removal };
      }
      if (candidate) {
        best = candidate.attempt;
        dropped = candidate.removal;
      }
    }
    if (!best) best = { sim: { items: [], km: 0, wait: 0, score: 0, endMin: window.start } };
  }

  const items = best.sim.items.map((it) => {
    if (it.kind === 'meal') {
      return {
        kind: 'meal',
        startTime: fmtTime(it.startMin),
        endTime: fmtTime(it.endMin),
        placeId: '',
        title: it.meal === 'lunch' ? 'Lunch break' : 'Dinner',
        note: mealNote(city, it.near, it.meal),
      };
    }
    return {
      kind: 'place',
      startTime: fmtTime(it.startMin),
      endTime: fmtTime(it.endMin),
      placeId: it.place.id,
      title: it.place.name,
      note: it.place.desc,
    };
  });

  if (!items.length) {
    items.push({
      kind: 'rest',
      startTime: fmtTime(window.start),
      endTime: fmtTime(window.start + 120),
      placeId: '',
      title: 'Free time',
      note: 'Open time to relax, revisit a favourite spot or explore at your own pace.',
    });
  }

  return { items, dropped, window };
}
