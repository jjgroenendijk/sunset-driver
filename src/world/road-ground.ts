/**
 * The rule a road asks the ground: whether a straight span stays dry, how hard
 * it climbs, and how far the ground leaves the line the road drives.
 *
 * The tracer vets every step with it and the connection pass every junction it
 * cuts, so a junction is only cut into a road where the trace would have laid
 * one.
 */
import { dist } from '../core/math.ts';
import type { CanRun } from './connect.ts';
import type { Heightfield } from './heightfield.ts';
import { TIERS } from './tiers.ts';

/** Metres a road needs above sea level; the waterline itself is not road-worthy ground. */
export const DRY_MARGIN = 0.8;
/** Metres between the wetness samples that vet one step. */
const WET_SAMPLE = 4;

/**
 * What the ground does under a straight span: whether it stays dry, how hard the
 * span climbs, and how far the ground leaves the line the road drives. One walk
 * answers all three, because every caller wants at least two of them.
 */
export function spanProfile(hf: Heightfield, seaLevel: number, ax: number, ay: number, bx: number, by: number): Profile {
  const run = dist(ax, ay, bx, by);
  const start = hf.sample(ax, ay);
  const end = hf.sample(bx, by);
  const steps = Math.max(1, Math.ceil(run / WET_SAMPLE));
  const dryAt = (x: number, y: number): boolean => hf.sample(x, y) >= seaLevel + DRY_MARGIN;
  let dry = dryAt(ax, ay) && dryAt(bx, by);
  let above = 0;
  let below = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const h = hf.sample(ax + (bx - ax) * t, ay + (by - ay) * t);
    if (h < seaLevel + DRY_MARGIN) dry = false;
    const line = start + (end - start) * t;
    if (h - line > above) above = h - line;
    if (line - h > below) below = line - h;
  }
  return { dry, grade: run > 0 ? Math.abs(end - start) / run : 0, above, below };
}

/**
 * The rule the connection pass asks the ground: may a road of this tier be
 * driven straight from one place to another? It is the rule the tracer traces
 * by, so a junction is only cut into a road where the trace would have laid one.
 */
export function groundRule(hf: Heightfield, seaLevel: number): CanRun {
  return (a, b, tier) => {
    const profile = spanProfile(hf, seaLevel, a.x, a.y, b.x, b.y);
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
