import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, parseSse, baseRequest, testConfig } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

const post = (path, body, token) => fetch(srv.base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

test('health and destinations', async () => {
  const h = await (await fetch(`${srv.base}/api/health`)).json();
  assert.equal(h.status, 'ok');
  assert.equal(h.provider, 'mock');
  const d = await (await fetch(`${srv.base}/api/destinations`)).json();
  assert.ok(d.destinations.some((x) => x.id === 'goa'));
  const e = await (await fetch(`${srv.base}/api/destinations/goa/estimate?days=3&travelers=2`)).json();
  assert.equal(e.tiers.length, 3);
  assert.equal((await fetch(`${srv.base}/api/destinations/nowhere/estimate`)).status, 404);
});

test('POST /api/plan streams meta, research, variants and done as SSE', async () => {
  const res = await post('/api/plan', baseRequest);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = parseSse(await res.text());
  assert.deepEqual(events.map((e) => e.event).filter((e, i, a) => a.indexOf(e) === i), ['meta', 'research', 'variant', 'done']);
  const variants = events.filter((e) => e.event === 'variant').map((e) => e.data);
  assert.ok(variants.length >= 2 && variants.every((v) => v.budget.fits));
  assert.ok(events.at(-1).data.stats.llmCalls >= 1);
});

test('errors are plain JSON with the right status', async () => {
  let r = await post('/api/plan', { ...baseRequest, destination: 'Atlantis' });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, 'unknown_destination');
  r = await post('/api/plan', { ...baseRequest, budget: 1500 });
  assert.equal(r.status, 422);
  r = await post('/api/plan', { ...baseRequest, days: 0 });
  assert.equal(r.status, 400);
  r = await fetch(`${srv.base}/api/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(r.status, 400);
  r = await fetch(`${srv.base}/api/nope`);
  assert.equal(r.status, 404);
});

test('refine requires an instruction and returns one variant', async () => {
  assert.equal((await post('/api/plan/refine', { input: baseRequest, variantId: 'balanced', instruction: '' })).status, 400);
  const res = await post('/api/plan/refine', { input: baseRequest, variantId: 'balanced', instruction: 'add more street food' });
  const variants = parseSse(await res.text()).filter((e) => e.event === 'variant');
  assert.equal(variants.length, 1);
  assert.equal(variants[0].data.id, 'balanced');
});

test('auth, saving, sharing and deleting trips', async () => {
  const reg = await post('/api/auth/register', { name: 'Asha', email: 'Asha@Example.com', password: 'correct-horse' });
  assert.equal(reg.status, 201);
  const { token } = await reg.json();
  assert.equal((await post('/api/auth/register', { name: 'x', email: 'asha@example.com', password: 'correct-horse' })).status, 409);
  assert.equal((await post('/api/auth/register', { name: 'x', email: 'b@example.com', password: 'short' })).status, 400);
  assert.equal((await post('/api/auth/login', { email: 'asha@example.com', password: 'wrong-password' })).status, 401);
  assert.equal((await post('/api/auth/login', { email: 'nobody@example.com', password: 'whatever12' })).status, 401);
  const login = await (await post('/api/auth/login', { email: 'asha@example.com', password: 'correct-horse' })).json();
  assert.equal((await (await fetch(`${srv.base}/api/auth/me`, { headers: { authorization: `Bearer ${login.token}` } })).json()).user.name, 'Asha');

  assert.equal((await fetch(`${srv.base}/api/trips`)).status, 401);

  const planned = parseSse(await (await post('/api/plan', baseRequest)).text());
  const meta = planned.find((e) => e.event === 'meta').data;
  const result = { meta, variants: planned.filter((e) => e.event === 'variant').map((e) => e.data) };
  const saved = await post('/api/trips', { title: 'Jaipur weekend', input: meta.input, result }, token);
  assert.equal(saved.status, 201);
  const { trip } = await saved.json();
  assert.equal(trip.destination, 'Jaipur');
  assert.equal((await post('/api/trips', { title: 'bad', input: { destination: 'x' }, result: {} }, token)).status, 400);

  const list = await (await fetch(`${srv.base}/api/trips`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(list.trips.length, 1);

  const other = await (await post('/api/auth/register', { name: 'Ravi', email: 'ravi@example.com', password: 'another-pass1' })).json();
  assert.equal((await fetch(`${srv.base}/api/trips/${trip.id}`, { headers: { authorization: `Bearer ${other.token}` } })).status, 404, 'other users cannot read it');
  assert.equal((await fetch(`${srv.base}/api/trips/${trip.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${other.token}` } })).status, 404);

  const { shareId } = await (await post(`/api/trips/${trip.id}/share`, {}, token)).json();
  assert.ok(shareId);
  const shared = await (await fetch(`${srv.base}/api/shared/${shareId}`)).json();
  assert.equal(shared.trip.title, 'Jaipur weekend');
  assert.equal('userId' in shared.trip, false, 'no owner details leak');
  await post(`/api/trips/${trip.id}/share`, { enabled: false }, token);
  assert.equal((await fetch(`${srv.base}/api/shared/${shareId}`)).status, 404);

  assert.equal((await fetch(`${srv.base}/api/trips/${trip.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status, 204);
});

test('plan rate limit returns 429 with a JSON body', async () => {
  const limited = await startServer({ config: testConfig({ RATE_PLAN_PER_MIN: '2' }) });
  try {
    const hit = () => fetch(`${limited.base}/api/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...baseRequest, destination: 'Atlantis' }) });
    await hit(); await hit();
    const third = await hit();
    assert.equal(third.status, 429);
    assert.equal((await third.json()).error.code, 'rate_limited');
  } finally { await limited.close(); }
});
