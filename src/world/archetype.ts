import { genRng, Subsystem } from '../core/rng.ts';
import { ARCHIPELAGO, BAY, DELTA, LAGOON, RIDGE, STRAIT } from './archetypes.ts';

/** The stream of `Subsystem.Water` the archetype is drawn from. Streams 1 and 2 belong to the layout and the render. */
const ARCHETYPE_STREAM = 3;

/** The names of the terrain archetypes (spec section 7.2). */
export type ArchetypeName = 'archipelago' | 'bay' | 'strait' | 'delta' | 'ridge' | 'lagoon';

/** A closed range of a number the layout draws. Both ends are fractions of the map side unless a field says otherwise. */
export interface Span {
  min: number;
  max: number;
}

/**
 * The rule that places the sites of the power diagram (`sites.ts`). Only
 * `scatter` relaxes them; the others leave a site where the dice put it, or
 * on the line the shape is drawn along.
 */
export type SitePattern = 'scatter' | 'bay' | 'strait' | 'delta' | 'ridge' | 'lagoon';

/** How the island sites of the power diagram are placed and weighted. */
export interface SiteProfile {
  pattern: SitePattern;
  /** Weight of the main site, at the core. The largest weight wins the largest cell. */
  mainRadius: Span;
  /** How many outer pieces of land the pattern adds, as whole numbers. */
  outerCount: Span;
  /** Weight of each outer site. */
  outerRadius: Span;
  /** Outer sites are drawn inside this half-width of the map. */
  spread: number;
  /** No two sites stand closer than this, the core included. */
  minSpacing: number;
  /** Rounds of Lloyd relaxation of the outer sites; 0 keeps them where they were drawn. */
  relaxRounds: number;
  /** Half the nominal width of a strait: the water between two islands, and between land and a sea site. */
  channelHalf: Span;
  /** Sea band around the map edge. */
  seaMargin: number;
}

/**
 * What the relief is measured from. `core` ramps it up with the distance from
 * the core. `spine` ramps it up towards the ridge line the layout draws, so the
 * steepest ground is far from the core and the coast.
 */
export type ReliefKey = 'core' | 'spine';

/** How high the land stands, and how rough it is. */
export interface ReliefProfile {
  keyedTo: ReliefKey;
  /** Metres of relief at the near end of the ramp, and at the far end. */
  nearAmplitude: number;
  farAmplitude: number;
  /**
   * Distances, as fractions of the map, the relief ramps over. From the core
   * the ramp climbs outward; from the spine it climbs inward, so `rampFrom` is
   * where the high ground ends and `rampTo` where the gentle ground starts.
   */
  rampFrom: number;
  rampTo: number;
  /** Metres the base of the land rises by along the same ramp, and the distances it rises over. */
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

/**
 * How an archetype's rivers run (`rivers.ts`).
 * - `source-to-mouth`: from the main island's interior to its widest reach of coast.
 * - `delta`: from inland to the head of the delta, where the channels between the islets carry it on.
 * - `spine`: short steep rivers off the flank of the spine, down to the sea.
 */
export type RiverKind = 'source-to-mouth' | 'delta' | 'spine';

/** The rivers of an archetype. A count of zero leaves the map without one. */
export interface RiverProfile {
  kind: RiverKind;
  count: Span;
}

/**
 * Where the harbour goes. `river-mouth` puts it where the first river meets
 * the sea. `waterfront` puts it on the shore the core faces: the bay, the
 * strait, the lagoon or the open sea, whichever the layout drew.
 */
export type HarbourRule = 'river-mouth' | 'waterfront';

/**
 * A coherent bundle of terrain parameters (spec section 7.2). A seed draws one
 * of these, and the terrain layout reads its numbers. Nothing else in
 * `src/world` knows archetypes exist.
 */
export interface TerrainArchetype {
  name: ArchetypeName;
  sites: SiteProfile;
  /** How many islands the water description holds: the pieces of land the crossings join. */
  islands: Span;
  /** The share of the map the archetype aims to leave as dry land. */
  landFraction: Span;
  relief: ReliefProfile;
  coast: CoastProfile;
  rivers: RiverProfile;
  harbour: HarbourRule;
}

/** Every archetype a seed can draw, in a fixed order: the draw picks by index. Never reorder it. */
export const ARCHETYPES: readonly TerrainArchetype[] = [ARCHIPELAGO, BAY, STRAIT, DELTA, RIDGE, LAGOON];

/** The archetype a seed builds on. One draw from its own stream, so no other draw of the layout moves. */
export function archetypeFor(seed: number): TerrainArchetype {
  return genRng(seed, Subsystem.Water, ARCHETYPE_STREAM).pick(ARCHETYPES);
}

/** The archetype of a given name. */
export function archetypeNamed(name: ArchetypeName): TerrainArchetype {
  return ARCHETYPES.find((a) => a.name === name) as TerrainArchetype;
}
