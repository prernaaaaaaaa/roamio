import { nanoid } from 'nanoid';

/** Ephemeral in-memory store: used for local dev, tests and when MONGODB_URI is not set. */
export class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.users = new Map();
    this.trips = new Map();
  }

  async connect() {}
  async close() {}

  async createUser({ email, name, passwordHash }) {
    if ([...this.users.values()].some((u) => u.email === email)) {
      throw Object.assign(new Error('Email already registered'), { code: 'email_taken' });
    }
    const user = { id: nanoid(12), email, name, passwordHash, createdAt: new Date().toISOString() };
    this.users.set(user.id, user);
    return user;
  }

  async findUserByEmail(email) {
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }

  async findUserById(id) {
    return this.users.get(id) ?? null;
  }

  async createTrip({ userId, title, input, result }) {
    const trip = { id: nanoid(12), userId, title, input, result, shareId: null, createdAt: new Date().toISOString() };
    this.trips.set(trip.id, trip);
    return trip;
  }

  async listTrips(userId) {
    return [...this.trips.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(summary);
  }

  async getTrip(id, userId) {
    const t = this.trips.get(id);
    return t && t.userId === userId ? t : null;
  }

  async deleteTrip(id, userId) {
    const t = this.trips.get(id);
    if (!t || t.userId !== userId) return false;
    return this.trips.delete(id);
  }

  async setShare(id, userId, enabled) {
    const t = await this.getTrip(id, userId);
    if (!t) return null;
    t.shareId = enabled ? t.shareId || nanoid(10) : null;
    return t;
  }

  async getSharedTrip(shareId) {
    return [...this.trips.values()].find((t) => t.shareId === shareId) ?? null;
  }
}

export function summary(t) {
  return {
    id: String(t.id),
    title: t.title,
    destination: t.result?.meta?.city?.name ?? t.input?.destination ?? '',
    days: t.input?.days,
    travelers: t.input?.travelers,
    budget: t.input?.budget,
    shareId: t.shareId ?? null,
    createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
  };
}
