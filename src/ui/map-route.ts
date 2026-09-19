/**
 * The route to the waypoint of spec section 12: the roads a driver follows
 * from where the player stands to the place they marked.
 *
 * It is the fastest route over the road graph of spec section 6.5, found by
 * `RoadGraph.shortestPath`. Neither end is on a node, so each end is joined to
 * the nearest point of the network, and the route runs along the part of that
 * edge up to the node it leaves by. The walk from the player to the road and
 * from the road to the mark is kept apart, so the map can draw it as a dashed
 * line: it is the part that is not a road.
 *
 * Everything here is pure, so a route is tested headless. `Navigator` is the
 * part a session holds: it keeps the last route and finds a new one only when
 * the mark moves or the player has left the road it runs along.
 */
import type { Point } from '../world/types.ts';
import type { EdgeHit, RoadEdge, RoadGraph } from '../world/graph.ts';

/** A route drawn on the map. */
export interface MapRoute {
  /** From the player to the road. Two points. */
  lead: Point[];
  /** Along the roads, from the first road point to the last. */
  road: Point[];
  /** From the road to the mark. Two points. */
  tail: Point[];
  /** Metres from the player to the mark, the lead and the tail included. */
  length: number;
  /** Seconds at the speed limits, the lead and the tail left out. */
  time: number;
}

/**
 * Metres the player may stray from the route before a new one is found. A lane
 * change or a pavement is less than this; a turn down another street is more.
 */
const OFF_ROUTE = 28;

/** Metres the player moves before the part of the route behind them is cut off. */
const CUT_STEP = 2;

/** Metres an off-route player moves before a new route is found. */
const REROUTE_STEP = 8;

/** Metres from the mark at which the player has arrived and the mark is taken away. */
export const ARRIVED = 18;

/**
 * The fastest road route from `from` to `to`, or a straight line where the two
 * are not joined by road: on two islands no bridge links, or in a world with no
 * roads at all.
 */
export function findRoute(graph: RoadGraph, from: Point, to: Point): MapRoute {
  const a = graph.nearestEdge(from.x, from.y);
  const b = graph.nearestEdge(to.x, to.y);
  const straight = Math.hypot(to.x - from.x, to.y - from.y);
  // A route with no road in it is all lead: the map dashes it, since it is no road.
  const direct: MapRoute = { lead: [from, to], road: [], tail: [], length: straight, time: 0 };
  if (a === undefined || b === undefined) return direct;
  // The whole drive is cheaper on foot than the walk to and from the roads.
  if (straight <= a.distance + b.distance) return direct;

  const lead = [from, { x: a.x, y: a.y }];
  const tail = [{ x: b.x, y: b.y }, to];
  const aEdge = graph.edges[a.edge] as RoadEdge;
  const bEdge = graph.edges[b.edge] as RoadEdge;

  // Both marks on one run of road: drive along it, no junction in between.
  if (a.edge === b.edge || a.edge === bEdge.twin) {
    const points = graph.edgePoints(a.edge);
    const road = between(points, a, b);
    const length = pathLength(road);
    return { lead, road, tail, length: length + a.distance + b.distance, time: length / aEdge.speedLimit };
  }

  // Leave the first run by either end, and join the last by either end. Of the
  // four, the one with the least time wins; ties go to the first tried, so the
  // answer never depends on the order of anything but this list.
  let best: { road: Point[]; time: number; length: number } | undefined;
  const aPoints = graph.edgePoints(a.edge);
  const bPoints = graph.edgePoints(b.edge);
  const aSplit = splitAt(aPoints, a);
  const bSplit = splitAt(bPoints, b);
  for (const out of [0, 1]) {
    // `out` 0 drives back to the edge's `from` node, 1 on to its `to` node.
    const leave = out === 0 ? aEdge.from : aEdge.to;
    const firstLeg = out === 0 ? [...aSplit.before].reverse() : aSplit.after;
    const firstLength = pathLength(firstLeg);
    for (const into of [0, 1]) {
      // `into` 0 joins at the edge's `from` node, 1 at its `to` node.
      const join = into === 0 ? bEdge.from : bEdge.to;
      const lastLeg = into === 0 ? bSplit.before : [...bSplit.after].reverse();
      const lastLength = pathLength(lastLeg);
      const path = graph.shortestPath(leave, join);
      if (path === undefined) continue;
      const time = path.time + firstLength / aEdge.speedLimit + lastLength / bEdge.speedLimit;
      if (best !== undefined && time >= best.time) continue;
      const road: Point[] = [...firstLeg];
      for (const e of path.edges) append(road, graph.edgePoints(e));
      append(road, lastLeg);
      best = { road, time, length: firstLength + path.length + lastLength };
    }
  }
  if (best === undefined) return direct;
  return {
    lead,
    road: best.road,
    tail,
    length: best.length + a.distance + b.distance,
    time: best.time,
  };
}

/**
 * A run of road cut at the point nearest a hit: the points from its start to
 * that point, and from that point to its end. Both halves hold the cut point.
 */
function splitAt(points: readonly Point[], hit: EdgeHit): { before: Point[]; after: Point[]; at: number } {
  const at = segmentOf(points, hit);
  const cut = { x: hit.x, y: hit.y };
  return {
    before: [...points.slice(0, at + 1), cut],
    after: [cut, ...points.slice(at + 1)],
    at,
  };
}

/** The part of one run of road between two hits on it, in the order from `a` to `b`. */
function between(points: readonly Point[], a: EdgeHit, b: EdgeHit): Point[] {
  const i = segmentOf(points, a);
  const j = segmentOf(points, b);
  const ta = along(points, i, a);
  const tb = along(points, j, b);
  const first = { x: a.x, y: a.y };
  const last = { x: b.x, y: b.y };
  if (i < j || (i === j && ta <= tb)) return [first, ...points.slice(i + 1, j + 1), last];
  return [first, ...points.slice(j + 1, i + 1).reverse(), last];
}

/** The segment of a polyline a point on it lies on: the one nearest it. */
function segmentOf(points: readonly Point[], hit: { x: number; y: number }): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const d = distanceToSegment(hit, points[i] as Point, points[i + 1] as Point);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** How far along segment `i` a point lies, 0 at its start and 1 at its end. */
function along(points: readonly Point[], i: number, p: { x: number; y: number }): number {
  const a = points[i] as Point;
  const b = points[i + 1] as Point;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  return len === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
}

function distanceToSegment(p: { x: number; y: number }, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Add a polyline to the end of another, leaving out a first point the two share. */
function append(into: Point[], points: readonly Point[]): void {
  for (const p of points) {
    const last = into[into.length - 1];
    if (last !== undefined && last.x === p.x && last.y === p.y) continue;
    into.push(p);
  }
}

/** Metres along a polyline. */
export function pathLength(points: readonly Point[]): number {
  let length = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return length;
}

/**
 * The route a session shows, kept from frame to frame. A new one is found when
 * the mark moves or the player strays from the route; in between, the part the
 * player has driven is cut off the front, so the line on the map starts at the
 * car.
 */
export class Navigator {
  private readonly graph: () => RoadGraph;
  private mark: Point | null = null;
  /** The route as it was found, from where the player stood then. */
  private found: MapRoute | null = null;
  /** What is left of it from where the player stands now. */
  private current: MapRoute | null = null;
  /** Where the player stood when `current` was last cut, and when the route was found. */
  private cutAt: Point = { x: Infinity, y: Infinity };
  private foundAt: Point = { x: Infinity, y: Infinity };
  /** Bumped whenever the route changes, so a map knows to redraw. */
  version = 0;

  /** The graph is built on the first route asked for, not when the session starts. */
  constructor(graph: () => RoadGraph) {
    this.graph = graph;
  }

  get route(): MapRoute | null {
    return this.current;
  }

  /** Follow the player toward the mark. Called once a frame. */
  update(player: Point, mark: Point | null): void {
    if (mark === null) {
      if (this.found !== null) this.version++;
      this.mark = null;
      this.found = null;
      this.current = null;
      return;
    }
    const moved = this.mark === null || this.mark.x !== mark.x || this.mark.y !== mark.y;
    if (moved || this.found === null) {
      this.reroute(player, mark);
      return;
    }
    if (Math.hypot(player.x - this.cutAt.x, player.y - this.cutAt.y) < CUT_STEP) return;
    const found = this.found;
    const all = [...found.lead, ...found.road];
    let nearest = 0;
    let off = Infinity;
    for (let i = 0; i + 1 < all.length; i++) {
      const d = distanceToSegment(player, all[i] as Point, all[i + 1] as Point);
      if (d < off) {
        off = d;
        nearest = i;
      }
    }
    if (off > OFF_ROUTE) {
      // Off the route. A new one is found once the player has gone a little
      // further, so a car sliding across a verge does not search every frame.
      if (Math.hypot(player.x - this.foundAt.x, player.y - this.foundAt.y) >= REROUTE_STEP) {
        this.reroute(player, mark);
      }
      return;
    }
    const here = { x: player.x, y: player.y };
    const onLead = found.lead.length > 0 && nearest === 0;
    const lead = onLead ? [here, found.lead[1] as Point] : [];
    const road = onLead ? found.road : [here, ...all.slice(nearest + 1)];
    const length = pathLength(lead) + pathLength(road) + pathLength(found.tail);
    const share = found.length > 0 ? Math.min(1, length / found.length) : 0;
    this.current = { lead, road, tail: found.tail, length, time: found.time * share };
    this.cutAt = here;
    this.version++;
  }

  private reroute(player: Point, mark: Point): void {
    this.mark = { x: mark.x, y: mark.y };
    this.found = findRoute(this.graph(), player, mark);
    this.current = this.found;
    this.foundAt = { x: player.x, y: player.y };
    this.cutAt = this.foundAt;
    this.version++;
  }
}
