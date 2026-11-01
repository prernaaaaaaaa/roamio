import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { optionalAuth, requireAuth, signToken } from '../middleware/auth.js';
import { createLimiters, openSse, toErrorBody } from '../middleware/common.js';
import { PlanRequestSchema, VARIANT_IDS } from '../planner/schemas.js';
import { VARIANTS, baseline, CONTINGENCY_RATE, minimumBudget } from '../planner/costs.js';
import { PlanError } from '../planner/pipeline.js';
import { summary } from '../store/memory.js';

// Compared against when the email is unknown so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const RegisterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(120),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});
const LoginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) });

const RefineSchema = z.object({
  input: z.unknown(),
  variantId: z.enum(VARIANT_IDS),
  instruction: z.string().trim().min(3, 'Tell us what to change').max(200),
});

const SaveSchema = z.object({
  title: z.string().trim().min(1).max(120),
  input: z.object({ destination: z.string().max(60), days: z.number().int().min(1).max(10), travelers: z.number().int().min(1).max(20), budget: z.number() }).passthrough(),
  result: z
    .object({
      meta: z.object({ city: z.object({ name: z.string().max(60) }).passthrough() }).passthrough(),
      variants: z.array(z.object({ id: z.enum(VARIANT_IDS), days: z.array(z.unknown()).max(10) }).passthrough()).min(1).max(3),
    })
    .passthrough(),
});

export function createApiRouter({ config, kb, planner, store, llm, retriever, cache }) {
  const router = express.Router();
  const limits = createLimiters(config);
  const auth = optionalAuth(config.jwtSecret);
  router.use(limits.general, auth);

  // ---- meta -------------------------------------------------------------------------------
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      provider: llm.info.provider,
      model: llm.info.model,
      embeddingMode: retriever.embeddingMode,
      kbVersion: kb.version,
      destinations: kb.cities.size,
      store: store.kind,
      cache: cache.stats(),
      llmDaily: llm.dailyBudget?.snapshot(),
    });
  });

  router.get('/destinations', (_req, res) => res.json({ destinations: kb.listCities() }));

  /** Rough per-tier minimum budgets so the form can warn before anything is generated. */
  router.get('/destinations/:id/estimate', (req, res) => {
    const city = kb.getCity(req.params.id);
    if (!city) return res.status(404).json({ error: { code: 'unknown_destination', message: 'Unknown destination.' } });
    const days = Math.min(10, Math.max(1, Number.parseInt(req.query.days, 10) || 3));
    const travelers = Math.min(20, Math.max(1, Number.parseInt(req.query.travelers, 10) || 2));
    const tiers = VARIANTS.map((v) => ({
      id: v.id,
      label: v.label,
      minimum: Math.ceil(baseline({ city, tier: v.tier, travelers, days }).base * (1 + CONTINGENCY_RATE)) + 1,
    }));
    res.json({ days, travelers, minimumBudget: minimumBudget({ city, travelers, days }), tiers });
  });

  // ---- planning (Server-Sent Events) ------------------------------------------------------
  async function stream(req, res, next, run) {
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    let sse = null;
    const emit = (event, data) => {
      sse ??= openSse(res);
      sse.send(event, data);
    };
    try {
      await run({ emit, signal: ac.signal });
      sse?.end();
    } catch (err) {
      if (ac.signal.aborted) return;
      if (!sse) return next(err); // nothing sent yet: plain JSON error with a proper status
      const { body } = toErrorBody(err);
      sse.send('error', body.error);
      sse.end();
    }
  }

  router.post('/plan', limits.planDay, limits.planMinute, (req, res, next) =>
    stream(req, res, next, ({ emit, signal }) => planner.plan(req.body, { emit, signal })),
  );

  router.post('/plan/refine', limits.planDay, limits.planMinute, (req, res, next) => {
    const parsed = RefineSchema.safeParse(req.body);
    if (!parsed.success) return next(parsed.error);
    const { input, variantId, instruction } = parsed.data;
    return stream(req, res, next, ({ emit, signal }) => planner.plan(input, { emit, signal, only: variantId, instruction }));
  });

  // ---- auth -------------------------------------------------------------------------------
  router.post('/auth/register', limits.auth, async (req, res, next) => {
    try {
      const { name, email, password } = RegisterSchema.parse(req.body);
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await store.createUser({ name, email, passwordHash });
      res.status(201).json({ token: signToken(user, config.jwtSecret), user: { id: user.id, name: user.name, email: user.email } });
    } catch (err) {
      if (err?.code === 'email_taken') return res.status(409).json({ error: { code: 'email_taken', message: 'That email is already registered.' } });
      next(err);
    }
  });

  router.post('/auth/login', limits.auth, async (req, res, next) => {
    try {
      const { email, password } = LoginSchema.parse(req.body);
      const user = await store.findUserByEmail(email);
      const ok = user ? await bcrypt.compare(password, user.passwordHash) : await bcrypt.compare(password, DUMMY_HASH);
      if (!user || !ok) return res.status(401).json({ error: { code: 'bad_credentials', message: 'Email or password is incorrect.' } });
      res.json({ token: signToken(user, config.jwtSecret), user: { id: user.id, name: user.name, email: user.email } });
    } catch (err) {
      next(err);
    }
  });

  router.get('/auth/me', requireAuth, async (req, res, next) => {
    try {
      const user = await store.findUserById(req.user.id);
      if (!user) return res.status(401).json({ error: { code: 'unauthorized', message: 'Please sign in again.' } });
      res.json({ user: { id: user.id, name: user.name, email: user.email } });
    } catch (err) {
      next(err);
    }
  });

  // ---- trips ------------------------------------------------------------------------------
  router.get('/trips', requireAuth, async (req, res, next) => {
    try {
      res.json({ trips: await store.listTrips(req.user.id) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/trips', requireAuth, express.json({ limit: '400kb' }), async (req, res, next) => {
    try {
      const body = SaveSchema.parse(req.body);
      const trip = await store.createTrip({ userId: req.user.id, ...body });
      res.status(201).json({ trip: summary(trip) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/trips/:id', requireAuth, async (req, res, next) => {
    try {
      const trip = await store.getTrip(req.params.id, req.user.id);
      if (!trip) return res.status(404).json({ error: { code: 'not_found', message: 'Trip not found.' } });
      res.json({ trip: { ...summary(trip), input: trip.input, result: trip.result } });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/trips/:id', requireAuth, async (req, res, next) => {
    try {
      const ok = await store.deleteTrip(req.params.id, req.user.id);
      if (!ok) return res.status(404).json({ error: { code: 'not_found', message: 'Trip not found.' } });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post('/trips/:id/share', requireAuth, async (req, res, next) => {
    try {
      const enabled = req.body?.enabled !== false;
      const trip = await store.setShare(req.params.id, req.user.id, enabled);
      if (!trip) return res.status(404).json({ error: { code: 'not_found', message: 'Trip not found.' } });
      res.json({ shareId: trip.shareId });
    } catch (err) {
      next(err);
    }
  });

  router.get('/shared/:shareId', async (req, res, next) => {
    try {
      const trip = await store.getSharedTrip(req.params.shareId);
      if (!trip) return res.status(404).json({ error: { code: 'not_found', message: 'This shared trip does not exist or was unshared.' } });
      res.json({ trip: { title: trip.title, input: trip.input, result: trip.result } });
    } catch (err) {
      next(err);
    }
  });

  router.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } }));
  return router;
}

// Re-exported for tests.
export { PlanRequestSchema, PlanError };
