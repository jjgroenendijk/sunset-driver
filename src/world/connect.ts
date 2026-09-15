/**
 * Where two roads cross on the ground, they meet (spec section 6.2).
 *
 * The tracer ends a road on another one at a point of it, and the network makes
 * that point a node both curves carry (`road-network.ts`). It only ever looks at
 * points, so a road that crosses another one between its points meets nothing:
 * the two are laid over each other, the graph calls the place an overpass, and
 * both draw a full carriageway on the same ground.
 *
 * This pass is the other half of that rule. It runs once the whole network is
 * traced, finds every place two curves cross, and splits both edges there into
 * one node. The graph reads the node from `RoadCurve.nodes` and `junctions.ts`
 * builds the junction, so nothing downstream needs to know a crossing was ever
 * there. Which roads already meet at a place is read from the nodes, never from
 * where their points stand.
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
import { MIN_MEET } from './network-clearance.ts';
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

/** A place two curves are to meet, and the segment of each that carries it. */
interface Meeting {
  curve: number;
  segment: number;
  other: number;
  otherSegment: number;
  x: number;
  y: number;
}

/**
 * A place on a curve: one of its own points, or a point the pass gives it. The
 * node it stands on is `node`, or -1 until the pass needs to name the place.
 * Two places of two curves are the same place exactly where they carry the same
 * node.
 */
interface Place {
  x: number;
  y: number;
  /** The curve the place is on, or -1 for a crossing no curve has a point at yet. */
  curve: number;
  /** The index among the curve's own points, or -1 for a point the pass gives it. */
  index: number;
  /** The segment of the curve a given point goes into, and how far along it, from 0 to 1. */
  segment: number;
  at: number;
  node: number;
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
 * Every curve again, with a node wherever two of them cross on the ground. A
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

  const taken = new Taken(roads);
  const inserts: Place[][] = roads.map(() => []);
  // The places each curve will have once the pass is applied: its own points
  // and everything already given to it, so a second crossing beside the first
  // takes the same point rather than one of its own.
  const places: Place[][] = roads.map((road) =>
    road.points.map((p, i) => ({ x: p.x, y: p.y, curve: road.id, index: i, segment: i, at: 0, node: road.nodes[i] ?? -1 })),
  );
  const order: number[] = [];
  for (let i = 0; i < roads.length; i++) order[roads[i]?.id ?? i] = i;

  const ends = new FreeEnds(roads);
  for (const meeting of meetings) {
    const a = order[meeting.curve] as number;
    const b = order[meeting.other] as number;
    const first = roads[a] as RoadCurve;
    const second = roads[b] as RoadCurve;
    const here: Place = { x: meeting.x, y: meeting.y, curve: -1, index: -1, segment: -1, at: 0, node: -1 };
    // The nearest point either road already has, so the roads are bent as
    // little as the places they stand on allow. A tie goes to the curve laid
    // first, so the answer does not depend on which segment was walked first.
    // Two roads that already meet here meet once: a second point a few metres
    // from the first cuts a sliver of road that lies along the other one.
    if (meetsNear(taken, places[a] as Place[], places[b] as Place[], here, footprintHalfWidth(first.tier) + footprintHalfWidth(second.tier))) continue;
    const snapped = nearer(nearestPlace(places[a] as Place[], here), nearestPlace(places[b] as Place[], here), here);
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
      const one = plan(taken, first, meeting.segment, place, places[a] as Place[], inserts[a] as Place[], canRun);
      const two = plan(taken, second, meeting.otherSegment, place, places[b] as Place[], inserts[b] as Place[], canRun);
      // Both roads take the point or neither does: one of them bent to a place
      // the other never reaches is a bend for nothing.
      if (one === undefined || two === undefined || shallow(place, one.around, two.around)) continue;
      // The point also turns each road where it leaves the places beside it,
      // and a road may already meet a third one there.
      if (taken.bends(first.id, place, one.around) || taken.bends(second.id, place, two.around)) continue;
      // A snapped place moves a road, and the carriageway it moves onto may hold
      // the free end of a third road that stood clear of it.
      if ((one.insert !== null && ends.buried(first, place, one.around)) || (two.insert !== null && ends.buried(second, place, two.around))) continue;
      firstPlan = one;
      secondPlan = two;
      spot = place;
      break;
    }
    if (firstPlan === undefined || secondPlan === undefined) continue;
    for (const planned of [firstPlan, secondPlan]) {
      if (planned.same !== undefined && planned.same.node >= 0 && spot.node < 0) spot.node = taken.find(planned.same.node);
    }
    const node = taken.name(spot);
    for (const planned of [firstPlan, secondPlan]) if (planned.same !== undefined) taken.adopt(planned.same, node);
    taken.record(first.id, spot, firstPlan.around);
    taken.record(second.id, spot, secondPlan.around);
    for (const [plan, k, curve] of [[firstPlan, a, first.id], [secondPlan, b, second.id]] as const) {
      if (plan.insert === null) continue;
      const given: Place = { ...plan.insert, curve, node };
      (places[k] as Place[]).push(given);
      (inserts[k] as Place[]).push(given);
    }
  }

  if (inserts.every((list) => list.length === 0)) return undefined;
  const meets = curvesByNode(taken, places);
  return roads.map((road, i) => splice(taken, road, places[i] as Place[], inserts[i] as Place[], meets));
}

/** How a curve takes a point at a place, and the places beside it the curve runs on to. */
interface Planned {
  /** The point to splice in, or `null` where the curve stands there already. */
  insert: Place | null;
  around: Place[];
  /** The place the curve already has there, where it has one. */
  same?: Place;
}

/**
 * How a curve takes a point at a place, and nothing where the ground refuses
 * the two halves the point would cut the segment into.
 *
 * The point goes into the segment the crossing was found on, at the place along
 * it nearest the point: a snapped place can stand a little off that segment.
 */
function plan(
  taken: Taken,
  road: RoadCurve,
  segment: number,
  spot: Place,
  places: readonly Place[],
  inserts: readonly Place[],
  canRun: CanRun,
): Planned | undefined {
  const a = places[segment] as Place;
  const b = places[segment + 1] as Place;
  // A crossing can fall on a point the curve has, to the rounding, without
  // being a node of it yet; the curve takes the node there instead of a point.
  const same = places.find(
    (place) =>
      place === spot ||
      (place.node >= 0 && spot.node >= 0 && taken.find(place.node) === taken.find(spot.node)) ||
      (Math.abs(place.x - spot.x) <= SAME_PLACE && Math.abs(place.y - spot.y) <= SAME_PLACE),
  );
  if (same !== undefined) {
    const around = same.index < 0 ? [a, b] : [places[same.index - 1], places[same.index + 1]].filter((p): p is Place => p !== undefined);
    return { insert: null, around, same };
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const span = dx * dx + dy * dy;
  const at = span === 0 ? 0 : Math.min(1, Math.max(0, ((spot.x - a.x) * dx + (spot.y - a.y) * dy) / span));
  // The two halves the point cuts the run into. Another crossing may already
  // have put a point on this segment, so the halves are measured against the
  // points beside this one rather than the segment's own ends.
  let before = { at: 0, place: a };
  let after = { at: 1, place: b };
  for (const other of inserts) {
    if (other.segment !== segment) continue;
    if (other.at <= at && other.at >= before.at) before = { at: other.at, place: other };
    if (other.at > at && other.at <= after.at) after = { at: other.at, place: other };
  }
  if (!canRun(before.place, spot, road.tier) || !canRun(spot, after.place, road.tier)) return undefined;
  return { insert: { x: spot.x, y: spot.y, curve: road.id, index: -1, segment, at, node: -1 }, around: [before.place, after.place] };
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

/** True when two curves already share a node within `reach` of a point. */
function meetsNear(taken: Taken, first: readonly Place[], second: readonly Place[], at: Point, reach: number): boolean {
  for (const p of first) {
    if (p.node < 0 || Math.hypot(p.x - at.x, p.y - at.y) >= reach) continue;
    const node = taken.find(p.node);
    if (second.some((q) => q.node >= 0 && taken.find(q.node) === node)) return true;
  }
  return false;
}

/** Whichever of two candidate places stands nearer a point. */
function nearer(first: Place | undefined, second: Place | undefined, to: Point): Place | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Math.hypot(second.x - to.x, second.y - to.y) < Math.hypot(first.x - to.x, first.y - to.y) ? second : first;
}

/** The place in a list nearest to a point, within {@link CROSSING_SNAP} of it. */
function nearestPlace(places: readonly Place[], to: Point): Place | undefined {
  let best: Place | undefined;
  let bestD = CROSSING_SNAP;
  for (const place of places) {
    const d = Math.hypot(place.x - to.x, place.y - to.y);
    if (d > bestD) continue;
    bestD = d;
    best = place;
  }
  return best;
}

/** The curves that carry each node once the pass is applied, by node. */
function curvesByNode(taken: Taken, places: readonly (readonly Place[])[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const list of places) {
    for (const place of list) {
      if (place.node < 0) continue;
      const node = taken.find(place.node);
      const curves = out.get(node) ?? [];
      if (!curves.includes(place.curve)) curves.push(place.curve);
      out.set(node, curves);
    }
  }
  return out;
}

/**
 * One curve with its points spliced in. The indices in `bridges`, `tunnels` and
 * `interchanges` all move with them, since every one of them counts segments or
 * points from the start of the curve. A place the pass named keeps its node
 * only where another curve carries that node too: a name no road met is no
 * junction.
 */
function splice(taken: Taken, road: RoadCurve, places: readonly Place[], inserts: readonly Place[], meets: Map<number, number[]>): RoadCurve {
  const shared = (node: number): number => (node >= 0 && (meets.get(taken.find(node))?.length ?? 0) > 1 ? taken.find(node) : -1);
  // A point of the curve may have been named onto a node another curve took,
  // even where the curve takes no point of its own.
  const named = road.nodes.map((own, i) => (own >= 0 ? own : shared((places[i] as Place).node)));
  if (inserts.length === 0) return named.every((node, i) => node === road.nodes[i]) ? road : { ...road, nodes: named };
  const sorted = [...inserts].sort((m, n) => compareNumbers(m.segment, n.segment) || compareNumbers(m.at, n.at));
  const points: Point[] = [];
  const nodes: number[] = [];
  /** How many points have been spliced in before each of the curve's own. */
  const shift: number[] = [];
  /** The lift of a highway at each point, a spliced point taking the height of its segment there. */
  const lift: number[] = [];
  let next = 0;
  for (let i = 0; i < road.points.length; i++) {
    shift[i] = points.length - i;
    const here = road.points[i] as Point;
    points.push(here);
    nodes.push(named[i] as number);
    lift.push(road.lift?.[i] ?? 0);
    while (next < sorted.length && (sorted[next] as Place).segment === i) {
      const insert = sorted[next++] as Place;
      const last = points[points.length - 1] as Point;
      // A point on top of the one before it is no point at all, and a segment
      // of no length has no direction for the frame of a road to follow. The
      // point before it takes the node instead, where it has none of its own.
      if (Math.hypot(insert.x - last.x, insert.y - last.y) <= SAME_PLACE) {
        if (nodes[nodes.length - 1] === -1) nodes[nodes.length - 1] = shared(insert.node);
        continue;
      }
      points.push({ x: insert.x, y: insert.y });
      nodes.push(shared(insert.node));
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
    nodes,
    bridges: spread(road.bridges),
    tunnels: spread(road.tunnels),
    interchanges: road.interchanges.map((at) => at + (shift[at] ?? 0)),
  };
  if (road.slots !== undefined) cut.slots = spread(road.slots);
  if (road.lift !== undefined) cut.lift = lift;
  return cut;
}

/**
 * The nodes the network already has, what tier stands on each, and the points
 * beside each node its curves run on to. A road bent onto a node meets whatever
 * else is there, so a node a tier may not junction at is no place to bend it to
 * (spec section 6.2).
 *
 * A place that is no node yet gets one here when the pass first needs to name
 * it, with the one curve it stands on; it becomes a junction only once a second
 * curve takes it.
 */
class Taken {
  /** The curves by id. */
  private readonly roads: RoadCurve[] = [];
  private readonly tiers = new Map<number, RoadTier[]>();
  private readonly interchanges = new Map<number, boolean>();
  /** The curves at each node, and the points beside it each of them runs on to. */
  private readonly beside = new Map<number, { curve: number; to: Point }[]>();
  /** The node each node named in this round was merged into, where two names turned out to be one place. */
  private readonly merged = new Map<number, number>();
  private nextNode = 0;

  constructor(roads: readonly RoadCurve[]) {
    for (const road of roads) this.roads[road.id] = road;
    for (const road of roads) {
      for (let i = 0; i < road.points.length; i++) {
        const node = road.nodes[i] ?? -1;
        this.nextNode = Math.max(this.nextNode, node + 1);
        if (node >= 0) this.own(road, i, node);
      }
    }
  }

  /** The node a node was merged into, or the node itself. */
  find(node: number): number {
    let at = node;
    for (let up = this.merged.get(at); up !== undefined; up = this.merged.get(at)) at = up;
    return at;
  }

  /** The node a place stands on, named first where it has none. */
  name(place: Place): number {
    if (place.node >= 0) return this.find(place.node);
    place.node = this.nextNode++;
    const road = this.roads[place.curve];
    if (road !== undefined && place.index >= 0) this.own(road, place.index, place.node);
    return place.node;
  }

  /** A place of a curve takes a node another place was named with, where it has none of its own. */
  adopt(place: Place, node: number): void {
    if (place.node >= 0) {
      this.merge(this.find(place.node), this.find(node));
      return;
    }
    place.node = this.find(node);
    const road = this.roads[place.curve];
    if (road !== undefined && place.index >= 0) this.own(road, place.index, place.node);
  }

  /**
   * True when a curve given a point at `spot` would leave one of the places
   * beside it along the line of another road that meets it there.
   */
  bends(curve: number, spot: Place, around: readonly Place[]): boolean {
    if (shallow(spot, around, this.othersAt(spot, curve))) return true;
    for (const place of around) {
      if (shallow(place, [spot], this.othersAt(place, curve))) return true;
    }
    return false;
  }

  /** A curve takes a point at `spot`, running on to `around` from it. */
  record(curve: number, spot: Place, around: readonly Place[]): void {
    const here = this.besideOf(this.name(spot));
    for (const to of around) here.push({ curve, to });
    for (const place of around) this.besideOf(this.name(place)).push({ curve, to: spot });
  }

  /** True where a road of this tier may not take a point at a place. */
  refuses(at: Place, joiner: RoadTier): boolean {
    if (at.node < 0) {
      // A point no node stands on yet carries only its own curve.
      const road = at.index < 0 ? undefined : this.roads[at.curve];
      return road !== undefined && !mayJoin(joiner, road.tier, road.interchanges.includes(at.index));
    }
    const node = this.find(at.node);
    const here = this.tiers.get(node);
    if (here === undefined) return false;
    const interchange = this.interchanges.get(node) === true;
    for (const tier of here) if (!mayJoin(joiner, tier, interchange)) return true;
    return false;
  }

  /** Two names of one place become one node: the later name is merged into the earlier. */
  private merge(a: number, b: number): void {
    if (a === b) return;
    const [keep, gone] = a < b ? [a, b] : [b, a];
    this.merged.set(gone, keep);
    const tiers = this.tiers.get(gone);
    if (tiers !== undefined) this.tiers.set(keep, [...(this.tiers.get(keep) ?? []), ...tiers]);
    if (this.interchanges.get(gone) === true) this.interchanges.set(keep, true);
    this.besideOf(keep).push(...(this.beside.get(gone) ?? []));
  }

  /** File the point of a curve at `index` under the node it stands on. */
  private own(road: RoadCurve, index: number, node: number): void {
    const here = this.tiers.get(node);
    if (here === undefined) this.tiers.set(node, [road.tier]);
    else here.push(road.tier);
    if (road.interchanges.includes(index)) this.interchanges.set(node, true);
    const list = this.besideOf(node);
    for (const to of [road.points[index - 1], road.points[index + 1]]) if (to !== undefined) list.push({ curve: road.id, to });
  }

  private besideOf(node: number): { curve: number; to: Point }[] {
    const known = this.beside.get(node);
    if (known !== undefined) return known;
    const list: { curve: number; to: Point }[] = [];
    this.beside.set(node, list);
    return list;
  }

  /** The points the curves other than one run on to from a place. */
  private othersAt(place: Place, curve: number): Point[] {
    if (place.node < 0) {
      // A point no node stands on yet runs on to the points of its own curve alone.
      const road = this.roads[place.curve];
      if (road === undefined || place.index < 0 || place.curve === curve) return [];
      return [road.points[place.index - 1], road.points[place.index + 1]].filter((p): p is Point => p !== undefined);
    }
    return (this.beside.get(this.find(place.node)) ?? []).filter((b) => b.curve !== curve).map((b) => b.to);
  }
}

/**
 * The ends of roads that meet nothing there, filed in buckets. A road that
 * takes a point is bent onto it, and a free end its carriageway then covers
 * would stand inside a road it does not meet.
 */
export class FreeEnds {
  private readonly buckets = new Map<number, { curve: number; at: Point }[]>();

  constructor(roads: readonly RoadCurve[]) {
    const count = new Map<number, number>();
    for (const road of roads) {
      for (const node of road.nodes) if (node >= 0) count.set(node, (count.get(node) ?? 0) + 1);
    }
    for (const road of roads) {
      const last = road.points.length - 1;
      for (const i of last === 0 ? [0] : [0, last]) {
        const at = road.points[i];
        const node = road.nodes[i] ?? -1;
        if (at === undefined || (node >= 0 && count.get(node) !== 1)) continue;
        const key = bucketKey(Math.floor(at.x / INDEX_CELL), Math.floor(at.y / INDEX_CELL));
        const list = this.buckets.get(key) ?? [];
        list.push({ curve: road.id, at });
        this.buckets.set(key, list);
      }
    }
  }

  /**
   * True when `road`, given a point at `spot` and running on from it to
   * `around`, covers a free end of another road with its carriageway that the
   * straight run between the two places beside it left clear.
   */
  buried(road: RoadCurve, spot: Point, around: readonly Point[]): boolean {
    const half = footprintHalfWidth(road.tier);
    let reach = half;
    for (const p of around) reach = Math.max(reach, Math.hypot(p.x - spot.x, p.y - spot.y) + half);
    for (let cy = Math.floor((spot.y - reach) / INDEX_CELL); cy <= Math.floor((spot.y + reach) / INDEX_CELL); cy++) {
      for (let cx = Math.floor((spot.x - reach) / INDEX_CELL); cx <= Math.floor((spot.x + reach) / INDEX_CELL); cx++) {
        for (const end of this.buckets.get(bucketKey(cx, cy)) ?? []) {
          if (end.curve === road.id) continue;
          let near = Infinity;
          for (const p of around) near = Math.min(near, toSegment(end.at, spot, p));
          if (near >= half) continue;
          const before = around.length === 2 ? toSegment(end.at, around[0] as Point, around[1] as Point) : Infinity;
          if (before >= half) return true;
        }
      }
    }
    return false;
  }
}

/** Half the span of a bucket key, in buckets. */
const KEY_OFFSET = 8_000_000;
const KEY_SPAN = 2 * KEY_OFFSET + 1;

/** A key for one bucket of {@link FreeEnds}. */
function bucketKey(cx: number, cy: number): number {
  return (cy + KEY_OFFSET) * KEY_SPAN + (cx + KEY_OFFSET);
}

/** Metres from a point to a segment. */
function toSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const span = dx * dx + dy * dy;
  const t = span === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / span));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
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
export function crossPoint(a: Point, b: Point, c: Point, d: Point): Point | undefined {
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
