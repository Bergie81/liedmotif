// Tiny deterministic string hash, shared so seed derivation and mock ids agree
// on one implementation (no Math.random — output is stable across processes).

/** 32-bit FNV-1a hash of a string → a stable non-negative integer. */
export function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic hash of a string onto `[0, 1)` — the stable stand-in for
 * `Math.random()` wherever a probabilistic decision must survive retries
 * (e.g. the cover-reference frequency roll, keyed per owner+session).
 * FNV-1a's high bits avalanche poorly and the division is dominated by them,
 * so the raw hash goes through a murmur3-style finalizer first — without it,
 * similar keys land visibly lopsided against a probability threshold.
 */
export function hash01(value: string): number {
  let mixed = hash32(value);
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x85ebca6b);
  mixed ^= mixed >>> 13;
  mixed = Math.imul(mixed, 0xc2b2ae35);
  mixed ^= mixed >>> 16;
  return (mixed >>> 0) / 0x1_0000_0000;
}
