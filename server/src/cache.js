/** Small in-memory LRU cache with a TTL. Swap for Redis if you run more than one instance. */
export class TTLCache {
  constructor({ max = 200, ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const e = this.map.get(key);
    if (!e || Date.now() - e.at > this.ttlMs) {
      if (e) this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e); // refresh recency
    this.hits++;
    return e.value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, at: Date.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  get size() {
    return this.map.size;
  }

  stats() {
    return { size: this.size, hits: this.hits, misses: this.misses };
  }
}
