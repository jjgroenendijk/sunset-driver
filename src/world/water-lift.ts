/**
 * The lift a deck over water takes, so the road stands clear of the sea it
 * spans (spec sections 6.1, 7.2).
 *
 * A bed is the natural ground under the curve's own points, straight between
 * them (`bed.ts`). At a strait both abutments stand at the shore, so without a
 * lift the deck is a straight line a metre over the water and its underside is
 * under it: the piers below cannot be seen and no boat passes (issue #304).
 *
 * So every deck over water is raised until {@link WATER_CLEARANCE} of air
 * stands between the sea and its underside, and ramps back down to the ground
 * each side no harder than its tier's `maxGrade`. That is the shape
 * `overpass.ts` already gives a road carried over another one, so a wet deck
 * asks for the same {@link Raise} and `raised` lays it in: the lift at every
 * point, and every raised segment listed as a deck.
 *
 * The ramp ends on a point the line already has, and reaches past nothing that
 * has to stay on the ground: a bore, an interchange, a point the network
 * already has a junction on, a place the line passes under a highway, or the
 * end of the line. A junction is one plane at the height of the ground under
 * it (`bed.ts`) and no junction is built on a deck (`junctions.ts`), so a ramp
 * laid over one would leave the road that meets it there in mid-air. Where
 * there is not enough line for the full ramp the lift is cut to what the grade
 * reaches in the room there is, so a short approach gives a lower deck rather
 * than a ramp no car can climb.
 *
 * Pure: the same line and ground give the same raises.
 */
import { DECK_SOFFIT } from './decks.ts';
import { deckRuns } from './piers.ts';
import type { Raise } from './overpass.ts';
import { curveDistances } from './ribbon.ts';
import { TIERS } from './tiers.ts';
import type { Point, RoadTier } from './types.ts';

/**
 * Metres of air between the sea and the underside of a deck over it. The
 * speedboat of spec section 11.3 stands about a metre out of the water, so
 * three metres is headroom for it and reads as a bridge rather than a causeway.
 */
export const WATER_CLEARANCE = 3;

/** A line as a water lift is planned on it: its points, its structures and the lift it already carries. */
export interface WetLine {
  tier: RoadTier;
  points: readonly Point[];
  bridges: readonly number[];
  tunnels: readonly number[];
  interchanges: readonly number[];
}

/**
 * The raises a line's decks over water ask for, one per run of wet deck. Empty
 * where the line crosses no water, or where every wet deck already stands high
 * enough.
 *
 * `ground` is the natural height at a place and `wet` says whether a segment
 * stands over water; both are the tracer's own readings of the terrain. `under`
 * is the distances along the line where it passes under a highway, which it
 * does on the ground: a road is never raised over a highway (spec section 6.2).
 */
export function waterRaises(
  line: WetLine,
  ground: (x: number, y: number) => number,
  seaLevel: number,
  wet: (a: Point, b: Point) => boolean,
  under: readonly number[] = [],
  onNetwork: (p: Point) => boolean = () => false,
): Raise[] {
  const along = curveDistances(line.points);
  const grade = TIERS[line.tier].maxGrade;
  const raises: Raise[] = [];
  for (const run of deckRuns(line, wet, true)) {
    const deck = seaLevel + WATER_CLEARANCE + DECK_SOFFIT;
    let wanted = 0;
    for (let i = run.from; i <= run.to + 1; i++) {
      const p = line.points[i] as Point;
      wanted = Math.max(wanted, deck - ground(p.x, p.y));
    }
    if (wanted <= 0) continue;
    const low = along[run.from] as number;
    const high = along[run.to + 1] as number;
    // The ramps reach out to the first thing that may not be raised, and the
    // shorter of the two rooms holds the height: the deck is level, so both
    // ramps climb the same way.
    const before = low - Math.max(along[clearBack(line, run.from, onNetwork)] as number, lastUnder(under, low));
    const after = Math.min(along[clearOn(line, run.to + 1, onNetwork)] as number, firstUnder(under, high)) - high;
    const height = Math.min(wanted, before * grade, after * grade);
    if (height <= 0) continue;
    const ramp = height / grade;
    raises.push({
      from: along[lastAtOrBefore(along, low - ramp)] as number,
      low,
      high,
      to: along[firstAtOrAfter(along, high + ramp)] as number,
      height,
    });
  }
  return raises;
}

/**
 * The point back from a deck the foot of its ramp stands on: the start of the
 * line, the far end of the first bore behind it, or the first point a junction
 * already stands on. The foot carries no lift, so a junction there is left as
 * it was; one further in would be raised with the ramp, and the abutment of
 * the deck itself counts, which is why the walk starts there. A deck with a
 * junction at its abutment takes no lift at all.
 */
function clearBack(line: WetLine, from: number, onNetwork: (p: Point) => boolean): number {
  for (let i = from; i > 0; i--) {
    if (line.interchanges.includes(i) || onNetwork(line.points[i] as Point)) return i;
    if (line.tunnels.includes(i - 1)) return i;
  }
  return 0;
}

/** The same, forwards from the far end of a deck. */
function clearOn(line: WetLine, to: number, onNetwork: (p: Point) => boolean): number {
  const last = line.points.length - 1;
  for (let i = to; i < last; i++) {
    if (line.interchanges.includes(i) || onNetwork(line.points[i] as Point)) return i;
    if (line.tunnels.includes(i)) return i;
  }
  return last;
}

/** The last place behind a deck the line passes under a highway, or the start of the line. */
function lastUnder(under: readonly number[], low: number): number {
  let best = 0;
  for (const d of under) if (d <= low && d > best) best = d;
  return best;
}

/** The first such place past a deck, or infinity where there is none. */
function firstUnder(under: readonly number[], high: number): number {
  let best = Infinity;
  for (const d of under) if (d >= high && d < best) best = d;
  return best;
}

function firstAtOrAfter(along: Float32Array, d: number): number {
  for (let i = 0; i < along.length; i++) if ((along[i] as number) >= d) return i;
  return along.length - 1;
}

function lastAtOrBefore(along: Float32Array, d: number): number {
  let best = 0;
  for (let i = 0; i < along.length && (along[i] as number) <= d; i++) best = i;
  return best;
}
