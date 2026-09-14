/**
 * The six terrain archetypes of spec section 7.2, as tables. `archetype.ts`
 * says what each field means and draws one per seed; `sites.ts` holds the
 * placement rule each `pattern` names.
 */
import type { TerrainArchetype } from './archetype.ts';

/** A few large islands close together, the core on the largest, narrow straits between them. */
export const ARCHIPELAGO: TerrainArchetype = {
  name: 'archipelago',
  sites: {
    pattern: 'scatter',
    mainRadius: { min: 0.16, max: 0.2 },
    outerCount: { min: 2, max: 4 },
    outerRadius: { min: 0.04, max: 0.1 },
    spread: 0.42,
    minSpacing: 0.34,
    relaxRounds: 3,
    channelHalf: { min: 0.018, max: 0.026 },
    seaMargin: 0.04,
  },
  islands: { min: 3, max: 5 },
  // 80 seeds of the sweep gave 63 to 74 %.
  landFraction: { min: 0.58, max: 0.78 },
  relief: {
    keyedTo: 'core',
    nearAmplitude: 12,
    farAmplitude: 140,
    rampFrom: 0.1,
    rampTo: 0.42,
    baseRise: 18,
    baseFrom: 0.06,
    baseTo: 0.4,
    frequency: 3.2,
    octaves: 6,
    talusPasses: 4,
  },
  coast: { wavelength: 150, amplitude: 16, warpWavelength: 1400, warp: 0.06 },
  rivers: { kind: 'source-to-mouth', count: { min: 1, max: 1 } },
  harbour: 'river-mouth',
};

/** One large landmass with a deep bay cut into it towards the core, and an island or two inside the bay. */
export const BAY: TerrainArchetype = {
  name: 'bay',
  sites: {
    pattern: 'bay',
    mainRadius: { min: 0.16, max: 0.2 },
    outerCount: { min: 1, max: 1 },
    outerRadius: { min: 0.11, max: 0.14 },
    spread: 0.42,
    minSpacing: 0.1,
    relaxRounds: 0,
    channelHalf: { min: 0.018, max: 0.024 },
    seaMargin: 0.04,
  },
  islands: { min: 2, max: 2 },
  landFraction: { min: 0.58, max: 0.74 },
  relief: {
    keyedTo: 'core',
    nearAmplitude: 12,
    farAmplitude: 80,
    rampFrom: 0.1,
    rampTo: 0.5,
    baseRise: 20,
    baseFrom: 0.06,
    baseTo: 0.4,
    frequency: 2.6,
    octaves: 6,
    talusPasses: 4,
  },
  coast: { wavelength: 180, amplitude: 14, warpWavelength: 1800, warp: 0.04 },
  rivers: { kind: 'source-to-mouth', count: { min: 1, max: 1 } },
  harbour: 'waterfront',
};

/** Two large masses split by one wide channel, the core on the larger bank, a city on both. */
export const STRAIT: TerrainArchetype = {
  name: 'strait',
  sites: {
    pattern: 'strait',
    mainRadius: { min: 0.16, max: 0.2 },
    outerCount: { min: 1, max: 2 },
    outerRadius: { min: 0.06, max: 0.08 },
    spread: 0.42,
    minSpacing: 0.2,
    relaxRounds: 0,
    channelHalf: { min: 0.03, max: 0.04 },
    seaMargin: 0.04,
  },
  islands: { min: 2, max: 3 },
  landFraction: { min: 0.56, max: 0.74 },
  relief: {
    keyedTo: 'core',
    nearAmplitude: 12,
    farAmplitude: 120,
    rampFrom: 0.1,
    rampTo: 0.45,
    baseRise: 16,
    baseFrom: 0.06,
    baseTo: 0.4,
    frequency: 3,
    octaves: 6,
    talusPasses: 4,
  },
  coast: { wavelength: 200, amplitude: 12, warpWavelength: 2600, warp: 0.05 },
  rivers: { kind: 'source-to-mouth', count: { min: 1, max: 1 } },
  harbour: 'waterfront',
};

/** Low, flat land that a river splits into channels and islets on its way to the sea. */
export const DELTA: TerrainArchetype = {
  name: 'delta',
  sites: {
    pattern: 'delta',
    mainRadius: { min: 0.16, max: 0.2 },
    outerCount: { min: 4, max: 6 },
    outerRadius: { min: 0.1, max: 0.13 },
    spread: 0.42,
    minSpacing: 0.12,
    relaxRounds: 0,
    channelHalf: { min: 0.014, max: 0.018 },
    seaMargin: 0.04,
  },
  islands: { min: 5, max: 7 },
  landFraction: { min: 0.58, max: 0.72 },
  relief: {
    keyedTo: 'core',
    nearAmplitude: 3,
    farAmplitude: 14,
    rampFrom: 0.15,
    rampTo: 0.5,
    baseRise: 3,
    baseFrom: 0.1,
    baseTo: 0.45,
    frequency: 3,
    octaves: 5,
    talusPasses: 4,
  },
  coast: { wavelength: 120, amplitude: 10, warpWavelength: 1100, warp: 0.05 },
  rivers: { kind: 'delta', count: { min: 1, max: 1 } },
  harbour: 'river-mouth',
};

/** Land rising to a steep spine on one side, open sea on the other, the core on the gentle shore between. */
export const RIDGE: TerrainArchetype = {
  name: 'ridge',
  sites: {
    pattern: 'ridge',
    mainRadius: { min: 0.16, max: 0.2 },
    outerCount: { min: 1, max: 1 },
    outerRadius: { min: 0.08, max: 0.1 },
    spread: 0.42,
    minSpacing: 0.2,
    relaxRounds: 0,
    channelHalf: { min: 0.018, max: 0.024 },
    seaMargin: 0.04,
  },
  islands: { min: 2, max: 2 },
  landFraction: { min: 0.42, max: 0.62 },
  relief: {
    keyedTo: 'spine',
    nearAmplitude: 10,
    farAmplitude: 160,
    rampFrom: 0.06,
    rampTo: 0.18,
    baseRise: 40,
    baseFrom: 0.04,
    baseTo: 0.34,
    frequency: 3.4,
    octaves: 6,
    talusPasses: 3,
  },
  coast: { wavelength: 160, amplitude: 14, warpWavelength: 2000, warp: 0.04 },
  rivers: { kind: 'spine', count: { min: 2, max: 3 } },
  harbour: 'waterfront',
};

/** A ring or crescent of land around sheltered inner water, the core on its inner shore. */
export const LAGOON: TerrainArchetype = {
  name: 'lagoon',
  sites: {
    pattern: 'lagoon',
    mainRadius: { min: 0.16, max: 0.2 },
    outerCount: { min: 1, max: 1 },
    outerRadius: { min: 0.08, max: 0.1 },
    spread: 0.42,
    minSpacing: 0.1,
    relaxRounds: 0,
    channelHalf: { min: 0.018, max: 0.024 },
    seaMargin: 0.04,
  },
  islands: { min: 2, max: 2 },
  landFraction: { min: 0.38, max: 0.54 },
  relief: {
    keyedTo: 'core',
    nearAmplitude: 10,
    farAmplitude: 110,
    rampFrom: 0.12,
    rampTo: 0.45,
    baseRise: 14,
    baseFrom: 0.06,
    baseTo: 0.4,
    frequency: 3,
    octaves: 6,
    talusPasses: 4,
  },
  coast: { wavelength: 150, amplitude: 16, warpWavelength: 1600, warp: 0.04 },
  rivers: { kind: 'source-to-mouth', count: { min: 0, max: 1 } },
  harbour: 'waterfront',
};
