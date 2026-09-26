/**
 * Where on the loop the tram calls at each stop (spec section 13.2).
 *
 * The world names a stop by the junction nearest its district
 * (`world/transit/corridors.ts`), and the tram would call on the run that
 * arrives there. Many arterial runs are shorter than a tram, so a platform
 * laid on one reaches back across the junction behind it, into the cross
 * traffic. Here each stop is given a stretch of the loop between two junctions
 * that holds the whole platform, clear of both: before the stop's junction
 * where that fits, else after it, else the nearest stretch that does.
 *
 * `tram-timing.ts` halts the tram there, and `traffic.ts` moves the lanes out
 * of the way of the platform on every run it reaches, so the two agree.
 */
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import { hypot } from '../../core/libm.ts';
import { bendOf } from './tram-motion.ts';
import type { Point, TramStop } from '../../world/types.ts';

/** Metres the front of a platform keeps short of the next junction: its mouth, and a turning car's swing. */
export const PLATFORM_AHEAD = 16;
/** Metres the tail of a platform keeps clear of the junction behind it: a bus swinging out of it is 12 m long. */
export const PLATFORM_BEHIND = 16;
/**
 * Metres from its junction a stop may be moved to find a stretch that holds
 * it. Downtown the blocks are shorter than a tram, so a stop there walks to
 * the nearest longer one.
 */
const STOP_SEARCH = 500;
/** Metres a platform may stand off the straight line between its ends: the track under it is near enough straight. */
const STRAIGHT = 0.25;
/** Radians the loop turns through at a node for the node to count as a corner. */
const CORNER = 0.35;
/** Metres a platform is slid at a time along its stretch to find straight track. */
const SLIDE = 4;

/** Metres a platform stands above the road. */
export const PLATFORM_RISE = 0.22;
/** Metres of the ramp down to the road past each end of a platform. */
export const PLATFORM_RAMP = 1.6;
/** Metres of a stop's shelter, along the platform and up. */
export const SHELTER_LONG = 4.6;
export const SHELTER_TALL = 2.5;

/** Where the tram calls at a stop: the run of the loop, and metres along it the front halts at. */
export interface StopPlacement {
  leg: number;
  halt: number;
}

/**
 * The loop as one polyline: metres round it at each point, and where each is.
 * A platform is a straight slab, so it only stands where this is straight.
 */
class LoopLine {
  readonly at: number[] = [];
  readonly xs: number[] = [];
  readonly ys: number[] = [];
  readonly total: number;

  constructor(graph: RoadGraph, route: readonly number[]) {
    let distance = 0;
    for (const id of route) {
      const points = graph.edgePoints(id);
      let walked = 0;
      for (let i = 0; i < points.length; i++) {
        const p = points[i] as Point;
        if (i > 0) walked += hypot(p.x - (points[i - 1] as Point).x, p.y - (points[i - 1] as Point).y);
        if (i === points.length - 1) continue;
        this.at.push(distance + walked);
        this.xs.push(p.x);
        this.ys.push(p.y);
      }
      distance += (graph.edges[id] as RoadEdge).length;
    }
    this.total = distance;
  }

  /**
   * True where the loop from `from` to `to` metres round it keeps within
   * `tolerance` metres of the straight line between its ends.
   */
  straight(from: number, to: number, tolerance: number): boolean {
    const [ax, ay] = this.pointAt(from);
    const [bx, by] = this.pointAt(to);
    const chord = hypot(bx - ax, by - ay);
    if (chord < (to - from) / 2) return false;
    for (const shift of [-this.total, 0, this.total]) {
      for (let i = this.firstAfter(from - shift); i < this.at.length; i++) {
        const d = (this.at[i] as number) + shift;
        if (d >= to) break;
        if (d <= from) continue;
        const off = ((this.xs[i] as number) - ax) * (by - ay) - ((this.ys[i] as number) - ay) * (bx - ax);
        if (Math.abs(off) / chord > tolerance) return false;
      }
    }
    return true;
  }

  /** The index of the first point at or past `distance` metres round the loop, found by halving. */
  private firstAfter(distance: number): number {
    let lo = 0;
    let hi = this.at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.at[mid] as number) < distance) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The point `distance` metres round the loop, between the two points either side of it. */
  private pointAt(distance: number): [number, number] {
    const d = ((distance % this.total) + this.total) % this.total;
    const past = this.firstAfter(d);
    const i = past < this.at.length && (this.at[past] as number) === d ? past : Math.max(0, past - 1);
    const j = (i + 1) % this.at.length;
    const from = this.at[i] as number;
    const to = j === 0 ? this.total : (this.at[j] as number);
    const t = to > from ? (d - from) / (to - from) : 0;
    return [(this.xs[i] as number) + ((this.xs[j] as number) - (this.xs[i] as number)) * t, (this.ys[i] as number) + ((this.ys[j] as number) - (this.ys[i] as number)) * t];
  }
}

/** What a stretch must give a platform: how far it may be from its junction, the clearances, and how straight. */
interface Rules {
  search: number;
  ahead: number;
  behind: number;
  straight: number;
}

/**
 * The rules a stop is placed by, tried in order until one finds it a place.
 * The first is what a stop should have; each after it gives a little up, for
 * the downtown grids whose blocks are shorter than a tram.
 */
const PASSES: readonly Rules[] = [
  { search: STOP_SEARCH, ahead: PLATFORM_AHEAD, behind: PLATFORM_BEHIND, straight: STRAIGHT },
  { search: 2 * STOP_SEARCH, ahead: PLATFORM_AHEAD, behind: PLATFORM_BEHIND, straight: STRAIGHT },
  { search: 2 * STOP_SEARCH, ahead: PLATFORM_AHEAD / 2, behind: PLATFORM_BEHIND / 2, straight: STRAIGHT },
  { search: 2 * STOP_SEARCH, ahead: PLATFORM_AHEAD / 2, behind: PLATFORM_BEHIND / 2, straight: 3 * STRAIGHT },
];

/** A platform's front being looked for: the stop it is for, and the best found so far. */
interface Search {
  line: LoopLine;
  home: number;
  length: number;
  rules: Rules;
  overlaps: (from: number, to: number) => boolean;
  best: number | undefined;
  cost: number;
}

/**
 * The front of the platform nearest `home` round the loop: in some stretch
 * between two `junctions` that holds it, clear of both, on straight track, as
 * near the stop's own junction as the stretch lets it stand, and behind it on
 * a tie.
 */
function nearestFront(search: Search, junctions: readonly number[]): number | undefined {
  const total = search.line.total;
  const { ahead, behind } = search.rules;
  for (let i = 0; i < junctions.length; i++) {
    const from = junctions[i] as number;
    const to = i + 1 < junctions.length ? (junctions[i + 1] as number) : (junctions[0] as number) + total;
    if (to - from - ahead - behind < search.length) continue;
    for (const shift of [-total, 0, total]) slide(search, from + shift + behind + search.length, to + shift - ahead);
  }
  return search.best;
}

/** Try fronts from `lo` to `hi` out from where the stop wants one, a step at a time, and keep the first on straight track. */
function slide(search: Search, lo: number, hi: number): void {
  const wanted = Math.min(hi, Math.max(lo, search.home));
  for (let k = 0; k * SLIDE <= hi - lo; k++) {
    for (const front of k === 0 ? [wanted] : [wanted - k * SLIDE, wanted + k * SLIDE]) {
      if (front >= lo && front <= hi) consider(search, front);
    }
  }
}

function consider(search: Search, front: number): void {
  const away = Math.abs(front - search.length / 2 - search.home) + (front <= search.home ? 1 : 0);
  if (away > search.rules.search || away >= search.cost || search.overlaps(front - search.length, front)) return;
  if (!search.line.straight(front - search.length, front, search.rules.straight)) return;
  search.best = front;
  search.cost = away;
}

/**
 * One placement per stop, in the order of `stops`, for a tram `length` metres
 * long on the loop of runs `route`. A stop with no stretch in reach is left
 * undefined, and the timing calls on the run that arrives at its junction.
 */
export function placeTramStops(
  graph: RoadGraph,
  route: readonly number[],
  stops: readonly Pick<TramStop, 'id' | 'leaves'>[],
  length: number,
): (StopPlacement | undefined)[] {
  const count = route.length;
  const starts = new Float64Array(count + 1);
  for (let leg = 0; leg < count; leg++) starts[leg + 1] = (starts[leg] as number) + (graph.edges[route[leg] as number] as RoadEdge).length;
  const total = starts[count] as number;
  const line = new LoopLine(graph, route);
  // Where the loop passes a junction, turns a corner or turns back: any node that is not two runs end to end, or where the loop bends.
  const junctions: number[] = [];
  for (let leg = 0; leg < count; leg++) {
    const edge = graph.edges[route[leg] as number] as RoadEdge;
    const node = graph.nodes[edge.from];
    const before = graph.edges[route[(leg + count - 1) % count] as number] as RoadEdge;
    // A corner the traffic swings round is as much a break as a junction: a car cuts it.
    const turns = bendOf(graph, before, edge) > CORNER;
    if (turns || (node !== undefined && node.runs.length !== 2)) junctions.push(starts[leg] as number);
  }
  // The run a front stands on, halting partway along it rather than at its very start.
  const legOf = (front: number): number => {
    const at = ((front % total) + total) % total;
    let leg = 0;
    while (leg + 1 < count && (starts[leg + 1] as number) < at) leg++;
    return leg;
  };
  const taken: { from: number; to: number }[] = [];
  // The timing calls at one stop a run, so a run that holds a stop is taken too.
  const used = new Uint8Array(count);
  const overlaps = (from: number, to: number): boolean =>
    used[legOf(to)] === 1 || taken.some((span) => [-total, 0, total].some((shift) => from < span.to + shift && to > span.from + shift));
  return stops.map((stop) => {
    const home = starts[stop.leaves % count] as number;
    let best: number | undefined;
    for (const rules of PASSES) {
      best ??= nearestFront({ line, home, length, rules, overlaps, best: undefined, cost: Infinity }, junctions);
    }
    if (best === undefined) return undefined;
    taken.push({ from: best - length, to: best });
    const leg = legOf(best);
    used[leg] = 1;
    return { leg, halt: ((best % total) + total) % total - (starts[leg] as number) };
  });
}
