import { seedFromString } from './rng.ts';

export const DEFAULT_SEED = 'sunset';

/** Read the seed from the URL hash (`#seed=...`), falling back to the default. */
export function readSeedFromLocation(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const seed = params.get('seed');
  return seed && seed.trim().length > 0 ? seed.trim() : DEFAULT_SEED;
}

/** Write a seed into a URL hash string, preserving other parameters. */
export function writeSeedToHash(hash: string, seed: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  params.set('seed', seed);
  return `#${params.toString()}`;
}

/** A fresh, shareable seed string. Uses crypto entropy; this is user input, not simulation. */
export function randomSeedString(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return ((bytes[0] ?? 0) >>> 0).toString(36);
}

export { seedFromString };
