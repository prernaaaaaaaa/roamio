import { tokenize } from './bm25.js';

const DIM = 256;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Local, dependency-free embedding: hashed word and character-trigram features,
 * L2-normalised. It captures lexical and sub-word overlap (so "fortress" is near
 * "fort") but not true semantics. Used offline (mock mode) and as the fallback
 * when the embedding API is unavailable.
 */
export function hashEmbed(text, dim = DIM) {
  const vec = new Float32Array(dim);
  const add = (feature, weight) => {
    const h = fnv1a(feature);
    vec[h % dim] += (h & 0x80000000 ? -1 : 1) * weight;
  };
  for (const tok of tokenize(text)) {
    add(`w:${tok}`, 1);
    const padded = `^${tok}$`;
    for (let i = 0; i + 3 <= padded.length; i++) add(`c:${padded.slice(i, i + 3)}`, 0.35);
  }
  return normalize(vec);
}

export function normalize(vec) {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

export function cosine(a, b) {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}
