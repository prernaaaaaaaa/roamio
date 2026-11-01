import { z } from 'zod';
import { CATEGORIES } from '../kb/loader.js';
import { clean } from '../util/text.js';
import { DISPLAY_CURRENCIES } from '../tools/currency.js';

export const PACES = ['relaxed', 'moderate', 'packed'];
export const VARIANT_IDS = ['budget', 'balanced', 'comfort'];

const isRealDate = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false;
  const now = Date.now();
  return d.getTime() > now - 2 * 86_400_000 && d.getTime() < now + 2 * 365 * 86_400_000;
};

/** What a traveller may ask for. Everything outside these bounds is rejected before any model call. */
export const PlanRequestSchema = z.object({
  destination: z.string().trim().min(2, 'Enter a destination').max(60),
  days: z.coerce.number().int().min(1).max(10),
  travelers: z.coerce.number().int().min(1).max(20),
  budget: z.coerce.number().min(1000, 'Budget must be at least 1,000').max(10_000_000),
  pace: z.enum(PACES).default('moderate'),
  interests: z.array(z.enum(CATEGORIES)).max(5).default([]),
  startDate: z.string().refine(isRealDate, 'Use a real date (YYYY-MM-DD) within the next two years').optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  notes: z.string().max(300).optional(),
  currency: z.enum(DISPLAY_CURRENCIES).default('INR'),
  variants: z.array(z.enum(VARIANT_IDS)).min(1).max(3).optional(),
});

/** Parse + normalise a request. Throws a ZodError on invalid input. */
export function normalizeRequest(raw) {
  const r = PlanRequestSchema.parse(raw ?? {});
  const month = r.startDate ? Number(r.startDate.slice(5, 7)) : r.month ?? null;
  return {
    destination: clean(r.destination, 60),
    days: r.days,
    travelers: r.travelers,
    budget: Math.round(r.budget),
    pace: r.pace,
    interests: [...new Set(r.interests)].sort(),
    startDate: r.startDate ?? null,
    month,
    notes: clean(r.notes ?? '', 300),
    currency: r.currency,
    variants: r.variants ? [...new Set(r.variants)] : VARIANT_IDS,
  };
}

/** What the model must return. Times and money are deliberately absent: code owns those. */
export const PlanSelectionSchema = z.object({
  title: z.string().min(3).max(120),
  summary: z.string().min(10).max(600),
  days: z
    .array(
      z.object({
        day: z.number().int().min(1).max(10),
        theme: z.string().min(2).max(100),
        placeIds: z.array(z.string().min(3).max(80)).max(10),
        tip: z.string().max(300).default(''),
      }),
    )
    .min(1)
    .max(10),
  packing: z.array(z.string().max(100)).max(8).default([]),
});

export const JudgeSchema = z.object({
  coherence: z.number().min(1).max(5),
  fit: z.number().min(1).max(5),
  variety: z.number().min(1).max(5),
  notes: z.string().max(400).default(''),
});
