/**
 * 32-bit integer hashing. Every random draw in the game is keyed through here,
 * so the same inputs always give the same stream regardless of machine or run.
 */

/** Finaliser from MurmurHash3: spreads entropy across all 32 bits. */
function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Combine any number of integers into one well-mixed 32-bit hash. */
export function hashInts(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h = mix32((h ^ (p | 0)) + 0x7f4a7c15);
    h = Math.imul(h, 0x9e3779b1) >>> 0;
  }
  return mix32(h);
}

/** FNV-1a over UTF-16 code units; turns a seed string into a 32-bit number. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h >>> 0);
}
