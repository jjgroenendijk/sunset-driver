/**
 * The words the streamline fills are written in: what one road of a fill is
 * laid at, and where the next one is seeded.
 *
 * `roads.ts` owns the fills themselves — the arterials between the highways,
 * the streets between the arterials — and `alleys.ts` the service lane inside a
 * block. Both speak of a seed and a plan, so the two types and the zone table
 * they read live here rather than in either of them.
 */
import type { RoadTier, Zone } from './types.ts';
import type { TierParams } from './road-trace.ts';

/**
 * What the minor fill lays in each zone: the tier, and the metres between
 * neighbouring roads of it. A district holds the tight spacing when its density
 * is 1 and the loose one when it is 0, so blocks shrink toward downtown.
 *
 * Each zone has two spacings, because a block is a long strip and not a lozenge
 * (spec section 6.1). `across` is the gap between the streets that run across
 * the field's major direction, `along` the gap between the avenues that run
 * with it. One spacing both ways lays roughly three times the street per
 * hectare and leaves every block a small lozenge with nothing worth building
 * on.
 *
 * `across` is what the old single spacing was, so the rhythm of the side
 * streets is unchanged: 90 m in the core, which is a Manhattan side street.
 * `along` is two to five times that. In the core and the inner ring it is far
 * wider than the 240 m an avenue wants, because the arterial fill has already
 * laid a road every `ARTERIAL_SPACING` of the map — about 230 m — in both
 * directions. The streets that run with the field only fill what is left
 * between those arterials, so the avenue-grade spacing on the ground is the
 * arterial's and not this figure.
 *
 * The ratio drops toward two outside the city: the suburbs and the outskirts
 * want blocks as irregular as they fall, not strips.
 */
export const MINOR_BY_ZONE: Record<Zone, { tier: RoadTier; across: [number, number]; along: [number, number] }> = {
  core: { tier: 'street', across: [80, 105], along: [450, 600] },
  inner: { tier: 'street', across: [90, 120], along: [430, 570] },
  industrial: { tier: 'street', across: [115, 155], along: [230, 310] },
  suburban: { tier: 'street', across: [90, 135], along: [180, 270] },
  outskirts: { tier: 'dirt', across: [190, 270], along: [330, 470] },
  wilderness: { tier: 'dirt', across: [300, 430], along: [500, 720] },
};

/** What the fill lays where it is seeded. */
export interface FillPlan {
  tier: RoadTier;
  params: TierParams;
  /**
   * Metres to the next road of this tier running the same way. It is how far a
   * road must run before it may rejoin the one that seeded it.
   */
  spacing: number;
  /**
   * Metres a seed must stand clear of every other road for a road to be laid
   * there, and the shortest road worth laying. It is half the tighter of the
   * zone's two spacings, never half of `spacing`: an avenue is seeded 240 m off
   * its parent and crosses a street every 80 m, so a clearance taken from its
   * own spacing would refuse every avenue after the first.
   */
  clearance: number;
  /** Metres a road may run past its seed without meeting another road. */
  deadEnd: number;
  /** Ground this tier may stand on. */
  within: (x: number, y: number) => boolean;
}

/** How the fill reads a zone's spacing: for a road running across the field's major direction, or with it. */
export type SpacingAt = (x: number, y: number, across: boolean) => number;

/** How the fill plans a road: where it stands, and which way it will run. */
export type PlanAt = (x: number, y: number, across: boolean) => FillPlan;

/** Where the fill should try to lay its next road. */
export interface FillSeed {
  x: number;
  y: number;
  /** Direction of the road that seeded this one; the new road runs parallel to it. */
  along: number;
  /** Curve the seed came from, which the new road may not immediately rejoin. */
  parent: number;
  /** How many arterials removed from the highways this one is. */
  depth: number;
  /** True when the seed sits on its parent, so the road it grows is joined to the network from its first point. */
  onParent: boolean;
}
