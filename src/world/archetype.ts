import { genRng, Subsystem } from '../core/rng.ts';

/** The stream of `Subsystem.Water` the archetype is drawn from. Streams 1 and 2 belong to the layout and the render. */
const ARCHETYPE_STREAM = 3;

/** The names of the terrain archetypes (spec section 7.2). */
export type ArchetypeName = 'archipelago';

/** A closed range of a number the layout draws. Both ends are fractions of the map side unless a field says otherwise. */
export interface Span {
  min: number;
  max: number;
}

/** How the island sites of the power diagram are placed and weighted. */
export interface SiteProfile {
  /** Weight of the main site, at the core. The largest weight wins the largest cell. */
  mainRadius: Span;
  /** How many outer sites, as whole numbers. */
  outerCount: Span;
  /** Weight of each outer site. */
  outerRadius: Span;
  /** Outer sites are drawn inside this half-width of the map. */
  spread: number;
  /** No two sites stand closer than this, the core included. */
  minSpacing: number;
  /** Rounds of Lloyd relaxation of the outer sites; 0 keeps them where they were drawn. */
  relaxRounds: number;
  /** Half the nominal width of a strait. */
  channelHalf: Span;
  /** Sea band around the map edge. */
  seaMargin: number;
}

/** How high the land stands, and how rough it is. */
export interface ReliefProfile {
  /** Metres of relief near the core, and at the far end of the ramp. */
  nearAmplitude: number;
  farAmplitude: number;
  /** Distances from the core, as fractions of the map, the relief ramps over. */
  rampFrom: number;
  rampTo: number;
  /** Metres the base of the land rises by away from the core, and the distances it rises over. */
  baseRise: number;
  baseFrom: number;
  baseTo: number;
  /** Cycles of `TerrainGenerator` noise across the map. */
  frequency: number;
  octaves: number;
  talusPasses: number;
}

/** How the coastline wanders. Lengths in metres, except the warp. */
export interface CoastProfile {
  /** Wavelength and amplitude of the fbm that roughens the shore. */
  wavelength: number;
  amplitude: number;
  /** Wavelength of the domain warp that bends the straits. */
  warpWavelength: number;
  /** How far the warp moves a point, as a fraction of the map. */
  warp: number;
}

/** The rivers of an archetype. One river that runs from the main island's interior to its shore. */
export interface RiverProfile {
  count: 1;
  kind: 'source-to-mouth';
}

/**
 * A coherent bundle of terrain parameters (spec section 7.2). A seed draws one
 * of these, and the terrain layout reads its numbers. Nothing else in
 * `src/world` knows archetypes exist.
 */
export interface TerrainArchetype {
  name: ArchetypeName;
  sites: SiteProfile;
  /** The share of the map the archetype aims to leave as dry land. */
  landFraction: Span;
  relief: ReliefProfile;
  coast: CoastProfile;
  rivers: RiverProfile;
  /** Where the harbour goes. */
  harbour: 'river-mouth';
}

/** A few large islands close together, the core on the largest. The map every seed drew before archetypes. */
const ARCHIPELAGO: TerrainArchetype = {
  name: 'archipelago',
  sites: {
    mainRadius: { min: 0.16, max: 0.2 },
    outerCount: { min: 2, max: 4 },
    outerRadius: { min: 0.04, max: 0.1 },
    spread: 0.42,
    minSpacing: 0.34,
    relaxRounds: 3,
    channelHalf: { min: 0.018, max: 0.026 },
    seaMargin: 0.04,
  },
  // 80 seeds of the sweep gave 63 to 74 %.
  landFraction: { min: 0.58, max: 0.8 },
  relief: {
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
  rivers: { count: 1, kind: 'source-to-mouth' },
  harbour: 'river-mouth',
};

/** Every archetype a seed can draw, in a fixed order: the draw picks by index. */
export const ARCHETYPES: readonly TerrainArchetype[] = [ARCHIPELAGO];

/** The archetype a seed builds on. One draw from its own stream, so no other draw of the layout moves. */
export function archetypeFor(seed: number): TerrainArchetype {
  return genRng(seed, Subsystem.Water, ARCHETYPE_STREAM).pick(ARCHETYPES);
}
