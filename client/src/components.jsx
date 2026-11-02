import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from './api.js';
import { CATEGORIES, CATEGORY_LABEL, SOURCE_LABEL, compactInr, inr, minutes, sec } from './format.js';

/* ------------------------------------------------------------------ planner form */

const todayISO = () => new Date().toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function PlannerForm({ destinations, initial, busy, onSubmit }) {
  const [f, setF] = useState({
    destination: 'Jaipur', days: 3, travelers: 2, budget: 60000, pace: 'moderate', interests: ['heritage', 'food'],
    whenMode: 'month', startDate: '', month: '', notes: '', currency: 'INR', ...initial,
  });
  const [estimate, setEstimate] = useState(null);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const city = destinations.find((d) => d.city === f.destination);

  useEffect(() => {
    if (!city) return undefined;
    const ac = new AbortController();
    const t = setTimeout(() => {
      api.estimate(city.id, f.days || 1, f.travelers || 1, ac.signal).then(setEstimate).catch(() => setEstimate(null));
    }, 250);
    return () => { clearTimeout(t); ac.abort(); };
  }, [city?.id, f.days, f.travelers]);

  const tooLow = estimate && Number(f.budget) < estimate.minimumBudget;
  const toggle = (c) => set('interests', f.interests.includes(c) ? f.interests.filter((x) => x !== c) : f.interests.length < 5 ? [...f.interests, c] : f.interests);

  function submit(e) {
    e.preventDefault();
    const body = {
      destination: f.destination, days: Number(f.days), travelers: Number(f.travelers), budget: Number(f.budget),
      pace: f.pace, interests: f.interests, currency: f.currency,
    };
    if (f.whenMode === 'date' && f.startDate) body.startDate = f.startDate;
    if (f.whenMode === 'month' && f.month) body.month = Number(f.month);
    if (f.notes.trim()) body.notes = f.notes.trim();
    onSubmit(body);
  }

  return (
    <form className="planner" onSubmit={submit} aria-label="Plan a trip">
      <div className="field wide">
        <label htmlFor="dest">Where to?</label>
        <div className="dest-grid" role="radiogroup" aria-label="Destination">
          {destinations.map((d) => (
            <button type="button" key={d.id} role="radio" aria-checked={f.destination === d.city} className={`dest ${f.destination === d.city ? 'on' : ''}`} onClick={() => set('destination', d.city)}>
              <strong>{d.city}</strong>
              <span>{d.state}</span>
            </button>
          ))}
        </div>
        {city && <p className="hint">{city.tagline}. Best months: {city.bestMonths.map((m) => MONTHS[m - 1]).join(', ')}.</p>}
      </div>

      <div className="field">
        <label htmlFor="days">Days</label>
        <input id="days" type="number" min="1" max="10" value={f.days} onChange={(e) => set('days', e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="trav">Travellers</label>
        <input id="trav" type="number" min="1" max="20" value={f.travelers} onChange={(e) => set('travelers', e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="budget">Total budget (₹)</label>
        <input id="budget" type="number" min="1000" step="500" value={f.budget} onChange={(e) => set('budget', e.target.value)} required aria-describedby="budget-hint" />
      </div>
      <div className="field">
        <label htmlFor="cur">Also show in</label>
        <select id="cur" value={f.currency} onChange={(e) => set('currency', e.target.value)}>
          {['INR', 'USD', 'EUR', 'GBP', 'AED', 'AUD', 'CAD', 'SGD'].map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>

      <p id="budget-hint" className={`hint wide ${tooLow ? 'bad' : ''}`} role={tooLow ? 'alert' : undefined}>
        {estimate
          ? tooLow
            ? `That is below the lowest workable budget of ${inr(estimate.minimumBudget)} for this trip.`
            : `Styles unlock at ${estimate.tiers.map((t) => `${t.label.split(' ')[0]} ${compactInr(t.minimum)}`).join(' · ')} for this trip.`
          : 'Budget covers stay, food, local transport and activities. Not travel to the destination.'}
      </p>

      <fieldset className="field wide">
        <legend>Pace</legend>
        <div className="seg">
          {[['relaxed', 'Relaxed', '≤2 places a day'], ['moderate', 'Moderate', '≤3 places a day'], ['packed', 'Packed', '≤4 places a day']].map(([v, l, s]) => (
            <label key={v} className={f.pace === v ? 'on' : ''}>
              <input type="radio" name="pace" value={v} checked={f.pace === v} onChange={() => set('pace', v)} />
              <strong>{l}</strong><span>{s}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="field wide">
        <legend>Interests <small>(pick up to 5)</small></legend>
        <div className="chips">
          {CATEGORIES.map((c) => (
            <button type="button" key={c} aria-pressed={f.interests.includes(c)} className={`chip ${f.interests.includes(c) ? 'on' : ''}`} onClick={() => toggle(c)}>{CATEGORY_LABEL[c]}</button>
          ))}
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor="mode">When</label>
        <select id="mode" value={f.whenMode} onChange={(e) => set('whenMode', e.target.value)}>
          <option value="month">Pick a month</option>
          <option value="date">Exact start date</option>
          <option value="none">Not sure yet</option>
        </select>
      </div>
      {f.whenMode === 'month' && (
        <div className="field">
          <label htmlFor="month">Month</label>
          <select id="month" value={f.month} onChange={(e) => set('month', e.target.value)}>
            <option value="">Any</option>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
      )}
      {f.whenMode === 'date' && (
        <div className="field">
          <label htmlFor="sd">Start date</label>
          <input id="sd" type="date" min={todayISO()} value={f.startDate} onChange={(e) => set('startDate', e.target.value)} />
        </div>
      )}

      <div className="field wide">
        <label htmlFor="notes">Anything else? <small>(optional)</small></label>
        <input id="notes" maxLength={300} placeholder="e.g. travelling with grandparents, love street food, early riser" value={f.notes} onChange={(e) => set('notes', e.target.value)} />
      </div>

      <button className="btn primary wide" disabled={busy || tooLow}>{busy ? 'Planning…' : 'Plan my trip'}</button>
    </form>
  );
}

/* ------------------------------------------------------------------ result */

const PLACE_COLORS = ['#d9603f', '#14342d', '#c98a1b', '#4f6fb3', '#7b4f9d', '#2e8b6f', '#a8453f', '#5a6b2a', '#3b7ea1', '#8a5a2b'];
const BREAKDOWN = [['stay', 'Stay', '#14342d'], ['food', 'Food', '#d9603f'], ['transport', 'Local transport', '#c98a1b'], ['activities', 'Activities', '#4f6fb3'], ['contingency', 'Contingency 5%', '#a9a392']];

export function ResultView({ result, status, readOnly, onRefine, onSave, saving, refining }) {
  const { meta, research, variants = [], skipped = [], stats } = result;
  const [active, setActive] = useState(null);
  useEffect(() => { if (!active && variants.length) setActive(variants.find((v) => v.id === 'balanced')?.id || variants[0].id); }, [variants.length]);
  const v = variants.find((x) => x.id === active) || variants[0];
  const planning = status === 'planning';
  const expected = meta?.variantsPlanned?.length ?? 0;

  return (
    <section className="result" aria-live="polite">
      <header className="result-head">
        <div>
          <p className="eyebrow">{meta.city.state} · {meta.input.days} day{meta.input.days > 1 ? 's' : ''} · {meta.input.travelers} traveller{meta.input.travelers > 1 ? 's' : ''}{meta.cached ? ' · instant (cached)' : ''}</p>
          <h2>{meta.city.name}</h2>
          <p className="muted">{meta.city.tagline}</p>
        </div>
        <div className="head-actions no-print">
          <button className="btn ghost" onClick={() => window.print()}>Print / PDF</button>
          {!readOnly && <button className="btn" onClick={onSave} disabled={planning || saving || !variants.length}>{saving ? 'Saving…' : 'Save trip'}</button>}
        </div>
      </header>

      <ResearchStrip research={research} budget={meta.input.budget} currency={meta.input.currency} />

      <div className="tabs no-print" role="tablist" aria-label="Itinerary styles">
        {variants.map((x) => (
          <button key={x.id} role="tab" aria-selected={v?.id === x.id} className={`tab ${v?.id === x.id ? 'on' : ''}`} onClick={() => setActive(x.id)}>
            <span>{x.label}</span>
            <strong>{inr(x.costs.total)}</strong>
          </button>
        ))}
        {planning && Array.from({ length: Math.max(0, expected - variants.length) }, (_, i) => (
          <div key={`s${i}`} className="tab skeleton" aria-hidden="true"><span>Planning…</span><strong>&nbsp;</strong></div>
        ))}
      </div>

      {skipped.length > 0 && (
        <p className="notice">{skipped.map((s) => `${s.label} is not shown: ${s.reason}`).join(' ')}</p>
      )}

      {!v && planning && <div className="loading"><div className="route-loader" /><p>Checking places, opening hours and prices…</p></div>}

      {v && (
        <>
          <VariantHeader v={v} meta={meta} research={research} />
          <BudgetPanel v={v} meta={meta} />
          <div className="layout">
            <div className="days">
              {v.days.map((d, i) => <DayCard key={d.day} d={d} color={PLACE_COLORS[i % PLACE_COLORS.length]} />)}
              {v.packing?.length > 0 && (
                <div className="card packing">
                  <h4>Pack</h4>
                  <ul>{v.packing.map((p) => <li key={p}>{p}</li>)}</ul>
                </div>
              )}
            </div>
            <aside className="side no-print">
              <MapView v={v} />
              {!readOnly && <RefineBox variant={v} onRefine={onRefine} busy={refining} />}
            </aside>
          </div>
          {v.warnings?.length > 0 && (
            <details className="card notes"><summary>{v.warnings.length} note{v.warnings.length > 1 ? 's' : ''} about this plan</summary><ul>{v.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>
          )}
        </>
      )}

      {stats && <UnderTheHood stats={stats} meta={meta} />}
    </section>
  );
}

function ResearchStrip({ research, budget, currency }) {
  if (!research) return null;
  const bits = [];
  if (research.season) bits.push(`${research.season.label}: ${research.season.tempC[0]}–${research.season.tempC[1]} °C, rain ${research.season.rain}`);
  if (research.weather?.summary) bits.push(research.weather.summary);
  if (research.currency && currency !== 'INR') bits.push(`${inr(budget)} ≈ ${new Intl.NumberFormat('en', { style: 'currency', currency }).format(research.currency.converted)}${research.currency.source !== 'live' ? ' (approx.)' : ''}`);
  if (!bits.length && research.brief) bits.push(research.brief);
  if (!bits.length) return null;
  return <p className="strip">{bits.join('  ·  ')}</p>;
}

function VariantHeader({ v }) {
  const src = SOURCE_LABEL[v.source] || SOURCE_LABEL.fallback;
  return (
    <div className="variant-head">
      <div>
        <h3>{v.title}</h3>
        <p>{v.summary}</p>
      </div>
      <span className={`badge ${src.tone}`} title="How this plan was produced and checked">{src.text}</span>
    </div>
  );
}

function BudgetPanel({ v, meta }) {
  const total = v.costs.total;
  const limit = meta.input.budget;
  return (
    <div className="card budget">
      <div className="budget-top">
        <div>
          <p className="eyebrow">Estimated total</p>
          <p className="big">{inr(total)} <small>of {inr(limit)}</small></p>
        </div>
        <p className={`pill ${v.budget.fits ? 'good' : 'bad'}`}>{v.budget.fits ? `${inr(v.budget.remaining)} to spare` : `${inr(-v.budget.remaining)} over`}</p>
      </div>
      <div className="stack" role="img" aria-label={`Cost breakdown: ${BREAKDOWN.map(([k, l]) => `${l} ${inr(v.costs[k])}`).join(', ')}`}>
        {BREAKDOWN.map(([k, l, c]) => <span key={k} style={{ width: `${(v.costs[k] / limit) * 100}%`, background: c }} title={`${l}: ${inr(v.costs[k])}`} />)}
        <span className="rest" />
      </div>
      <ul className="legend">
        {BREAKDOWN.map(([k, l, c]) => (
          <li key={k}><i style={{ background: c }} />{l}<b>{inr(v.costs[k])}</b></li>
        ))}
      </ul>
      <p className="muted small">{v.stay.nights > 0 ? `${v.stay.rooms} room${v.stay.rooms > 1 ? 's' : ''} × ${v.stay.nights} night${v.stay.nights > 1 ? 's' : ''} at about ${inr(v.stay.perRoomNight)} (${v.stay.description}).` : 'Day trip: no stay needed.'} Prices are approximate; check before booking.</p>
    </div>
  );
}

function DayCard({ d, color }) {
  const dayTotal = d.cost.activities + d.cost.food + d.cost.transport + d.cost.stay;
  return (
    <article className="card day" style={{ '--day': color }}>
      <header>
        <span className="daynum">Day {d.day}</span>
        <div><h4>{d.theme}</h4>{d.area && <p className="muted small">{d.area}</p>}</div>
        <span className="muted small day-cost" title="Activities, food, transport and the night's stay">{inr(dayTotal)}</span>
      </header>
      {d.tip && <p className="tip">{d.tip}</p>}
      <ol className="timeline">
        {d.items.map((it, i) => (
          <li key={i} className={it.kind}>
            {it.kind === 'place' && it.travelFromPrev && <p className="leg">↓ {minutes(it.travelFromPrev.minutes)} · {it.travelFromPrev.km} km</p>}
            <time>{it.startTime}<span>{it.endTime}</span></time>
            <div className="body">
              <h5>{it.title}</h5>
              <p>{it.note}</p>
              {it.kind === 'place' && (
                <p className="meta">
                  <span>{CATEGORY_LABEL[it.category]}</span>
                  <span>{it.costPerPerson === 0 ? 'Free' : `${inr(it.costPerPerson)} / person`}</span>
                  <span>{it.durationHrs} h</span>
                  {it.premium && <span className="premium">Premium</span>}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </article>
  );
}

function MapView({ v }) {
  const ref = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  useEffect(() => {
    if (!ref.current || mapRef.current) return undefined;
    const map = L.map(ref.current, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Tiles © Esri, HERE, Garmin, OpenStreetMap contributors' }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layerRef.current.clearLayers();
    const all = [];
    v.days.forEach((d, di) => {
      const color = PLACE_COLORS[di % PLACE_COLORS.length];
      const pts = d.items.filter((i) => i.kind === 'place');
      const line = pts.map((p) => [p.lat, p.lng]);
      if (line.length > 1) L.polyline(line, { color, weight: 3, opacity: 0.7, dashArray: '2 7' }).addTo(layerRef.current);
      pts.forEach((p, i) => {
        all.push([p.lat, p.lng]);
        const icon = L.divIcon({ className: 'pin', html: `<span style="background:${color}">${d.day}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
        const el = document.createElement('div');
        const b = document.createElement('strong');
        b.textContent = p.title;
        const s = document.createElement('div');
        s.textContent = `Day ${d.day} · ${p.startTime}`;
        el.append(b, s);
        L.marker([p.lat, p.lng], { icon, title: `${i + 1}. ${p.title}` }).bindPopup(el).addTo(layerRef.current);
      });
    });
    if (all.length) map.fitBounds(all, { padding: [30, 30], maxZoom: 14 });
    else map.setView([22.5, 79], 5);
  }, [v]);

  return <div className="card mapcard"><div ref={ref} className="map" role="region" aria-label="Map of the itinerary" /><p className="muted small">Numbers show the day. Dotted lines follow each day's order.</p></div>;
}

function RefineBox({ variant, onRefine, busy }) {
  const [text, setText] = useState('');
  const ideas = ['More food, less sightseeing', 'Fewer paid attractions', 'More viewpoints and nature', 'Keep evenings free'];
  return (
    <form className="card refine" onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 3) onRefine(variant.id, text.trim()); }}>
      <h4>Adjust this plan</h4>
      <p className="muted small">Ask for a change; only the {variant.label} plan is regenerated and re-checked.</p>
      <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="e.g. more street food, fewer forts" aria-label="Describe the change you want" />
      <div className="chips">{ideas.map((i) => <button type="button" key={i} className="chip" onClick={() => setText(i)}>{i}</button>)}</div>
      <button className="btn" disabled={busy || text.trim().length < 3}>{busy ? 'Updating…' : 'Update plan'}</button>
    </form>
  );
}

function UnderTheHood({ stats, meta }) {
  const v = stats.validation || {};
  const rows = [
    ['Model', `${meta.model?.provider}/${meta.model?.model}`],
    ['Retrieval', `Hybrid BM25 + ${meta.embeddingMode === 'api' ? 'Gemini embeddings' : 'local embeddings'}, rank fusion`],
    ['Model calls', `${stats.llmCalls}${stats.retries ? ` (+${stats.retries} retried)` : ''}`],
    ['Tokens in / out', `${stats.inputTokens?.toLocaleString()} / ${stats.outputTokens?.toLocaleString()}`],
    ['First itinerary after', sec(stats.timeToFirstVariantMs)],
    ['Total time', stats.cached ? 'instant (cached)' : sec(stats.totalMs)],
    ['Drafts valid first time', `${v.firstPass ?? 0} of ${v.total ?? 0}`],
    ['Repaired / cleaned / built-in', `${v.repaired ?? 0} / ${v.sanitized ?? 0} / ${v.fallback ?? 0}`],
  ];
  return (
    <details className="card hood no-print">
      <summary>Under the hood: how this plan was made</summary>
      <dl>{rows.map(([k, val]) => <div key={k}><dt>{k}</dt><dd>{val}</dd></div>)}</dl>
      {stats.toolCalls?.length > 0 && (
        <>
          <h5>Tool calls</h5>
          <ul className="tools">{stats.toolCalls.map((t, i) => <li key={i}><code>{t.name}</code> <span className="muted">via {t.source}, {sec(t.ms)}{t.result?.error ? ` · ${t.result.error}` : ''}</span></li>)}</ul>
        </>
      )}
      <h5>How it works</h5>
      <ol className="how">
        <li>Your request is validated, then the knowledge base is searched for places that match your interests.</li>
        <li>The model only <em>chooses</em> from those places and writes the text. It never invents places, times or prices.</li>
        <li>A validator checks every choice (real place, open that day, pace, budget). Failures go back to the model for repair.</li>
        <li>Code schedules the day, estimates travel time from coordinates and computes every rupee.</li>
      </ol>
      <h5>Assumptions</h5>
      <ul>{meta.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
    </details>
  );
}

/* ------------------------------------------------------------------ auth modal */

export function AuthModal({ onClose, onAuth }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const res = mode === 'login' ? await api.login({ email: f.email, password: f.password }) : await api.register(f);
      onAuth(res);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit} role="dialog" aria-modal="true" aria-label={mode === 'login' ? 'Sign in' : 'Create account'}>
        <h3>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h3>
        <p className="muted small">Save trips and share them with a link.</p>
        {mode === 'register' && <div className="field"><label htmlFor="n">Name</label><input id="n" ref={first} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} autoComplete="name" /></div>}
        <div className="field"><label htmlFor="e">Email</label><input id="e" ref={mode === 'login' ? first : null} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoComplete="email" /></div>
        <div className="field"><label htmlFor="p">Password</label><input id="p" type="password" minLength={mode === 'register' ? 8 : 1} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />{mode === 'register' && <small className="hint">At least 8 characters.</small>}</div>
        {err && <p className="hint bad" role="alert">{err}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <button type="button" className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>{mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}</button>
      </form>
    </div>
  );
}

export function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
export { useMemo };
