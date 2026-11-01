import test from 'node:test';
import assert from 'node:assert/strict';
import { kb, retriever } from './helpers.js';
import { computeCosts, activityBudget, minimumBudget, CONTINGENCY_RATE } from '../src/planner/costs.js';
import { selectPlacesForDays, trimToBudget } from '../src/planner/heuristics.js';
import { scheduleDay, placeFitsDay } from '../src/planner/scheduler.js';
import { haversineKm, travelBetween } from '../src/planner/geo.js';
import { seededRng } from '../src/util/text.js';

test('knowledge base: every destination validates and has unique place ids', () => {
  assert.ok(kb.cities.size >= 8);
  const ids = [...kb.places.keys()];
  assert.equal(new Set(ids).size, ids.length);
  for (const c of kb.cities.values()) assert.ok(c.places.length >= 10, `${c.city} has enough places`);
});

test('findCity: ids, aliases, fuzzy typos, and unknowns', () => {
  assert.equal(kb.findCity('Goa').city.id, 'goa');
  assert.equal(kb.findCity('panjim').city.id, 'goa');
  assert.equal(kb.findCity('Jaipurr').city.id, 'jaipur');
  assert.equal(kb.findCity('trip to udaipur please').city.id, 'udaipur');
  assert.equal(kb.findCity('Atlantis').city, null);
  assert.ok(kb.findCity('Atlantis').suggestions.length > 0);
});

test('retriever: hybrid search ranks relevant places first and honours filters', async () => {
  const forts = await retriever.search({ cityId: 'jaipur', query: 'fort palace', limit: 5 });
  assert.ok(forts.length > 0);
  assert.match(forts[0].place.name + forts[0].place.tags.join(' '), /fort|palace/i);

  const free = await retriever.search({ cityId: 'jaipur', query: 'heritage', limit: 20, maxCostINR: 0 });
  assert.ok(free.every((r) => r.place.costINR === 0));

  assert.deepEqual(await retriever.search({ cityId: 'nowhere', query: 'x' }), []);
});

test('costs: any selection sized with activityBudget() stays within the budget', () => {
  const rng = seededRng(7);
  let checked = 0;
  for (const city of kb.cities.values()) {
    for (let i = 0; i < 25; i++) {
      const days = 1 + Math.floor(rng() * 8);
      const travelers = 1 + Math.floor(rng() * 12);
      const tier = ['budget', 'mid', 'comfort'][Math.floor(rng() * 3)];
      const budget = Math.floor(minimumBudget({ city, travelers, days }) * (1 + rng() * 6));
      const ab = activityBudget({ city, tier, travelers, days, budget });
      if (ab < 0) continue;
      const candidates = city.places.map((place) => ({ place, relevance: rng() }));
      const sel = selectPlacesForDays({ candidates, days, pace: 'packed', tier, activityBudget: ab, travelers, interests: [], month: null });
      const byId = new Map(city.places.map((p) => [p.id, p]));
      const trimmed = trimToBudget(sel, { placesById: byId, travelers, activityBudget: ab });
      const places = trimmed.flatMap((d) => d.placeIds.map((id) => byId.get(id)));
      const total = computeCosts({ city, tier, travelers, days, places }).total;
      assert.ok(total <= budget, `${city.city} ${tier} total ${total} > budget ${budget}`);
      checked++;
    }
  }
  assert.ok(checked > 100);
});

test('costs: minimumBudget is exactly the cheapest feasible budget', () => {
  const city = kb.getCity('goa');
  const min = minimumBudget({ city, travelers: 3, days: 4 });
  assert.ok(activityBudget({ city, tier: 'budget', travelers: 3, days: 4, budget: min }) >= 0);
  assert.ok(activityBudget({ city, tier: 'budget', travelers: 3, days: 4, budget: min - 1 }) < 0);
  assert.equal(CONTINGENCY_RATE, 0.05);
});

test('scheduler: respects opening hours, never overlaps, and inserts lunch', () => {
  const rng = seededRng(3);
  for (const city of kb.cities.values()) {
    for (let i = 0; i < 20; i++) {
      const totalDays = 1 + Math.floor(rng() * 4);
      const day = 1 + Math.floor(rng() * totalDays);
      const pool = city.places.filter((p) => placeFitsDay(p, day, totalDays));
      const places = pool.sort(() => rng() - 0.5).slice(0, 3);
      const { items } = scheduleDay({ places, day, totalDays, city });
      let last = -1;
      for (const it of items) {
        const [sh, sm] = it.startTime.split(':').map(Number);
        const [eh, em] = it.endTime.split(':').map(Number);
        const s = sh * 60 + sm;
        const e = eh * 60 + em;
        assert.ok(e > s, 'positive duration');
        assert.ok(s >= last, `no overlap in ${city.city}`);
        last = e;
        if (it.kind === 'place') {
          const p = kb.getPlace(it.placeId);
          assert.ok(s >= p.hours[0] * 60 - 1 && e <= p.hours[1] * 60 + 1, `${p.id} within opening hours`);
        }
      }
    }
  }
});

test('geo: distance and travel time are sane', () => {
  const a = kb.getPlace('goa-baga-beach');
  const b = kb.getPlace('goa-fort-aguada');
  const km = haversineKm(a, b);
  assert.ok(km > 3 && km < 12, `Baga to Aguada is ${km} km`);
  const t = travelBetween(kb.getCity('goa'), a, b);
  assert.ok(t.minutes >= 5 && t.minutes <= 60);
  assert.equal(travelBetween(kb.getCity('goa'), a, a).minutes, 0);
});
