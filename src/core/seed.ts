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

/** The word that, typed as a seed, starts the session rich instead of naming a city. */
const MONEY_CODE = 'money';
/** What the money code starts the player with: a billion. */
export const MONEY_CODE_FUNDS = 1_000_000_000;

/**
 * Read what the player typed into the seed box. The money code is not a seed:
 * it stands for a fresh random seed, and it sets the starting money. Anything
 * else is the seed itself, with no change to the money.
 */
export function readSeedCode(typed: string, fresh: () => string = randomSeedString): { seed: string; money?: number } {
  if (typed.trim().toLowerCase() === MONEY_CODE) return { seed: fresh(), money: MONEY_CODE_FUNDS };
  return { seed: typed };
}

export { seedFromString };
