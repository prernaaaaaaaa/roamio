const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Roads are longer than straight lines; 1.3 is a common urban/hill planning factor.
export const ROAD_FACTOR = 1.3;

/**
 * Estimated road distance and travel time between two places in a city.
 * Time is rounded to 5 minutes, with a 5 minute minimum for any real hop.
 */
export function travelBetween(city, a, b) {
  if (!a || !b) return { km: 0, minutes: 0 };
  const straight = haversineKm(a, b);
  if (straight < 0.15) return { km: 0, minutes: 0 };
  const km = Math.round(straight * ROAD_FACTOR * 10) / 10;
  const speed = city?.avgSpeedKmph || 22;
  const minutes = Math.max(5, Math.round(((km / speed) * 60) / 5) * 5);
  return { km, minutes };
}
