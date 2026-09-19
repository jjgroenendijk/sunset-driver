/**
 * Where a road may bridge a river (spec section 7.2): a short deck straight
 * across it, well above its mouth.
 *
 * A river is carved below sea level from its source to its mouth, so without a
 * deck the land on its two banks joins only round the source (issue #276). The
 * strait crossings of the water description are planned before any road; a
 * river deck is not. The trace lays one where an arterial meets a river nearly
 * square, and `markStructures` finds it again as the one kind of wet segment a
 * trace lays.
 */
import { dist } from '../core/math.ts';
import { hypot } from '../core/libm.ts';
import type { Heightfield } from './heightfield.ts';
import { DRY_MARGIN } from './road-ground.ts';
import { segmentDistance } from './rivers.ts';
import type { Point, RiverDescription } from './types.ts';

/** Metres of the longest river deck. A longer span is not a river any more. */
export const RIVER_DECK = 240;
/** Metres past its half-width a river's water still counts as the river: the reach of its carved banks. */
const BANK = 70;
/**
 * Metres above the mouth, past its width and its banks, where the river is
 * still the river. Lower down its water runs into the sea, and a deck there
 * would stand over the sea.
 */
const MOUTH_CLEAR = 200;
/** Sine of the shallowest angle a deck may cross a river at: 60°. */
const MIN_CROSS_SINE = 0.866;
/** Metres between the samples that vet a deck. */
const SAMPLE = 4;

/** One segment of a river's course, and how far either side of it is river. */
interface Reach {
  river: number;
  from: Point;
  to: Point;
  reach: number;
}

/** The rivers of a map as water a road may bridge. */
export class RiverWater {
  private readonly hf: Heightfield;
  private readonly seaLevel: number;
  private readonly reaches: Reach[] = [];

  constructor(rivers: readonly RiverDescription[], hf: Heightfield, seaLevel: number) {
    this.hf = hf;
    this.seaLevel = seaLevel;
    rivers.forEach((river, index) => {
      const path = river.path;
      const mouth = path[path.length - 1] as Point;
      const clear = (river.halfWidths[path.length - 1] as number) + BANK + MOUTH_CLEAR;
      for (let i = 0; i + 1 < path.length; i++) {
        const from = path[i] as Point;
        const to = path[i + 1] as Point;
        if (dist(to.x, to.y, mouth.x, mouth.y) < clear) break;
        this.reaches.push({ river: index, from, to, reach: (river.halfWidths[i] as number) + BANK });
      }
    });
  }

  /** The segment of river course nearest a point that holds it, or undefined where no river does. */
  private holding(x: number, y: number): Reach | undefined {
    let best: Reach | undefined;
    let bestD = Infinity;
    for (const r of this.reaches) {
      const d = segmentDistance(x, y, r.from, r.to);
      if (d <= r.reach && d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  /**
   * True where a straight span is a river deck: dry at both ends, no longer
   * than {@link RIVER_DECK}, all its water one river above the mouth, and
   * crossing that river at 60° or more.
   */
  spans(a: Point, b: Point): boolean {
    if (this.reaches.length === 0) return false;
    const run = dist(a.x, a.y, b.x, b.y);
    if (run > RIVER_DECK || run <= 0) return false;
    const wet = (x: number, y: number): boolean => this.hf.sample(x, y) < this.seaLevel + DRY_MARGIN;
    if (wet(a.x, a.y) || wet(b.x, b.y)) return false;
    const steps = Math.max(1, Math.ceil(run / SAMPLE));
    let river = -1;
    let first = -1;
    let last = -1;
    const held: (Reach | undefined)[] = [];
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      if (!wet(x, y)) {
        held.push(undefined);
        continue;
      }
      const r = this.holding(x, y);
      if (r === undefined || (river >= 0 && r.river !== river)) return false;
      river = r.river;
      if (first < 0) first = i;
      last = i;
      held.push(r);
    }
    if (river < 0) return false;
    // An island in the river leaves a dry sample in the middle; the first wet one stands in for it.
    const middle = held[((first + last) >> 1) - 1] ?? (held[first - 1] as Reach);
    const cx = middle.to.x - middle.from.x;
    const cy = middle.to.y - middle.from.y;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const course = hypot(cx, cy);
    if (course <= 0) return false;
    return Math.abs(cx * dy - cy * dx) / (course * run) >= MIN_CROSS_SINE;
  }
}
