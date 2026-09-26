/**
 * The words the streamline fills are written in: what one road of a fill is
 * laid at, and where the next one is seeded.
 *
 * `roads.ts` owns the fills themselves — the arterials between the highways,
 * the streets between the arterials — and `alleys.ts` the service lane inside a
 * block. Both speak of a seed and a plan, so the two types and the zone table
 * they read live here rather than in either of them.
 */
import { atan2, cos, sin } from '../../core/libm.ts';
import { directionDelta, dist } from '../../core/math.ts';
import type { TierParams } from './road-trace.ts';
import type { TensorField } from './tensor.ts';
import type { Point, RoadCurve, RoadTier, Zone } from '../types.ts';

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
 * In the city these streets are what ties one avenue to the next, since the
 * arterial fill widens its cross family there (`ARTERIAL_CROSS_BY_ZONE`).
 *
 * `along` is two to five times `across`. In the core and the inner ring it is
 * far wider than the 240 m an avenue wants, because the arterial fill has
 * already laid an avenue every `ARTERIAL_SPACING` of the map — about 230 m.
 * The streets that run with the field only fill what is left between those
 * arterials, so the avenue-grade spacing on the ground is the arterial's and
 * not this figure.
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

/**
 * How much wider apart the arterials running across the avenues stand in each
 * zone, as a multiple of `ARTERIAL_SPACING`.
 *
 * The arterial fill has two spacings, as the minor fill above has. The
 * arterials running with the field's major direction are the city's avenues and
 * stand `ARTERIAL_SPACING` apart everywhere; these are the gaps between the
 * arterials that cross them.
 *
 * A real city has no mesh of arterial squares. Its avenues run one way, and
 * what ties two of them together is a cross street and not another arterial. So
 * the city zones widen the cross family and let `MINOR_BY_ZONE.across` — a
 * street every 90 m — carry that direction instead. An arterial is 26 m wide
 * with its verge and its pavement, and downtown once carried a 230 m mesh of
 * them.
 *
 * Outside the city the number is one, so the fill there is the square mesh it
 * always was. The suburbs and the outskirts have no avenue grid to thin out,
 * and out there an arterial is the road that reaches the next district rather
 * than one of a pair.
 */
export const ARTERIAL_CROSS_BY_ZONE: Record<Zone, number> = {
  core: 4,
  inner: 4,
  industrial: 1,
  suburban: 1,
  outskirts: 1,
  wilderness: 1,
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

/** What {@link seedAlong} lays besides the two roads parallel to the curve. */
interface SeedOptions {
  /**
   * The tier being seeded may junction with a highway. Only the arterial fill
   * sets it, and even then a seed stands on a highway only at one of its
   * interchanges (spec section 6.2).
   */
  ramps?: boolean;
}

/**
 * Seeds for the next generation of the fill. Along a curve: one seed to each
 * side, pointing the same way, and one on the curve itself pointing across it.
 * The first two lay the parallel roads that carry the traffic, the third the
 * cross streets that tie them together.
 *
 * A zone has two spacings, so which one a seed is placed at depends on which
 * way the curve runs here. The side seeds go out at the spacing of the curve's
 * own family — an avenue's neighbour is another avenue — and the seeds are
 * dropped along the curve at the spacing of the other family, because that is
 * the cadence of the cross streets. Both are asked for at each point, so they
 * follow the district under it.
 */
export function seedAlong(
  curve: RoadCurve,
  field: TensorField,
  spacingAt: SpacingAt,
  depth: number,
  out: FillSeed[],
  opts: SeedOptions = {},
): void {
  const points = curve.points;
  let run: number | undefined;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const seg = dist(a.x, a.y, b.x, b.y);
    if (seg === 0) continue;
    const along = atan2(b.y - a.y, b.x - a.x);
    // Which family this stretch of the curve belongs to: with the field's major
    // direction, or across it.
    const runsAcross = directionDelta(field.majorAt(b.x, b.y), along) > Math.PI / 4;
    const step = spacingAt(b.x, b.y, !runsAcross);
    // A deck or a bore seeds nothing: there is no ground beside the road there.
    const structure = curve.bridges.includes(i) || curve.tunnels.includes(i);
    run = (run ?? step / 2) + seg;
    if (run < step || structure) continue;
    run -= step;
    const side = spacingAt(b.x, b.y, runsAcross);
    const nx = -sin(along) * side;
    const ny = cos(along) * side;
    for (const hand of [1, -1]) {
      out.push({ x: b.x + nx * hand, y: b.y + ny * hand, along, parent: curve.id, depth, onParent: false });
    }
    // A seed on the curve itself grows a road out of a junction with it. A
    // highway takes one only at an interchange, and only from an arterial ramp
    // (spec section 6.2), so the minor fill seeds nothing on one.
    const junctionable = curve.tier !== 'highway' || (opts.ramps === true && curve.interchanges.includes(i + 1));
    if (junctionable) out.push({ x: b.x, y: b.y, along: along + Math.PI / 2, parent: curve.id, depth, onParent: true });
  }
}
