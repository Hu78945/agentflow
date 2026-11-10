export const EMBEDDING_DIM = 256;

/**
 * Deterministic hashed bag-of-words embedding (the "hashing trick").
 * Offline, free, and good enough for keyword-ish recall; it has no notion of synonyms.
 * Trade-off: swap for a real embedding model behind this same signature when semantic recall matters.
 */
export function embed(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const h = fnv1a(token);
    vec[h % EMBEDDING_DIM] += h & 0x80000000 ? -1 : 1; // sign bit reduces collision bias
  }
  const norm = Math.hypot(...vec);
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

/** pgvector text literal, e.g. "[0.1,0,-0.3]". */
export function toPgVector(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
