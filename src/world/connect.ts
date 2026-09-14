/**
 * Where two roads cross on the ground, they meet (spec section 6.2).
 *
 * The tracer ends a road on another one by copying the point it met, so a
 * junction is a point two curves share. It only ever looks at points, so a road
 * that crosses another one between its points meets nothing: the two are laid
 * over each other, the graph calls the place an overpass, and both draw a full
 * carriageway on the same ground.
 *
 * This pass is the other half of that rule. It runs once the whole network is
 * traced, finds every place two curves cross, and gives both of them a point
 * there. The graph then makes the place a node and `junctions.ts` builds the
 * junction, so nothing downstream needs to know a crossing was ever there.
 *
 * A crossing is left alone where the tiers may not junction — a street over a
 * highway is an overpass, and spec section 6.2 says so — and where either road
 * stands on a deck or runs in a bore, because neither is on the ground.
 *
 * A crossing close to a point one of the curves already has takes that point
 * instead of a new one. Two junctions a metre apart are worse than a road bent
 * by a metre: the mouths of one would stand inside the other. So the meeting
 * place is the nearest point either curve has within {@link CROSSING_SNAP}, and
 * the curve that lacks it is the only one bent.
 *
 * Pure: the same curves give the same points, in the same order.
 */
import { compareNumbers } from '../core/sort.ts';
import { MIN_MEET } from './road-clear.ts';
import { footprintHalfWidth, mayJoin } from './tiers.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/**
 * Metres a crossing may be moved to land on a point a curve already has. A
 * street is about nine metres wide, so a bend this size is inside the road that
 * was drawn before; two junctions this close are not.
 */
export const CROSSING_SNAP = 4;

/** Metres two places may stand apart and still be the same point of a curve. */
const SAME_PLACE = 1e-6;

/** Side of one bucket of the segment index, in metres. */
const INDEX_CELL = 60;

/** Millimetres: two road points this close are the same place, as the graph reads them. */
const KEY_SCALE = 1000;
const KEY_OFFSET = 8_000_000;
const KEY_SPAN = 2 * KEY_OFFSET + 1;

/** A place two curves are to meet, and the segment of each that carries it. */
interface Meeting {
  curve: number;
  segment: number;
  other: number;
  otherSegment: number;
  x: number;
  y: number;
}

/** A point to be spliced into a curve, and where along the curve it goes. */
interface Insert {
  segment: number;
  /** How far along that segment the point stands, from 0 to 1. */
  at: number;
  x: number;
  y: number;
}

/**
 * Rounds the pass may take. A road bent onto a point it did not have can cross
 * a third road it missed before, so the pass is run again on what it made.
 * Each round only adds points, and a crossing whose place both curves already
 * have adds none, so the rounds settle rather than chase each other.
 */
const ROUNDS = 3;

/**
 * True when a road of a tier can be driven from one place straight to another:
 * dry ground all the way, and no steeper than the tier allows. Splitting a
 * segment can break both — a segment that climbs a dip inside the grade of its
 * tier has two halves that do not — so a crossing whose junction the ground
 * refuses is left a crossing.
 */
export type CanRun = (a: Point, b: Point, tier: RoadTier) => boolean;

/**
 * Every curve again, with a point wherever two of them cross on the ground. A
 * curve that crosses nothing comes back unchanged.
 */
export function connectCrossings(roads: readonly RoadCurve[], canRun: CanRun): RoadCurve[] {
  let out = [...roads];
  for (let round = 0; round < ROUNDS; round++) {
    const joined = connectOnce(out, canRun);
    if (joined === undefined) break;
    out = joined;
  }
  return out;
}

/** One round: the curves with their crossings given points, or nothing to do. */
function connectOnce(roads: readonly RoadCurve[], canRun: CanRun): RoadCurve[] | undefined {
  const meetings = crossingsOf(roads);
  if (meetings.length === 0) return undefined;

  const inserts: Insert[][] = roads.map(() => []);
  // The places each curve will have once the pass is applied: its own points
  // and everything already given to it, so a second crossing beside the first
  // takes the same point rather than one of its own.
  const places: Point[][] = roads.map((road) => road.points.map((p) => ({ x: p.x, y: p.y })));
  const order: number[] = [];
  for (let i = 0; i < roads.length; i++) order[roads[i]?.id ?? i] = i;

  const taken = new Taken(roads);
  for (const meeting of meetings) {
    const a = order[meeting.curve] as number;
    const b = order[meeting.other] as number;
    const first = roads[a] as RoadCurve;
    const second = roads[b] as RoadCurve;
    const here = { x: meeting.x, y: meeting.y };
    // The nearest point either road already has, so the roads are bent as
    // little as the places they stand on allow. A tie goes to the curve laid
    // first, so the answer does not depend on which segment was walked first.
    // Two roads that already meet here meet once: a second point a few metres
    // from the first cuts a sliver of road that lies along the other one.
    if (meetsNear(places[a] as Point[], places[b] as Point[], here, footprintHalfWidth(first.tier) + footprintHalfWidth(second.tier))) continue;
    const snapped = nearer(nearestPlace(places[a] as Point[], here), nearestPlace(places[b] as Point[], here), here);
    let firstPlan: Planned | undefined;
    let secondPlan: Planned | undefined;
    let spot = here;
    // A bend onto a point nearby can turn the two roads onto each other's
    // line, so the crossing itself is tried where the snapped place meets at
    // too shallow an angle.
    for (const place of snapped === undefined ? [here] : [snapped, here]) {
      // A point of a road neither of these two may junction with is no place for
      // one: a street bent onto a point of a highway would meet the highway.
      if (taken.refuses(place, first.tier) || taken.refuses(place, second.tier)) continue;
      const one = plan(first, meeting.segment, place, places[a] as Point[], inserts[a] as Insert[], canRun);
      const two = plan(second, meeting.otherSegment, place, places[b] as Point[], inserts[b] as Insert[], canRun);
      // Both roads take the point or neither does: one of them bent to a place
      // the other never reaches is a bend for nothing.
      if (one === undefined || two === undefined || shallow(place, one.around, two.around)) continue;
      // The point also turns each road where it leaves the places beside it,
      // and a road may already meet a third one there.
      if (taken.bends(first.id, place, one.around) || taken.bends(second.id, place, two.around)) continue;
      firstPlan = one;
      secondPlan = two;
      spot = place;
      break;
    }
    if (firstPlan === undefined || secondPlan === undefined) continue;
    taken.record(first.id, spot, firstPlan.around);
    taken.record(second.id, spot, secondPlan.around);
    if (firstPlan.insert !== null) {
      (places[a] as Point[]).push({ x: spot.x, y: spot.y });
      (inserts[a] as Insert[]).push(firstPlan.insert);
    }
    if (secondPlan.insert !== null) {
      (places[b] as Point[]).push({ x: spot.x, y: spot.y });
      (inserts[b] as Insert[]).push(secondPlan.insert);
    }
  }

  if (inserts.every((list) => list.length === 0)) return undefined;
  return roads.map((road, i) => splice(road, inserts[i] as Insert[]));
}

/** How a curve takes a point at a place, and the places beside it the curve runs on to. */
interface Planned {
  /** The point to splice in, or `null` where the curve stands there already. */
  insert: Insert | null;
  around: Point[];
}

/**
 * How a curve takes a point at a place, and nothing where the ground refuses
 * the two halves the point would cut the segment into.
 *
 * The point goes into the segment the crossing was found on, at the place along
 * it nearest the point: a snapped place can stand a little off that segment.
 */
function plan(
  road: RoadCurve,
  segment: number,
  spot: Point,
  places: readonly Point[],
  inserts: readonly Insert[],
  canRun: CanRun,
): Planned | undefined {
  const a = road.points[segment] as Point;
  const b = road.points[segment + 1] as Point;
  for (const place of places) {
    if (Math.abs(place.x - spot.x) > SAME_PLACE || Math.abs(place.y - spot.y) > SAME_PLACE) continue;
    const i = road.points.findIndex((p) => Math.abs(p.x - spot.x) <= SAME_PLACE && Math.abs(p.y - spot.y) <= SAME_PLACE);
    const around = i < 0 ? [a, b] : [road.points[i - 1], road.points[i + 1]].filter((p): p is Point => p !== undefined);
    return { insert: null, around };
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const span = dx * dx + dy * dy;
  const at = span === 0 ? 0 : Math.min(1, Math.max(0, ((spot.x - a.x) * dx + (spot.y - a.y) * dy) / span));
  // The two halves the point cuts the run into. Another crossing may already
  // have put a point on this segment, so the halves are measured against the
  // points beside this one rather than the segment's own ends.
  let before = { at: 0, point: a };
  let after = { at: 1, point: b };
  for (const other of inserts) {
    if (other.segment !== segment) continue;
    const place = { x: other.x, y: other.y };
    if (other.at <= at && other.at >= before.at) before = { at: other.at, point: place };
    if (other.at > at && other.at <= after.at) after = { at: other.at, point: place };
  }
  if (!canRun(before.point, spot, road.tier) || !canRun(spot, after.point, road.tier)) return undefined;
  return { insert: { segment, at, x: spot.x, y: spot.y }, around: [before.point, after.point] };
}

/**
 * True when two roads leave a place along lines closer than {@link MIN_MEET}:
 * there each lies in the other's carriageway, which no junction can be built on.
 */
export function shallow(at: Point, first: readonly Point[], second: readonly Point[]): boolean {
  for (const p of first) {
    for (const q of second) {
      if (Math.hypot(p.x - at.x, p.y - at.y) <= SAME_PLACE || Math.hypot(q.x - at.x, q.y - at.y) <= SAME_PLACE) continue;
      let turn = Math.abs(Math.atan2(p.y - at.y, p.x - at.x) - Math.atan2(q.y - at.y, q.x - at.x)) % (2 * Math.PI);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn < MIN_MEET) return true;
    }
  }
  return false;
}

/** True when two lists of places share one within `reach` of a point. */
function meetsNear(first: readonly Point[], second: readonly Point[], at: Point, reach: number): boolean {
  for (const p of first) {
    if (Math.hypot(p.x - at.x, p.y - at.y) >= reach) continue;
    for (const q of second) {
      if (Math.abs(p.x - q.x) <= SAME_PLACE && Math.abs(p.y - q.y) <= SAME_PLACE) return true;
    }
  }
  return false;
}

/** Whichever of two candidate places stands nearer a point. */
function nearer(first: Point | undefined, second: Point | undefined, to: Point): Point | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Math.hypot(second.x - to.x, second.y - to.y) < Math.hypot(first.x - to.x, first.y - to.y) ? second : first;
}

/** The place in a list nearest to a point, within {@link CROSSING_SNAP} of it. */
function nearestPlace(places: readonly Point[], to: Point): Point | undefined {
  let best: Point | undefined;
  let bestD = CROSSING_SNAP;
  for (const place of places) {
    const d = Math.hypot(place.x - to.x, place.y - to.y);
    if (d > bestD) continue;
    bestD = d;
    best = place;
  }
  return best;
}

/**
 * One curve with its points spliced in. The indices in `bridges`, `tunnels` and
 * `interchanges` all move with them, since every one of them counts segments or
 * points from the start of the curve.
 */
function splice(road: RoadCurve, inserts: readonly Insert[]): RoadCurve {
  if (inserts.length === 0) return road;
  const sorted = [...inserts].sort((m, n) => compareNumbers(m.segment, n.segment) || compareNumbers(m.at, n.at));
  const points: Point[] = [];
  /** How many points have been spliced in before each of the curve's own. */
  const shift: number[] = [];
  /** The lift of a highway at each point, a spliced point taking the height of its segment there. */
  const lift: number[] = [];
  let next = 0;
  for (let i = 0; i < road.points.length; i++) {
    shift[i] = points.length - i;
    const here = road.points[i] as Point;
    points.push(here);
    lift.push(road.lift?.[i] ?? 0);
    while (next < sorted.length && (sorted[next] as Insert).segment === i) {
      const insert = sorted[next++] as Insert;
      const last = points[points.length - 1] as Point;
      // A point on top of the one before it is no point at all, and a segment
      // of no length has no direction for the frame of a road to follow.
      if (Math.hypot(insert.x - last.x, insert.y - last.y) <= SAME_PLACE) continue;
      points.push({ x: insert.x, y: insert.y });
      const ahead = road.points[i + 1] ?? here;
      const span = Math.hypot(ahead.x - here.x, ahead.y - here.y);
      const t = span === 0 ? 0 : Math.hypot(insert.x - here.x, insert.y - here.y) / span;
      lift.push((road.lift?.[i] ?? 0) * (1 - t) + (road.lift?.[i + 1] ?? 0) * t);
    }
  }
  const spread = (segments: readonly number[]): number[] => {
    const out: number[] = [];
    for (const at of segments) {
      const end = at + 1 < road.points.length ? at + 1 + (shift[at + 1] as number) : points.length - 1;
      for (let k = at + (shift[at] ?? 0); k < end; k++) out.push(k);
    }
    return out;
  };
  const cut: RoadCurve = {
    ...road,
    points,
    bridges: spread(road.bridges),
    tunnels: spread(road.tunnels),
    interchanges: road.interchanges.map((at) => at + (shift[at] ?? 0)),
  };
  if (road.slots !== undefined) cut.slots = spread(road.slots);
  if (road.lift !== undefined) cut.lift = lift;
  return cut;
}

/**
 * The places the network already has points at, and what tier stands on each.
 * A road bent onto one of them meets whatever else is there, so a place a tier
 * may not junction at is no place to bend it to (spec section 6.2).
 */
class Taken {
  private readonly tiers = new Map<number, RoadTier[]>();
  private readonly interchanges = new Map<number, boolean>();
  /** The curves at each place, and the points beside it each of them runs on to. */
  private readonly beside = new Map<number, { curve: number; to: Point }[]>();

  constructor(roads: readonly RoadCurve[]) {
    for (const road of roads) {
      for (let i = 0; i < road.points.length; i++) {
        const key = placeKey(road.points[i] as Point);
        const here = this.tiers.get(key);
        if (here === undefined) this.tiers.set(key, [road.tier]);
        else here.push(road.tier);
        if (road.interchanges.includes(i)) this.interchanges.set(key, true);
        const next = this.beside.get(key) ?? [];
        for (const to of [road.points[i - 1], road.points[i + 1]]) if (to !== undefined) next.push({ curve: road.id, to });
        this.beside.set(key, next);
      }
    }
  }

  /**
   * True when a curve given a point at `spot` would leave one of the places
   * beside it along the line of another road that meets it there.
   */
  bends(curve: number, spot: Point, around: readonly Point[]): boolean {
    if (shallow(spot, around, this.othersAt(spot, curve))) return true;
    for (const place of around) {
      if (shallow(place, [spot], this.othersAt(place, curve))) return true;
    }
    return false;
  }

  /** A curve takes a point at `spot`, running on to `around` from it. */
  record(curve: number, spot: Point, around: readonly Point[]): void {
    const key = placeKey(spot);
    const here = this.beside.get(key) ?? [];
    for (const to of around) here.push({ curve, to });
    this.beside.set(key, here);
    for (const place of around) {
      const there = this.beside.get(placeKey(place)) ?? [];
      there.push({ curve, to: spot });
      this.beside.set(placeKey(place), there);
    }
  }

  /** The points the curves other than one run on to from a place. */
  private othersAt(place: Point, curve: number): Point[] {
    return (this.beside.get(placeKey(place)) ?? []).filter((b) => b.curve !== curve).map((b) => b.to);
  }

  /** True where a road of this tier may not take a point at a place. */
  refuses(at: Point, joiner: RoadTier): boolean {
    const key = placeKey(at);
    const here = this.tiers.get(key);
    if (here === undefined) return false;
    const interchange = this.interchanges.get(key) === true;
    for (const tier of here) if (!mayJoin(joiner, tier, interchange)) return true;
    return false;
  }
}

/** A place as one number, to the millimetre, so two roads agree on what one place is. */
function placeKey(p: Point): number {
  const x = Math.round(p.x * KEY_SCALE) + KEY_OFFSET;
  const y = Math.round(p.y * KEY_SCALE) + KEY_OFFSET;
  return y * KEY_SPAN + x;
}

/**
 * Every place two curves cross where a junction is allowed, one entry per
 * crossing, in an order that does not depend on how the buckets were walked.
 */
function crossingsOf(roads: readonly RoadCurve[]): Meeting[] {
  const segments = new SegmentIndex(roads);
  const out: Meeting[] = [];
  segments.eachPair((s, t) => {
    // A crossing never stands on an interchange, so a highway crossing any
    // other road stays a crossing: spec section 6.2 allows it no junction.
    if (!mayJoin(segments.tierOf(s), segments.tierOf(t), false)) return;
    if (!mayJoin(segments.tierOf(t), segments.tierOf(s), false)) return;
    const at = crossPoint(segments.head(s), segments.tail(s), segments.head(t), segments.tail(t));
    if (at === undefined) return;
    const first = segments.curveOf(s);
    const second = segments.curveOf(t);
    out.push({
      curve: first,
      segment: segments.indexOf(s),
      other: second,
      otherSegment: segments.indexOf(t),
      x: at.x,
      y: at.y,
    });
  });
  out.sort(
    (m, n) =>
      compareNumbers(m.curve, n.curve) ||
      compareNumbers(m.segment, n.segment) ||
      compareNumbers(m.other, n.other) ||
      compareNumbers(m.otherSegment, n.otherSegment),
  );
  return out;
}

/**
 * Where two segments cross, or nothing. A crossing at an end of either segment
 * is no crossing: the two roads already share that point, or they meet at the
 * next segment along.
 */
function crossPoint(a: Point, b: Point, c: Point, d: Point): Point | undefined {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (denominator === 0) return undefined;
  const ox = c.x - a.x;
  const oy = c.y - a.y;
  const t = (ox * sy - oy * sx) / denominator;
  const u = (ox * ry - oy * rx) / denominator;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return undefined;
  return { x: a.x + rx * t, y: a.y + ry * t };
}

/**
 * The segments of the whole network in a grid of buckets, so the crossings are
 * found in one walk rather than by comparing every pair. Only segments on the
 * ground whose tiers may junction are in it, so a deck, a bore and a highway
 * are never offered as a pair.
 */
class SegmentIndex {
  private readonly points: Point[] = [];
  private readonly curve: number[] = [];
  private readonly index: number[] = [];
  private readonly tier: RoadTier[] = [];
  private readonly cell = INDEX_CELL;
  private readonly buckets: number[][] = [];
  private readonly nx: number;
  private readonly ny: number;
  private readonly originX: number;
  private readonly originY: number;

  constructor(roads: readonly RoadCurve[]) {
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    for (const road of roads) {
      // A deck and a bore are not on the ground, so nothing crosses them there.
      const off = new Uint8Array(Math.max(0, road.points.length - 1));
      for (const at of road.bridges) if (at >= 0 && at < off.length) off[at] = 1;
      for (const at of road.tunnels) if (at >= 0 && at < off.length) off[at] = 1;
      for (let i = 0; i + 1 < road.points.length; i++) {
        const a = road.points[i] as Point;
        const b = road.points[i + 1] as Point;
        minX = Math.min(minX, a.x, b.x);
        minY = Math.min(minY, a.y, b.y);
        maxX = Math.max(maxX, a.x, b.x);
        maxY = Math.max(maxY, a.y, b.y);
        if (off[i] === 1) continue;
        this.points.push(a, b);
        this.curve.push(road.id);
        this.index.push(i);
        this.tier.push(road.tier);
      }
    }
    this.originX = minX - this.cell;
    this.originY = minY - this.cell;
    this.nx = Math.max(1, Math.ceil((maxX - this.originX) / this.cell) + 2);
    this.ny = Math.max(1, Math.ceil((maxY - this.originY) / this.cell) + 2);
    for (let i = 0; i < this.nx * this.ny; i++) this.buckets.push([]);
    for (let s = 0; s < this.curve.length; s++) {
      const a = this.head(s);
      const b = this.tail(s);
      this.fileIn(s, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
    }
  }

  head(s: number): Point {
    return this.points[s * 2] as Point;
  }

  tail(s: number): Point {
    return this.points[s * 2 + 1] as Point;
  }

  curveOf(s: number): number {
    return this.curve[s] as number;
  }

  indexOf(s: number): number {
    return this.index[s] as number;
  }

  tierOf(s: number): RoadTier {
    return this.tier[s] as RoadTier;
  }

  /** Every pair of segments of two different curves that share a bucket, once each. */
  eachPair(visit: (s: number, t: number) => void): void {
    const seen = new Int32Array(this.curve.length).fill(-1);
    for (let s = 0; s < this.curve.length; s++) {
      const a = this.head(s);
      const b = this.tail(s);
      const x0 = this.column(Math.min(a.x, b.x), this.originX, this.nx);
      const x1 = this.column(Math.max(a.x, b.x), this.originX, this.nx);
      const y0 = this.column(Math.min(a.y, b.y), this.originY, this.ny);
      const y1 = this.column(Math.max(a.y, b.y), this.originY, this.ny);
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) {
          for (const t of this.buckets[iy * this.nx + ix] as number[]) {
            if (t <= s || this.curve[t] === this.curve[s]) continue;
            // A pair whose boxes cover several buckets is offered once for each
            // of them, and the same crossing must not be found twice.
            if (seen[t] === s) continue;
            seen[t] = s;
            visit(s, t);
          }
        }
      }
    }
  }

  private column(v: number, origin: number, count: number): number {
    const i = Math.floor((v - origin) / this.cell);
    return i < 0 ? 0 : i >= count ? count - 1 : i;
  }

  private fileIn(id: number, minX: number, minY: number, maxX: number, maxY: number): void {
    const x0 = this.column(minX, this.originX, this.nx);
    const x1 = this.column(maxX, this.originX, this.nx);
    const y0 = this.column(minY, this.originY, this.ny);
    const y1 = this.column(maxY, this.originY, this.ny);
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const bucket = this.buckets[iy * this.nx + ix] as number[];
        if (bucket[bucket.length - 1] !== id) bucket.push(id);
      }
    }
  }
}
