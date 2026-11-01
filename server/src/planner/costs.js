/**
 * Deterministic cost engine. The LLM never estimates money: every rupee in a plan comes
 * from the knowledge base through these functions, so budget compliance is a property of
 * the code rather than a hope about the model.
 *
 * Assumptions (also shown in the UI and README):
 *  - N days = N-1 nights (a 1-day trip has no stay).
 *  - Double occupancy: ceil(travelers / 2) rooms.
 *  - Local transport: one vehicle per 4 travellers per day.
 *  - Food is a per-person daily allowance by tier; meals are not itemised.
 *  - Activity cost is per person from the knowledge base.
 *  - 5% contingency on top. Travel to and from the destination is excluded.
 */

export const CONTINGENCY_RATE = 0.05;

export const VARIANTS = [
  { id: 'budget', label: 'Budget Explorer', tier: 'budget', tagline: 'Lowest cost: simple stays, local transport, free and low-cost sights.' },
  { id: 'balanced', label: 'Balanced Journey', tier: 'mid', tagline: 'Comfortable stays, a good mix of sights and a few paid experiences.' },
  { id: 'comfort', label: 'Comfort & Experiences', tier: 'comfort', tagline: 'Premium stays, private transport and standout experiences.' },
];

export function units({ travelers, days }) {
  return {
    rooms: Math.ceil(travelers / 2),
    nights: Math.max(days - 1, 0),
    vehicles: Math.ceil(travelers / 4),
  };
}

/** Everything except activities and contingency. */
export function baseline({ city, tier, travelers, days }) {
  const t = city.tiers[tier];
  const u = units({ travelers, days });
  const stay = u.rooms * u.nights * t.hotelPerRoomNight;
  const food = travelers * days * t.foodPerPersonDay;
  const transport = u.vehicles * days * t.transportPerVehicleDay;
  return { stay, food, transport, base: stay + food + transport, ...u };
}

export const activitiesCost = (places, travelers) =>
  Math.round(places.reduce((s, p) => s + p.costINR, 0) * travelers);

export function computeCosts({ city, tier, travelers, days, places }) {
  const b = baseline({ city, tier, travelers, days });
  const activities = activitiesCost(places, travelers);
  const subtotal = b.base + activities;
  // Round contingency up so total can never exceed a budget derived with activityBudget().
  const contingency = Math.ceil(subtotal * CONTINGENCY_RATE);
  return {
    stay: b.stay,
    food: b.food,
    transport: b.transport,
    activities,
    contingency,
    total: subtotal + contingency,
    rooms: b.rooms,
    nights: b.nights,
    vehicles: b.vehicles,
  };
}

/** Largest activity spend (INR, whole group) that keeps total <= budget. Negative = tier infeasible. */
export function activityBudget({ city, tier, travelers, days, budget }) {
  const b = baseline({ city, tier, travelers, days });
  return Math.floor((budget - 1) / (1 + CONTINGENCY_RATE)) - b.base;
}

/** Smallest budget at which the cheapest tier is feasible with zero paid activities. */
export function minimumBudget({ city, travelers, days }) {
  const b = baseline({ city, tier: 'budget', travelers, days });
  return Math.ceil(b.base * (1 + CONTINGENCY_RATE)) + 1;
}
