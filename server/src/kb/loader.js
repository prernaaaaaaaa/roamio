import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { levenshtein, slug } from '../util/text.js';

export const CATEGORIES = [
  'heritage',
  'nature',
  'food',
  'adventure',
  'shopping',
  'spiritual',
  'nightlife',
  'relaxation',
  'culture',
];

const tierSchema = z.object({
  hotelPerRoomNight: z.number().positive(),
  foodPerPersonDay: z.number().positive(),
  transportPerVehicleDay: z.number().positive(),
});

const placeSchema = z.object({
  id: z.string().min(3),
  name: z.string().min(2),
  category: z.enum(CATEGORIES),
  area: z.string().min(2),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  hours: z.tuple([z.number().min(0).max(24), z.number().min(0).max(24)]),
  durationHrs: z.number().positive().max(10),
  costINR: z.number().min(0),
  best: z.enum(['morning', 'afternoon', 'evening', 'any']),
  premium: z.boolean().optional(),
  availableMonths: z.array(z.number().int().min(1).max(12)).optional(),
  tags: z.array(z.string()),
  desc: z.string().min(10),
});

const citySchema = z.object({
  city: z.string().min(2),
  state: z.string(),
  aliases: z.array(z.string()).default([]),
  tagline: z.string(),
  bestMonths: z.array(z.number().int().min(1).max(12)),
  avgSpeedKmph: z.number().positive(),
  signatureFood: z.string(),
  tiers: z.object({ budget: tierSchema, mid: tierSchema, comfort: tierSchema }),
  seasons: z.array(
    z.object({
      months: z.array(z.number().int().min(1).max(12)),
      label: z.string(),
      tempC: z.tuple([z.number(), z.number()]),
      rain: z.string(),
      note: z.string(),
    }),
  ),
  places: z.array(placeSchema).min(5),
});

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

/** Is a place available in the given month (1-12)? Places without a restriction are always available. */
export function isAvailable(place, month) {
  if (!month || !place.availableMonths) return true;
  return place.availableMonths.includes(month);
}

/**
 * Load and validate every destination file. Fails fast on malformed data so a bad
 * edit to the knowledge base is caught at startup rather than mid-request.
 */
export function loadKnowledgeBase(dir = DEFAULT_DIR) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (!files.length) throw new Error(`No destination files found in ${dir}`);

  const cities = new Map();
  const places = new Map();
  const hash = crypto.createHash('sha256');

  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    hash.update(raw);
    const parsed = citySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(`Invalid destination file ${file}: ${parsed.error.issues[0]?.message} at ${parsed.error.issues[0]?.path.join('.')}`);
    }
    const data = parsed.data;
    const id = slug(data.city);
    const cityPlaces = data.places.map((p) => ({ ...p, cityId: id }));
    for (const p of cityPlaces) {
      if (places.has(p.id)) throw new Error(`Duplicate place id: ${p.id}`);
      places.set(p.id, p);
    }
    cities.set(id, { ...data, id, places: cityPlaces });
  }

  const version = hash.digest('hex').slice(0, 12);

  function listCities() {
    return [...cities.values()].map((c) => ({
      id: c.id,
      city: c.city,
      state: c.state,
      tagline: c.tagline,
      bestMonths: c.bestMonths,
      placeCount: c.places.length,
      categories: [...new Set(c.places.map((p) => p.category))].sort(),
    }));
  }

  /** Resolve free text to a city: exact id/name/alias first, then fuzzy. */
  function findCity(query) {
    const q = slug(query || '');
    if (!q) return { city: null, suggestions: listCities().map((c) => c.city) };
    const flat = q.replace(/-/g, ' ');
    for (const c of cities.values()) {
      if (c.id === q || slug(c.city) === q) return { city: c, suggestions: [] };
      if (c.aliases.some((a) => slug(a) === q)) return { city: c, suggestions: [] };
    }
    for (const c of cities.values()) {
      const names = [c.city.toLowerCase(), ...c.aliases.map((a) => a.toLowerCase())];
      if (names.some((n) => flat.includes(n) || (flat.length >= 4 && n.startsWith(flat)))) {
        return { city: c, suggestions: [] };
      }
    }
    const scored = [...cities.values()]
      .map((c) => ({
        c,
        d: Math.min(
          levenshtein(q, c.id),
          ...c.aliases.map((a) => levenshtein(q, slug(a))),
        ),
      }))
      .sort((a, b) => a.d - b.d);
    if (scored[0] && scored[0].d <= 2) return { city: scored[0].c, suggestions: [] };
    return { city: null, suggestions: scored.slice(0, 3).map((s) => s.c.city) };
  }

  return { cities, places, version, listCities, findCity, getCity: (id) => cities.get(id), getPlace: (id) => places.get(id) };
}
