/**
 * The rule a road asks the ground: whether a straight span stays dry, how hard
 * it climbs, and how far the ground leaves the line the road drives.
 *
 * The tracer vets every step with it and the network every junction it cuts
 * into a road as the road is added, so a junction is only cut where the trace
 * would have laid one.
 */
import { dist } from '../../core/math.ts';
import type { Heightfield } from '../terrain/heightfield.ts';
import { TIERS } from './tiers.ts';
import type { Point, RoadTier } from '../types.ts';

/**
 * True when a road of a tier can be driven from one place straight to another:
 * dry ground all the way, and no steeper than the tier allows.
 */
export type CanRun = (a: Point, b: Point, tier: RoadTier) => boolean;

/**
 * True where a road may not go although the ground is dry: an airfield of spec
 * section 8.4. The trace treats such ground as it treats the sea.
 */
export type KeepOut = (x: number, y: number) => boolean;

/** Metres a road needs above sea level; the waterline itself is not road-worthy ground. */
export const DRY_MARGIN = 0.8;
/** Metres between the wetness samples that vet one step. */
const WET_SAMPLE = 4;

/**
 * What the ground does under a straight span: whether it stays dry, how hard the
 * span climbs, and how far the ground leaves the line the road drives. One walk
 * answers all three, because every caller wants at least two of them.
 *
 * `liftA` and `liftB` are how far over the ground the road stands at the two
 * ends (`RoadCurve.lift`). The line the ground is measured against is the one
 * the road really drives, so a raised span is asked the same question a span on
 * the ground is: how far the ground falls away under it.
 */
export function spanProfile(
  hf: Heightfield,
  seaLevel: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  liftA = 0,
  liftB = 0,
  keepOut?: KeepOut,
): Profile {
  const run = dist(ax, ay, bx, by);
  const start = hf.sample(ax, ay) + liftA;
  const end = hf.sample(bx, by) + liftB;
  const steps = Math.max(1, Math.ceil(run / WET_SAMPLE));
  const dryAt = (x: number, y: number): boolean => hf.sample(x, y) >= seaLevel + DRY_MARGIN && keepOut?.(x, y) !== true;
  let dry = dryAt(ax, ay) && dryAt(bx, by);
  let above = 0;
  let below = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const h = hf.sample(x, y);
    if (h < seaLevel + DRY_MARGIN || keepOut?.(x, y) === true) dry = false;
    const line = start + (end - start) * t;
    if (h - line > above) above = h - line;
    if (line - h > below) below = line - h;
  }
  return { dry, grade: run > 0 ? Math.abs(end - start) / run : 0, above, below };
}

/**
 * The rule the network asks the ground at a junction: may a road of this tier be
 * driven straight from one place to another? It is the rule the tracer traces
 * by, so a junction is only cut into a road where the trace would have laid one.
 */
export function groundRule(hf: Heightfield, seaLevel: number, keepOut?: KeepOut): CanRun {
  return (a, b, tier) => {
    const profile = spanProfile(hf, seaLevel, a.x, a.y, b.x, b.y, 0, 0, keepOut);
    return profile.dry && profile.grade <= TIERS[tier].maxGrade;
  };
}

/** What the ground does under a straight span, from one walk along it. */
export interface Profile {
  /** True when no part of the span stands over water. */
  dry: boolean;
  /** Rise over run between the two ends. */
  grade: number;
  /** Metres the ground stands above the line between the ends, at its highest. */
  above: number;
  /** Metres the ground falls below that line, at its lowest. */
  below: number;
}
