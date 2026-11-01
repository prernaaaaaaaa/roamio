const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
export const inr = (n) => `₹${inrFmt.format(Math.round(n))}`;
export const compactInr = (n) => (n >= 100000 ? `₹${(n / 100000).toFixed(n >= 1000000 ? 0 : 1)}L` : n >= 1000 ? `₹${(n / 1000).toFixed(n % 1000 ? 1 : 0)}k` : `₹${n}`);

export const CATEGORY_LABEL = {
  heritage: 'Heritage', nature: 'Nature', food: 'Food', adventure: 'Adventure', shopping: 'Shopping',
  spiritual: 'Spiritual', nightlife: 'Nightlife', relaxation: 'Relaxation', culture: 'Culture',
};
export const CATEGORIES = Object.keys(CATEGORY_LABEL);

export const SOURCE_LABEL = {
  llm: { text: 'Every place, time and price checked', tone: 'good' },
  'llm-repaired': { text: 'Checked, with automatic corrections', tone: 'good' },
  'llm-sanitized': { text: 'Checked; a few picks removed to fit the rules', tone: 'warn' },
  fallback: { text: 'Built with the standard planner', tone: 'warn' },
};

export const minutes = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m} min`);
export const sec = (ms) => (ms == null ? 'n/a' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
