import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, streamPlan, tokenStore } from './api.js';
import { AuthModal, PlannerForm, ResultView } from './components.jsx';
import { inr } from './format.js';

const AuthCtx = createContext(null);
const useAuth = () => useContext(AuthCtx);
const ORDER = ['budget', 'balanced', 'comfort'];

/* ------------------------------------------------------------------ planning hook */

function usePlanner() {
  const [state, setState] = useState({ status: 'idle', result: null, error: null, refining: false });
  const abort = useRef(null);

  const run = useCallback(async (path, body, { merge = false } = {}) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setState((s) => (merge ? { ...s, refining: true, error: null } : { status: 'planning', result: null, error: null, refining: false }));
    try {
      await streamPlan(path, body, {
        signal: ac.signal,
        onEvent(event, data) {
          setState((s) => {
            const r = s.result || { variants: [], skipped: [] };
            switch (event) {
              case 'meta': return merge ? s : { ...s, result: { ...r, meta: data, skipped: data.skipped || [] } };
              case 'research': return merge ? s : { ...s, result: { ...r, research: data } };
              case 'variant': {
                const variants = [...r.variants.filter((v) => v.id !== data.id), data].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
                return { ...s, result: { ...r, variants } };
              }
              case 'done': return { ...s, status: 'done', refining: false, result: { ...r, stats: data.stats } };
              case 'error': throw new ApiError(data, 500);
              default: return s;
            }
          });
        },
      });
      setState((s) => ({ ...s, status: s.status === 'planning' ? 'done' : s.status, refining: false }));
    } catch (err) {
      if (err.name === 'AbortError') return;
      setState((s) => ({ ...s, status: s.result?.variants?.length ? 'done' : 'error', error: err, refining: false }));
    }
  }, []);

  return { ...state, plan: (body) => run('/api/plan', body), refine: (body) => run('/api/plan/refine', body, { merge: true }), reset: () => setState({ status: 'idle', result: null, error: null, refining: false }) };
}

function ErrorBox({ error }) {
  if (!error) return null;
  const extra = error.code === 'unknown_destination' && error.details?.destinations ? ` Available: ${error.details.destinations.join(', ')}.` : '';
  const hint = error.code === 'budget_too_low' && error.details?.minimumBudget ? ` Try at least ${inr(error.details.minimumBudget)}.` : '';
  return <div className="notice bad" role="alert">{error.message}{extra}{error.code === 'budget_too_low' ? '' : hint}</div>;
}

/* ------------------------------------------------------------------ pages */

function Home() {
  const [destinations, setDestinations] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const planner = usePlanner();
  const { user, needAuth } = useAuth();
  const nav = useNavigate();
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const resultRef = useRef(null);
  const lastInput = useRef(null);

  useEffect(() => { api.destinations().then((d) => setDestinations(d.destinations)).catch((e) => setLoadErr(e.message)); }, []);

  const submit = (body) => {
    lastInput.current = body;
    planner.plan(body);
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };

  async function save() {
    if (!user) return needAuth();
    const { meta, research, variants, skipped, stats } = planner.result;
    setSaving(true);
    try {
      const { trip } = await api.saveTrip({ title: `${meta.city.name}, ${meta.input.days} days`, input: meta.input, result: { meta, research, variants, skipped, stats } });
      setToast('Saved to your trips.');
      setTimeout(() => nav(`/trips/${trip.id}`), 700);
    } catch (e) { setToast(e.message); } finally { setSaving(false); }
  }

  return (
    <main>
      <section className="hero">
        <h1>Plan a trip that fits your <em>budget</em></h1>
        <p className="lede">Choose where you are going, for how long and how much you can spend. Roamio gives you three day-by-day itineraries, each with timings, travel times and a full cost breakdown.</p>
      </section>
      {loadErr && <div className="notice bad" role="alert">Could not reach the server: {loadErr}</div>}
      {destinations.length > 0 && <PlannerForm destinations={destinations} busy={planner.status === 'planning'} onSubmit={submit} />}
      <div ref={resultRef} className="anchor" />
      <ErrorBox error={planner.error} />
      {planner.result?.meta && (
        <ResultView
          result={planner.result}
          status={planner.status}
          saving={saving}
          refining={planner.refining}
          onSave={save}
          onRefine={(variantId, instruction) => lastInput.current && planner.refine({ input: lastInput.current, variantId, instruction })}
        />
      )}
      {toast && <p className="toast" role="status">{toast}</p>}
    </main>
  );
}

function Trips() {
  const { user, needAuth } = useAuth();
  const [trips, setTrips] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { if (user) api.trips().then((r) => setTrips(r.trips)).catch((e) => setErr(e.message)); }, [user]);
  if (!user) return <main><h1 className="page-title">My trips</h1><p className="lede">Sign in to see the trips you saved.</p><button className="btn primary" onClick={needAuth}>Sign in</button></main>;
  return (
    <main>
      <h1 className="page-title">My trips</h1>
      {err && <div className="notice bad">{err}</div>}
      {trips && !trips.length && <p className="lede">Nothing saved yet. <Link to="/">Plan your first trip.</Link></p>}
      <ul className="triplist">
        {trips?.map((t) => (
          <li key={t.id} className="card">
            <Link to={`/trips/${t.id}`}><h3>{t.title}</h3></Link>
            <p className="muted small">{t.destination} · {t.days} days · {t.travelers} travellers · budget {inr(t.budget)} · {new Date(t.createdAt).toLocaleDateString()}</p>
            {t.shareId && <span className="badge good">Shared</span>}
          </li>
        ))}
      </ul>
    </main>
  );
}

function TripPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [trip, setTrip] = useState(null);
  const [err, setErr] = useState('');
  const [shareId, setShareId] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.trip(id).then((r) => { setTrip(r.trip); setShareId(r.trip.shareId); }).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <main><div className="notice bad">{err}</div><Link to="/trips">Back to my trips</Link></main>;
  if (!trip) return <main><p className="muted">Loading…</p></main>;
  const link = shareId ? `${window.location.origin}/s/${shareId}` : '';
  return (
    <main>
      <div className="trip-bar no-print">
        <Link to="/trips">← My trips</Link>
        <div className="head-actions">
          {shareId ? (
            <>
              <input readOnly value={link} aria-label="Share link" onFocus={(e) => e.target.select()} />
              <button className="btn" onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy link'}</button>
              <button className="btn ghost" onClick={async () => { await api.share(id, false); setShareId(null); setCopied(false); }}>Stop sharing</button>
            </>
          ) : <button className="btn" onClick={async () => setShareId((await api.share(id)).shareId)}>Share</button>}
          <button className="btn ghost danger" onClick={async () => { if (confirm('Delete this trip?')) { await api.deleteTrip(id); nav('/trips'); } }}>Delete</button>
        </div>
      </div>
      <ResultView result={trip.result} status="done" readOnly />
    </main>
  );
}

function Shared() {
  const { shareId } = useParams();
  const [trip, setTrip] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.shared(shareId).then((r) => setTrip(r.trip)).catch((e) => setErr(e.message)); }, [shareId]);
  if (err) return <main><div className="notice bad">{err}</div><Link to="/">Plan your own trip</Link></main>;
  if (!trip) return <main><p className="muted">Loading…</p></main>;
  return <main><p className="eyebrow">Shared itinerary</p><ResultView result={trip.result} status="done" readOnly /><p className="cta no-print"><Link className="btn primary" to="/">Plan your own trip</Link></p></main>;
}

/* ------------------------------------------------------------------ shell */

function Shell() {
  const [user, setUser] = useState(null);
  const [modal, setModal] = useState(false);

  useEffect(() => {
    if (!tokenStore.get()) return;
    api.me().then((r) => setUser(r.user)).catch(() => tokenStore.set(null));
  }, []);

  const value = { user, needAuth: () => setModal(true) };
  const onAuth = ({ token, user: u }) => { tokenStore.set(token); setUser(u); setModal(false); };

  return (
    <AuthCtx.Provider value={value}>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top no-print">
        <Link to="/" className="brand" aria-label="Roamio home"><svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#f26b21" /><path d="M32 12c-8.3 0-15 6.5-15 14.6 0 10.6 15 25.4 15 25.4s15-14.8 15-25.4C47 18.5 40.3 12 32 12zm0 20.5a6 6 0 1 1 0-12 6 6 0 0 1 0 12z" fill="#fff" /></svg>roamio</Link>
        <nav>
          <NavLink to="/" end>Plan</NavLink>
          <NavLink to="/trips">My trips</NavLink>
          {user ? <button className="link" onClick={() => { tokenStore.set(null); setUser(null); }}>Sign out ({user.name.split(' ')[0]})</button> : <button className="btn small" onClick={() => setModal(true)}>Sign in</button>}
        </nav>
      </header>
      <div id="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/trips" element={<Trips />} />
          <Route path="/trips/:id" element={<TripPage />} />
          <Route path="/s/:shareId" element={<Shared />} />
          <Route path="*" element={<main><h1 className="page-title">Page not found</h1><Link to="/">Back to planning</Link></main>} />
        </Routes>
      </div>
      <footer className="foot no-print">Prices and opening hours are approximate and from a curated knowledge base. Confirm before you book. Map © OpenStreetMap contributors.</footer>
      {modal && <AuthModal onClose={() => setModal(false)} onAuth={onAuth} />}
    </AuthCtx.Provider>
  );
}

export default function App() {
  return <BrowserRouter><Shell /></BrowserRouter>;
}
