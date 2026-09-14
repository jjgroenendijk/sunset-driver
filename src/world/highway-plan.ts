/**
 * The structure of a highway, planned when the highway is laid (spec section
 * 6.2): which stretches stand on the ground and which on a deck, and where a
 * road laid later may cross it.
 *
 * A highway takes a junction only at an interchange, so between two of them it
 * is free to leave the ground. In the built-up zones it does: it ramps up once
 * it is clear of the interchange, runs on a deck to the next one, and ramps down
 * again. Out in the country it stays on the ground and rises on one short deck
 * in the middle of each stretch, so a lane can still get across.
 *
 * The level part of each deck is where a lower road may pass under the highway.
 * Those segments are the highway's slots. A road laid later crosses a highway
 * only at a slot or joins it at an interchange; `road-clear.ts` refuses every
 * other crossing when the road is traced. Nothing decides this afterwards, so
 * `overpass.ts` never has to find room for a raise between two streets.
 *
 * Pure: the same line gives the same plan.
 */
import { MAX_CUT } from './junctions.ts';
import { CLEARANCE } from './overpass.ts';
import { curveDistances } from './ribbon.ts';
import { footprintHalfWidth, TIERS } from './tiers.ts';
import type { Point, RoadCurve } from './types.ts';

/**
 * Metres each side of an interchange the highway stays on the ground. A
 * junction is one plane at the height of the ground, and its mouths blend back
 * onto the road over one cut more (`bed.ts`).
 */
export const INTERCHANGE_CLEAR = 2 * MAX_CUT;
/** Metres of ramp between the ground and the deck, at the highway's grade limit. */
export const HIGHWAY_RAMP = CLEARANCE / TIERS.highway.maxGrade;
/** Metres of level deck a highway rises on in the country, in the middle of a stretch. */
export const COUNTRY_DECK = 150;
/**
 * Metres each side of a place where a highway passes under another one that it
 * stays on the ground: the footprint of the highway above, and a margin.
 */
const UNDER_CLEAR = footprintHalfWidth('highway') + 8;

/** What a highway stands on, as the curve stores it. */
export interface HighwayStructure {
  /** Metres over the ground at each point, or undefined where the whole highway is on the ground. */
  lift: number[] | undefined;
  /** Every deck segment, the ones the line already had included. Ascending. */
  bridges: number[];
  /** The segments a lower road may cross under. Ascending. */
  slots: number[];
}

/**
 * Plan the decks and the slots of a highway. `bridges` and `tunnels` are the
 * structures the ground already asked for; the plan leaves them as they are and
 * keeps its decks off them. `under` is the distances along the line where it
 * passes under a highway laid before it, which it does on the ground.
 * `builtUp` says whether a place is city, where the highway runs on a deck from
 * one interchange to the next.
 */
export function planHighway(
  points: readonly Point[],
  bridges: readonly number[],
  tunnels: readonly number[],
  interchanges: readonly number[],
  under: readonly number[],
  builtUp: (x: number, y: number) => boolean,
): HighwayStructure {
  const along = curveDistances(points);
  const last = points.length - 1;
  const lift = new Array<number>(points.length).fill(0);
  const blocked: [number, number][] = [];
  for (const i of interchanges) blocked.push([(along[i] as number) - INTERCHANGE_CLEAR, (along[i] as number) + INTERCHANGE_CLEAR]);
  for (const i of [...bridges, ...tunnels]) blocked.push([along[i] as number, along[i + 1] as number]);
  for (const d of under) blocked.push([d - UNDER_CLEAR, d + UNDER_CLEAR]);
  for (const [lo, hi] of freeStretches(along, blocked)) {
    // The stretch holds the ramps and the deck; its two ends stay on the ground.
    const start = firstAtOrAfter(along, lo);
    const end = lastAtOrBefore(along, hi);
    if (start === undefined || end === undefined) continue;
    let low = firstAtOrAfter(along, (along[start] as number) + HIGHWAY_RAMP);
    let high = lastAtOrBefore(along, (along[end] as number) - HIGHWAY_RAMP);
    if (low === undefined || high === undefined || high - low < 3) continue;
    const middle = points[(low + high) >> 1] as Point;
    if (!builtUp(middle.x, middle.y)) {
      const centre = ((along[low] as number) + (along[high] as number)) / 2;
      low = Math.max(low, firstAtOrAfter(along, centre - COUNTRY_DECK / 2) as number);
      high = Math.min(high, lastAtOrBefore(along, centre + COUNTRY_DECK / 2) as number);
      if (high - low < 3) continue;
    }
    // A ramp ends on a point of the line, so it is never steeper than the
    // grade allows; it can only be longer.
    const foot = lastAtOrBefore(along, (along[low] as number) - HIGHWAY_RAMP) as number;
    const toe = firstAtOrAfter(along, (along[high] as number) + HIGHWAY_RAMP) as number;
    for (let i = foot + 1; i < toe; i++) {
      const d = along[i] as number;
      let h = CLEARANCE;
      if (i < low) h = (CLEARANCE * (d - (along[foot] as number))) / ((along[low] as number) - (along[foot] as number));
      else if (i > high) h = (CLEARANCE * ((along[toe] as number) - d)) / ((along[toe] as number) - (along[high] as number));
      lift[i] = h;
    }
  }

  const decks = bridges.slice();
  const slots: number[] = [];
  for (let i = 0; i < last; i++) {
    if (((lift[i] as number) > 0 || (lift[i + 1] as number) > 0) && !decks.includes(i)) decks.push(i);
    // A slot has the full clearance over it and over the segment each side, so
    // a road that crosses near its end still passes under the level deck.
    if (i < 1 || i + 2 > last) continue;
    let level = true;
    for (let k = i - 1; k <= i + 2; k++) if (lift[k] !== CLEARANCE) level = false;
    if (level) slots.push(i);
  }
  decks.sort((a, b) => a - b);
  return { lift: lift.some((h) => h > 0) ? lift : undefined, bridges: decks, slots };
}

/**
 * The distances along a line where it crosses one of `highways` between their
 * points. A crossing on a point is an interchange the two share, not a crossing.
 */
export function crossingsWith(points: readonly Point[], highways: readonly RoadCurve[]): number[] {
  const along = curveDistances(points);
  const out: number[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    for (const road of highways) {
      for (let k = 0; k + 1 < road.points.length; k++) {
        const t = crossAt(a, b, road.points[k] as Point, road.points[k + 1] as Point);
        if (t !== undefined) out.push((along[i] as number) + t * ((along[i + 1] as number) - (along[i] as number)));
      }
    }
  }
  return out.sort((x, y) => x - y);
}

/** Where along `a`–`b` it crosses `c`–`d` strictly inside both, or undefined. */
function crossAt(a: Point, b: Point, c: Point, d: Point): number | undefined {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (denominator === 0) return undefined;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denominator;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denominator;
  const inside = (v: number): boolean => v > 1e-9 && v < 1 - 1e-9;
  return inside(t) && inside(u) ? t : undefined;
}

/** The stretches of a line free to leave the ground: all of it but the blocked intervals, as distances along it. */
function freeStretches(along: Float32Array, blocked: [number, number][]): [number, number][] {
  blocked.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const total = along[along.length - 1] as number;
  const free: [number, number][] = [];
  let at = 0;
  for (const [lo, hi] of blocked) {
    if (lo > at) free.push([at, Math.min(lo, total)]);
    at = Math.max(at, hi);
  }
  if (at < total) free.push([at, total]);
  return free;
}

function firstAtOrAfter(along: Float32Array, d: number): number | undefined {
  for (let i = 0; i < along.length; i++) if ((along[i] as number) >= d) return i;
  return undefined;
}

function lastAtOrBefore(along: Float32Array, d: number): number | undefined {
  let best: number | undefined;
  for (let i = 0; i < along.length && (along[i] as number) <= d; i++) best = i;
  return best;
}
