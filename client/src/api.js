const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(body, status) {
    super(body?.message || `Request failed (${status})`);
    this.code = body?.code || 'error';
    this.status = status;
    this.details = body || {};
  }
}

const tokenKey = 'roamio.token';
export const tokenStore = {
  get() { try { return localStorage.getItem(tokenKey); } catch { return null; } },
  set(t) { try { t ? localStorage.setItem(tokenKey, t) : localStorage.removeItem(tokenKey); } catch { /* storage unavailable */ } },
};

async function request(path, { method = 'GET', body, signal } = {}) {
  const token = tokenStore.get();
  const res = await fetch(`${BASE}${path}`, {
    method,
    signal,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error, res.status);
  return json;
}

export const api = {
  destinations: () => request('/api/destinations'),
  estimate: (id, days, travelers, signal) => request(`/api/destinations/${id}/estimate?days=${days}&travelers=${travelers}`, { signal }),
  register: (b) => request('/api/auth/register', { method: 'POST', body: b }),
  login: (b) => request('/api/auth/login', { method: 'POST', body: b }),
  me: () => request('/api/auth/me'),
  trips: () => request('/api/trips'),
  trip: (id) => request(`/api/trips/${id}`),
  saveTrip: (b) => request('/api/trips', { method: 'POST', body: b }),
  deleteTrip: (id) => request(`/api/trips/${id}`, { method: 'DELETE' }),
  share: (id, enabled = true) => request(`/api/trips/${id}/share`, { method: 'POST', body: { enabled } }),
  shared: (shareId) => request(`/api/shared/${shareId}`),
};

/** POST and read a Server-Sent Events response, calling onEvent(name, data) as each event arrives. */
export async function streamPlan(path, body, { onEvent, signal }) {
  const token = tokenStore.get();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new ApiError(json.error, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event && data) onEvent(event, JSON.parse(data));
    }
  }
}
