/**
 * How much blood the game shows: a setting of the player's, not of the city.
 *
 * The level changes only what is drawn. The record of a hit, a death and a
 * body is the same at every level, so nothing in `src/sim` reads it, and a
 * save or a replay is the same whatever the level was when it was made.
 */

/** Off, Subtle, Moderate or Heavy. */
export type Gore = 'off' | 'subtle' | 'moderate' | 'heavy';

export const DEFAULT_GORE: Gore = 'moderate';

/** Each level, in the order a menu lists them, with what it is called there. */
export const GORE_LEVELS: readonly { value: Gore; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'subtle', label: 'Subtle' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'heavy', label: 'Heavy' },
];

/** What one level draws. A share of 1 is what Moderate draws. */
export interface GoreScale {
  /** True where a hit on a person throws blood. Off throws grey dust instead. */
  blood: boolean;
  /** The share of sparks a hit on a person throws, and how big each one is. */
  sparks: number;
  sparkSize: number;
  /** Metres across the pool under a dead body, once it has spread. The wounded bleed less. */
  pool: number;
  /** Metres wide a smear is, and the share of the slide it covers. Zero draws no smear. */
  smear: number;
  smearLength: number;
  /** Spots a hit throws onto the ground, metres they reach out to, and how big each one is. */
  spots: number;
  reach: number;
  spot: number;
}

export const GORE: Readonly<Record<Gore, GoreScale>> = Object.freeze({
  off: { blood: false, sparks: 1, sparkSize: 1, pool: 0, smear: 0, smearLength: 0, spots: 0, reach: 0, spot: 0 },
  subtle: { blood: true, sparks: 0.6, sparkSize: 0.7, pool: 0.9, smear: 0, smearLength: 0, spots: 2, reach: 0.6, spot: 0.7 },
  moderate: { blood: true, sparks: 1, sparkSize: 1, pool: 1.8, smear: 0.5, smearLength: 0.8, spots: 4, reach: 1, spot: 1 },
  heavy: { blood: true, sparks: 1.5, sparkSize: 1.35, pool: 3, smear: 0.8, smearLength: 1, spots: 7, reach: 1.6, spot: 1.4 },
});

/** A level read from anything, with the default for a value that is not one. */
export function goreOf(value: unknown): Gore {
  return GORE_LEVELS.some((level) => level.value === value) ? (value as Gore) : DEFAULT_GORE;
}
