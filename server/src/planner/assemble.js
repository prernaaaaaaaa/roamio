import { scheduleDay } from './scheduler.js';
import { travelBetween } from './geo.js';
import { computeCosts, units } from './costs.js';

const STAY_NOTE = {
  budget: 'Guesthouse, hostel or simple 2-star hotel',
  mid: '3-star hotel or boutique stay',
  comfort: '4-5 star hotel or heritage property',
};

/**
 * Turn a validated selection (which places on which day) into a finished itinerary.
 * Times, travel legs, meals and every rupee come from deterministic code and the knowledge base.
 */
export function assembleVariant({ city, variant, input, plannedBudget, selection, source, notes = [], attempts = 0 }) {
  const placesById = new Map(city.places.map((p) => [p.id, p]));
  const { travelers, days: totalDays } = input;
  const tier = city.tiers[variant.tier];
  const u = units({ travelers, days: totalDays });
  const warnings = [...notes];
  const kept = [];

  const days = [...selection.days]
    .sort((a, b) => a.day - b.day)
    .map((d) => {
      const places = d.placeIds.map((id) => placesById.get(id)).filter(Boolean);
      const sched = scheduleDay({ places, day: d.day, totalDays, city });
      for (const id of sched.dropped) {
        warnings.push(`Day ${d.day}: skipped ${placesById.get(id).name} because it did not fit the day's schedule.`);
      }

      let prev = null;
      const items = sched.items.map((it) => {
        if (it.kind !== 'place') return it;
        const p = placesById.get(it.placeId);
        const leg = prev ? travelBetween(city, prev, p) : null;
        prev = p;
        kept.push(p);
        return {
          ...it,
          area: p.area,
          category: p.category,
          lat: p.lat,
          lng: p.lng,
          costPerPerson: p.costINR,
          premium: Boolean(p.premium),
          durationHrs: p.durationHrs,
          travelFromPrev: leg && leg.minutes ? leg : null,
        };
      });

      const dayPlaces = items.filter((i) => i.kind === 'place');
      const areaCounts = new Map();
      for (const i of dayPlaces) areaCounts.set(i.area, (areaCounts.get(i.area) || 0) + 1);
      const area = [...areaCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      const activities = Math.round(dayPlaces.reduce((s, i) => s + i.costPerPerson, 0) * travelers);

      return {
        day: d.day,
        theme: d.theme,
        tip: d.tip || '',
        area,
        items,
        cost: {
          activities,
          food: travelers * tier.foodPerPersonDay,
          transport: u.vehicles * tier.transportPerVehicleDay,
          stay: d.day < totalDays ? u.rooms * tier.hotelPerRoomNight : 0,
        },
      };
    });

  const costs = computeCosts({ city, tier: variant.tier, travelers, days: totalDays, places: kept });
  const budget = {
    limit: input.budget,
    planned: plannedBudget,
    total: costs.total,
    remaining: input.budget - costs.total,
    utilisation: Math.round((costs.total / input.budget) * 1000) / 10,
    fits: costs.total <= input.budget,
  };

  return {
    id: variant.id,
    label: variant.label,
    tagline: variant.tagline,
    tier: variant.tier,
    title: String(selection.title || `${variant.label} in ${city.city}`).slice(0, 70),
    summary: String(selection.summary || '').slice(0, 300),
    packing: (selection.packing || []).slice(0, 4),
    source,
    attempts,
    days,
    costs,
    budget,
    stay: {
      rooms: u.rooms,
      nights: u.nights,
      perRoomNight: tier.hotelPerRoomNight,
      description: STAY_NOTE[variant.tier],
    },
    placeCount: kept.length,
    warnings,
  };
}
