/**
 * The piers that carry the decks (spec sections 6.1, 6.3).
 *
 * A deck is a run of the segments a curve lists in `bridges`: the strait
 * crossings, the dips a road may not follow down, and the elevated stretches
 * `highway-plan.ts` plans. Every deck stands on a pair of piers at each bay, and
 * the bays are spaced evenly along the run so neither abutment carries a pier of
 * its own.
 *
 * Over land a pier stands on the ground the deck's elevated corridor claims and
 * nowhere else, so `corridors.ts` places those feet when it claims the strip.
 * Over water no corridor claims anything, and a foot stands wherever the water
 * is. Neither kind stands on the ground a road below claims: a pier in the
 * middle of the street that passes under the deck is a pier the traffic drives
 * into.
 *
 * A pier is a solid: `corridor-mesh.ts` draws the column and `ground-bodies.ts`
 * stands a collider in it, both from {@link PIER_HALF} and the two numbers
 * beside it, so the column a car hits is the column it can see.
 *
 * Built on demand from the world description, like the footprint and the
 * parcels. Pure: the same world gives the same piers, in the same order.
 */
import { atan2 } from '../core/libm.ts';
import { clamp, direction, dist } from '../core/math.ts';
import { DECK_SOFFIT } from './decks.ts';
import { buildRoadGraph } from './graph.ts';
import { Heightfield } from './heightfield.ts';
import { buildJunctions } from './junctions.ts';
import { RoadRibbons } from './ribbon.ts';
import { footprintHalfWidth, TIERS } from './tiers.ts';
import type { Point, RoadCurve, RoadTier, WorldDescription } from './types.ts';

/** Metres between the pier bays under a deck. */
const PIER_SPACING = 25;
/** How many places across the deck a foot is tried at before it is given up on. */
const PIER_TRIES = 4;
/** How far a foot stands from the centreline, as a fraction of the half-width. */
const PIER_INSET = 0.5;
/** Metres of verge each side of a deck, so the strip under it is wider than the carriageway. */
const DECK_VERGE = 2;
/** Metres between the samples that ask whether the ground under a deck is water. */
const WET_SAMPLE = 4;
/** Side of one bucket of the ground index, in metres. */
const INDEX_CELL = 48;

/** Metres each side of a pier's centre, across the deck and along it. A highway stands on wider piers. */
export const PIER_HALF: Record<RoadTier, number> = { highway: 1, arterial: 0.8, street: 0.6, alley: 0.5, dirt: 0.5 };
/** Metres a pier is sunk into the ground under it, so no gap shows where the ground slopes. */
export const PIER_FOOTING = 0.6;
/** Metres a pier reaches up into its deck, so no gap shows under the soffit. */
export const PIER_OVERLAP = 0.1;
/**
 * The shortest pier worth standing, in metres. A deck lower than this over the
 * ground is on its ramp, and neither the mesh nor the collider is built there.
 */
export const MIN_PIER = 0.5;

/** One pier: where its foot stands, and the segment of the deck it carries. */
export interface DeckPier {
  x: number;
  y: number;
  curve: number;
  /** The segment of the curve the pier stands under. It is always in the curve's `bridges`. */
  segment: number;
  /**
   * Metres the foot stands across that segment from its centreline, positive to
   * the left of travel, as a road frame measures across (`ribbon.ts`).
   */
  across: number;
}

/** Metres each side of the centreline the strip under a curve's deck reaches. */
export function deckHalfWidth(road: RoadCurve): number {
  return TIERS[road.tier].width / 2 + DECK_VERGE;
}

/**
 * Every pier of a world: the feet each elevated corridor stands, then the feet
 * of every deck over water, curve by curve.
 */
export function deckPiers(world: WorldDescription): DeckPier[] {
  const out: DeckPier[] = [];
  for (const corridor of world.corridors) {
    if (corridor.kind !== 'elevated') continue;
    const road = world.roads[corridor.roads[0] as number] as RoadCurve;
    for (const foot of corridor.pillars) out.push(pierAt(road, foot));
  }
  const hf = new Heightfield(world.terrain);
  const sea = world.water.seaLevel;
  const ground = new RoadGround(world.roads);
  for (const road of world.roads) {
    for (const run of wetRuns(road, hf, sea)) {
      const points = road.points.slice(run.from, run.to + 2);
      const stands = (foot: Point): boolean => hf.sample(foot.x, foot.y) < sea && !ground.covers(foot, road.id);
      for (const foot of pierFeet(points, deckHalfWidth(road), stands)) out.push(pierAt(road, foot));
    }
  }
  return out;
}

/** True when any part of a span stands over water, so no land lies under all of it. */
export function overWater(hf: Heightfield, sea: number, a: Point, b: Point): boolean {
  const steps = Math.max(1, Math.ceil(dist(a.x, a.y, b.x, b.y) / WET_SAMPLE));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (hf.sample(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) < sea) return true;
  }
  return false;
}

/**
 * Runs of neighbouring deck segments of one line, split by whether they stand
 * over water. A line the network has not taken yet has no id and no nodes, so
 * this asks for the points and the decks alone: `water-lift.ts` reads the runs
 * of a draft.
 */
export function deckRuns(
  road: { points: readonly Point[]; bridges: readonly number[] },
  wet: (a: Point, b: Point) => boolean,
  want: boolean,
): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  let open: { from: number; to: number } | undefined;
  for (const at of road.bridges) {
    const a = road.points[at] as Point | undefined;
    const b = road.points[at + 1] as Point | undefined;
    if (a === undefined || b === undefined || wet(a, b) !== want) {
      open = undefined;
      continue;
    }
    if (open !== undefined && open.to === at - 1) open.to = at;
    else runs.push((open = { from: at, to: at }));
  }
  return runs;
}

function wetRuns(road: RoadCurve, hf: Heightfield, sea: number): { from: number; to: number }[] {
  return deckRuns(road, (a, b) => overWater(hf, sea, a, b), true);
}

/**
 * The feet of the piers under a deck: a pair across the centreline at every
 * bay. A foot `stands` refuses is drawn in towards the centreline until it is
 * accepted, and dropped where even the centreline is not.
 */
export function pierFeet(points: readonly Point[], halfWidth: number, stands: (foot: Point) => boolean): Point[] {
  const length = polylineLength(points);
  const bays = Math.max(2, Math.round(length / PIER_SPACING));
  const feet: Point[] = [];
  for (let i = 1; i < bays; i++) {
    const at = pointAlong(points, (length * i) / bays);
    for (const side of [1, -1]) {
      const foot = standing(at, side * halfWidth * PIER_INSET, stands);
      if (foot !== undefined) feet.push(foot);
    }
  }
  return feet;
}

/** A foot at an offset across the line, brought in towards the line until it stands. */
function standing(
  at: { x: number; y: number; dx: number; dy: number },
  offset: number,
  stands: (foot: Point) => boolean,
): Point | undefined {
  for (let step = 0; step < PIER_TRIES; step++) {
    const out = offset * (1 - step / PIER_TRIES);
    const foot = { x: at.x - at.dy * out, y: at.y + at.dx * out };
    if (stands(foot)) return foot;
  }
  return undefined;
}

/** A foot as a pier of a curve: the deck segment nearest it, and how far across that segment it stands. */
function pierAt(road: RoadCurve, foot: Point): DeckPier {
  const segment = nearestDeck(road, foot);
  const a = road.points[segment] as Point;
  const b = road.points[segment + 1] as Point;
  const length = dist(a.x, a.y, b.x, b.y);
  const across = length === 0 ? 0 : ((foot.x - a.x) * -(b.y - a.y) + (foot.y - a.y) * (b.x - a.x)) / length;
  return { x: foot.x, y: foot.y, curve: road.id, segment, across };
}

/** The deck segment of a curve nearest a place. */
function nearestDeck(road: RoadCurve, p: Point): number {
  let best = road.bridges[0] as number;
  let bestD = Infinity;
  for (const i of road.bridges) {
    const d = segmentDistance(p, road.points[i] as Point, road.points[i + 1] as Point);
    if (d >= bestD) continue;
    bestD = d;
    best = i;
  }
  return best;
}

/** One pier as a solid: a square column, square to the deck it carries. */
export interface PierColumn {
  x: number;
  y: number;
  /** Metres each side of the centre, across the deck and along it. */
  half: number;
  /** The height of the underside of the deck over the column, in metres. */
  soffit: number;
  /** The angle the column is turned by about the vertical, so its sides face along and across the deck. */
  angle: number;
}

/**
 * Every pier of a world as a column, in the order {@link deckPiers} lists them.
 * The top is the underside of the deck the pier carries; how far down the
 * column reaches is the ground under the foot, which the caller holds
 * (`ground-bodies.ts` reads the carved height the wheels drive on).
 */
export function pierColumns(world: WorldDescription): PierColumn[] {
  const roads = world.roads;
  const ribbons = new RoadRibbons(world.terrain, roads, buildJunctions(roads, buildRoadGraph(roads)));
  const out: PierColumn[] = [];
  for (const pier of deckPiers(world)) {
    const road = roads[pier.curve] as RoadCurve;
    const frame = ribbons.frameAt(pier.curve, pier.segment, pier.x, pier.y);
    out.push({
      x: pier.x,
      y: pier.y,
      half: PIER_HALF[road.tier],
      soffit: frame.height + frame.bank * pier.across - DECK_SOFFIT,
      // Across the road is along it turned a quarter, so the angle of the
      // column about the vertical is the angle of the across vector.
      angle: atan2(frame.acrossY, frame.acrossX),
    });
  }
  return out;
}

/** The point a given distance along a polyline, and the way the line runs there. */
export function pointAlong(points: readonly Point[], metres: number): { x: number; y: number; dx: number; dy: number } {
  let run = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const seg = dist(a.x, a.y, b.x, b.y);
    if (seg <= 0) continue;
    if (run + seg >= metres) {
      const t = (metres - run) / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx: (b.x - a.x) / seg, dy: (b.y - a.y) / seg };
    }
    run += seg;
  }
  const last = points[points.length - 1] as Point;
  const before = points[points.length - 2] as Point;
  const d = direction(before, last);
  return { x: last.x, y: last.y, dx: d.x, dy: d.y };
}

export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    total += dist(a.x, a.y, b.x, b.y);
  }
  return total;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length, 0, 1);
  return dist(p.x, p.y, a.x + dx * t, a.y + dy * t);
}

/**
 * The ground the roads stand on, as segments in a grid of buckets, so a pier
 * can ask whether its foot stands on a road below it.
 */
export class RoadGround {
  private readonly segments: { curve: number; a: Point; b: Point; reach: number }[] = [];
  private readonly buckets = new Map<number, number[]>();

  constructor(roads: readonly RoadCurve[]) {
    for (const road of roads) {
      const reach = footprintHalfWidth(road.tier);
      for (let i = 0; i + 1 < road.points.length; i++) {
        if (road.bridges.includes(i) || road.tunnels.includes(i)) continue;
        const a = road.points[i] as Point;
        const b = road.points[i + 1] as Point;
        const id = this.segments.length;
        this.segments.push({ curve: road.id, a, b, reach });
        for (let row = cellOf(Math.min(a.y, b.y) - reach); row <= cellOf(Math.max(a.y, b.y) + reach); row++) {
          for (let col = cellOf(Math.min(a.x, b.x) - reach); col <= cellOf(Math.max(a.x, b.x) + reach); col++) {
            const key = bucketKey(col, row);
            const bucket = this.buckets.get(key);
            if (bucket === undefined) this.buckets.set(key, [id]);
            else bucket.push(id);
          }
        }
      }
    }
  }

  /** True when a place stands on the ground a road other than `except` claims. */
  covers(p: Point, except: number): boolean {
    for (const id of this.buckets.get(bucketKey(cellOf(p.x), cellOf(p.y))) ?? []) {
      const s = this.segments[id] as { curve: number; a: Point; b: Point; reach: number };
      if (s.curve !== except && segmentDistance(p, s.a, s.b) < s.reach) return true;
    }
    return false;
  }
}

function cellOf(v: number): number {
  return Math.floor(v / INDEX_CELL);
}

/** One number per bucket; a world is a few kilometres across, far inside the range. */
function bucketKey(col: number, row: number): number {
  return (col + 32_768) * 65_536 + (row + 32_768);
}
