import { BM25 } from './bm25.js';
import { cosine, hashEmbed, normalize } from './embeddings.js';
import { isAvailable } from './loader.js';

const RRF_K = 60;

const docText = (p) => `${p.name}. ${p.category}. ${p.area}. ${p.desc} ${p.tags.join(' ')}`;

/**
 * Hybrid retriever over the destination knowledge base.
 *
 *   lexical : BM25 over name + category + area + description + tags
 *   semantic: cosine similarity over embeddings (Gemini embeddings when available,
 *             a local hashed embedding otherwise)
 *   fusion  : Reciprocal Rank Fusion (k = 60), which needs no score calibration
 *
 * Hard filters (city, month availability, max cost, categories) are applied before ranking.
 */
export class Retriever {
  /**
   * @param {object} opts
   * @param {object} opts.kb loaded knowledge base
   * @param {(texts:string[], o?:{taskType?:string})=>Promise<number[][]>} [opts.embedder] optional embedding function
   * @param {{warn:Function}} [opts.logger]
   */
  constructor({ kb, embedder, logger = console }) {
    this.kb = kb;
    this.embedder = embedder;
    this.logger = logger;
    this.embeddingMode = 'local-hash';
    this.bm25 = new Map();
    this.vectors = new Map();
  }

  async init() {
    for (const city of this.kb.cities.values()) {
      this.bm25.set(city.id, new BM25(city.places.map((p) => ({ id: p.id, text: docText(p) }))));
    }
    const all = [...this.kb.places.values()];
    const texts = all.map(docText);
    let vecs = null;
    if (this.embedder) {
      try {
        const out = await this.embedder(texts, { taskType: 'RETRIEVAL_DOCUMENT' });
        if (Array.isArray(out) && out.length === texts.length) {
          vecs = out.map((v) => normalize(Float32Array.from(v)));
          this.embeddingMode = 'api';
        }
      } catch (err) {
        this.logger.warn?.(`[retriever] embedding API unavailable, using local embeddings: ${err.message}`);
      }
    }
    if (!vecs) vecs = texts.map((t) => hashEmbed(t));
    all.forEach((p, i) => this.vectors.set(p.id, vecs[i]));
    return this;
  }

  async #embedQuery(query) {
    if (this.embeddingMode === 'api' && this.embedder) {
      try {
        const [v] = await this.embedder([query], { taskType: 'RETRIEVAL_QUERY' });
        return normalize(Float32Array.from(v));
      } catch (err) {
        this.logger.warn?.(`[retriever] query embedding failed, using local embedding: ${err.message}`);
        // Mixed spaces would corrupt ranking, so rank lexically for this query.
        return null;
      }
    }
    return hashEmbed(query);
  }

  /**
   * @returns {Promise<Array<{place:object, score:number, lexicalRank:number|null, semanticRank:number|null}>>}
   */
  async search({ cityId, query = '', limit = 8, maxCostINR, categories, month }) {
    const city = this.kb.getCity(cityId);
    if (!city) return [];
    let pool = city.places.filter((p) => isAvailable(p, month));
    if (categories?.length) pool = pool.filter((p) => categories.includes(p.category));
    if (Number.isFinite(maxCostINR)) pool = pool.filter((p) => p.costINR <= maxCostINR);
    if (!pool.length) return [];
    const ids = new Set(pool.map((p) => p.id));

    const q = String(query || '').trim();
    if (!q) {
      return pool.slice(0, limit).map((place, i) => ({ place, score: 1 / (RRF_K + i + 1), lexicalRank: null, semanticRank: null }));
    }

    const lexical = this.bm25.get(cityId).search(q, pool.length).filter((r) => ids.has(r.id));
    const qv = await this.#embedQuery(q);
    const semantic = qv
      ? pool
          .map((p) => ({ id: p.id, score: cosine(qv, this.vectors.get(p.id)) }))
          .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      : [];

    const fused = new Map();
    const bump = (id, rank, key) => {
      const entry = fused.get(id) || { score: 0, lexicalRank: null, semanticRank: null };
      entry.score += 1 / (RRF_K + rank + 1);
      entry[key] = rank + 1;
      fused.set(id, entry);
    };
    lexical.forEach((r, i) => bump(r.id, i, 'lexicalRank'));
    semantic.forEach((r, i) => bump(r.id, i, 'semanticRank'));

    return [...fused.entries()]
      .map(([id, e]) => ({ place: this.kb.getPlace(id), ...e }))
      .sort((a, b) => b.score - a.score || a.place.id.localeCompare(b.place.id))
      .slice(0, limit);
  }
}
