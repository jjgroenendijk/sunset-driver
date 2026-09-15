/**
 * Corridors (spec section 6.3) and the tram route (spec section 13.2).
 *
 * A corridor is a strip of land a road owns without driving on it. Two kinds
 * exist. An elevated corridor is the ground under a deck: the road stands off
 * it, so the strip is a parcel of its own — the under-structure of spec section
 * 6.3, where car parks, dealers' pitches and alley-grade access go — and the
 * pillars that carry the deck stand inside it and nowhere else. A tram corridor
 * is the reserved lane of spec section 13.2: a strip down the middle of an
 * arterial, from one stop to the next.
 *
 * The tram is one fixed loop. It calls at the core and inner districts in the
 * order they stand around the core, and drives between them on the tiers that
 * allow trams, which is the arterials alone (`tiers.ts`). Each leg is the
 * fastest run of arterials between two stops, and a leg avoids the ground an
 * earlier leg took, so the loop goes round the city rather than up and down one
 * street. A district the arterials do not reach gets no stop. Where a road that
 * is not the tram's own meets the line at a junction, the line has a level
 * crossing; a road carried over the tram on a deck is not one, because it never
 * meets the tram at all.
 *
 * Corridors claim ground the way the parcel model does (spec section 1.1): each
 * strip is claimed segment by segment, and ground within {@link CLAIM_CLEARANCE}
 * of a strip already claimed is not free. A run that meets claimed ground is cut
 * there and continues past it, so two corridors can never overlap — the sweep
 * only confirms what the claim makes impossible. The tram claims first, so the
 * loop stays whole and a deck over it gives way instead.
 *
 * Everything here is derived from the world and its roads, so the same seed
 * gives the same corridors.
 */
import { offsetSides, pointInRing } from '../core/geom.ts';
import { clamp, direction, dist } from '../core/math.ts';
import { compareNumbers } from '../core/sort.ts';
import type { RoadEdge, RoadGraph, RoadNode } from './graph.ts';
import { Heightfield } from './heightfield.ts';
import { TIERS } from './tiers.ts';
import type {
  Corridor,
  CorridorKind,
  Point,
  RoadCurve,
  TramDescription,
  TramLevelCrossing,
  TramStop,
  WorldSkeleton,
} from './types.ts';

/** Metres of verge each side of a deck, so the strip is wider than the carriageway it carries. */
const DECK_VERGE = 2;
/** Half the width of the reserved lane: two tram tracks and the clearance between them. */
export const TRAM_HALF = 3.2;
/** Metres of a leg given up at each end, so the strips of two legs never meet at a stop. */
const STOP_CLEARANCE = 8;
/** Metres between the pillar bays under a deck. */
const PILLAR_SPACING = 25;
/** How many places across the strip a foot is tried at before it is given up on. */
const PILLAR_TRIES = 4;
/** How far a pillar foot stands from the centreline, as a fraction of the half-width. */
const PILLAR_INSET = 0.5;
/** Metres of ground two corridors keep between them. */
const CLAIM_CLEARANCE = 0.5;
/** The sharpest corner a strip is carried round. Past a right angle it is cut instead. */
const MAX_BEND = Math.PI / 2;
/** Metres between the samples that ask whether the ground under a deck is water. */
const WET_SAMPLE = 4;
/**
 * How far a district may stand from the arterial that serves it before it goes
 * without a stop, as a fraction of the world side. It is a little under the
 * inner ring's own radius (`districts.ts`), so a stop always stands in the
 * neighbourhood it is named for.
 */
const STOP_REACH = 0.12;
/** Fewest stops a loop is worth running. */
const MIN_STOPS = 3;
/** How much longer a leg may be for staying off the ground an earlier leg took. */
const DETOUR_LIMIT = 1.6;
/** Side of one bucket of the claim index, in metres. */
const INDEX_CELL = 40;
/** Metres below which two centreline points are the same place. */
const EPSILON = 1e-6;

/** The corridors of a world and the tram line that runs down some of them. */
export interface CorridorDescription {
  corridors: Corridor[];
  tram: TramDescription;
}

/**
 * Build every corridor of a world: the tram's reserved lane first, then the
 * ground under the decks. Pure: the same world, roads and graph give the same
 * corridors.
 */
export function buildCorridors(world: WorldSkeleton, roads: readonly RoadCurve[], graph: RoadGraph): CorridorDescription {
  return new CorridorBuilder(world, roads, graph).build();
}

/** A centreline under construction, with the curve each of its segments runs along. */
class Centreline {
  readonly points: Point[] = [];
  /** One entry per segment: the curve `points[i]` to `points[i + 1]` runs along. */
  readonly curves: number[] = [];

  push(p: Point, curve: number): void {
    const last = this.points[this.points.length - 1];
    if (last !== undefined && dist(last.x, last.y, p.x, p.y) <= EPSILON) return;
    this.points.push({ x: p.x, y: p.y });
    if (this.points.length > 1) this.curves.push(curve);
  }
}

class CorridorBuilder {
  private readonly world: WorldSkeleton;
  private readonly roads: readonly RoadCurve[];
  private readonly graph: RoadGraph;
  private readonly hf: Heightfield;
  private readonly claims: ClaimIndex;
  private readonly corridors: Corridor[] = [];
  /** Which run of centreline each claimed quad belongs to; a run never blocks itself. */
  private nextRun = 0;

  constructor(world: WorldSkeleton, roads: readonly RoadCurve[], graph: RoadGraph) {
    this.world = world;
    this.roads = roads;
    this.graph = graph;
    this.hf = new Heightfield(world.terrain);
    this.claims = new ClaimIndex(world.size, INDEX_CELL);
  }

  build(): CorridorDescription {
    const tram = this.buildTram();
    this.buildElevated();
    return { corridors: this.corridors, tram };
  }

  // ---------------------------------------------------------------- the tram

  /** The tram loop: the line it drives, the ground its lane claims, and where roads cross it. */
  private buildTram(): TramDescription {
    const empty: TramDescription = { route: [], edges: [], corridors: [], stops: [], crossings: [], length: 0 };
    const planned = this.planTram();
    if (planned === undefined) return empty;

    const route: Point[] = [];
    const corridors: number[] = [];
    let length = 0;
    for (const leg of planned.legs) {
      length += polylineLength(leg.points);
      for (const p of leg.points) {
        const last = route[route.length - 1];
        if (last === undefined || dist(last.x, last.y, p.x, p.y) > EPSILON) route.push(p);
      }
      // The lane gives up the ground at each stop, so two legs never meet there.
      const line = trimEnds(leg, STOP_CLEARANCE);
      for (const corridor of this.claim('tram', line, TRAM_HALF, false)) corridors.push(corridor.id);
    }
    return { route, edges: planned.edges, corridors, stops: planned.stops, crossings: planned.crossings, length };
  }

  /**
   * The route itself: which stops the loop calls at, the run of arterials
   * between each pair of them, and the roads that cross the line on the flat.
   */
  private planTram(): { legs: Centreline[]; edges: number[]; stops: TramStop[]; crossings: TramLevelCrossing[] } | undefined {
    const candidates = this.stopNodes();
    if (candidates.length < MIN_STOPS) return undefined;

    // One leg at a time round the ring. A stop the line cannot drive to from
    // the one before it is left out, and the line carries on to the next.
    const taken = new Set<number>();
    const called: StopSite[] = [candidates[0] as StopSite];
    const legs: Centreline[] = [];
    const routes: number[][] = [];
    for (let i = 1; i < candidates.length; i++) {
      const site = candidates[i] as StopSite;
      const route = this.tramLeg((called[called.length - 1] as StopSite).node, site.node, taken);
      if (route === undefined) continue;
      legs.push(this.legLine(route));
      routes.push(route);
      called.push(site);
      for (const e of route) this.take(taken, e);
    }

    // Close the loop. A last stop the line cannot get home from is dropped.
    const first = called[0] as StopSite;
    while (called.length >= MIN_STOPS) {
      const closing = this.tramLeg((called[called.length - 1] as StopSite).node, first.node, taken);
      if (closing !== undefined) {
        legs.push(this.legLine(closing));
        routes.push(closing);
        break;
      }
      called.pop();
      legs.pop();
      for (const e of routes.pop() ?? []) this.release(taken, e);
    }
    if (called.length < MIN_STOPS || legs.length !== called.length) return undefined;
    // Stop `i` is where leg `i` starts, so it leaves on the first run of that leg.
    const edges: number[] = [];
    const stops: TramStop[] = [];
    for (let id = 0; id < called.length; id++) {
      const site = called[id] as StopSite;
      stops.push({ id, x: site.x, y: site.y, district: site.district, leaves: edges.length });
      edges.push(...(routes[id] as number[]));
    }
    return { legs, edges, stops, crossings: this.levelCrossings(routes) };
  }

  /**
   * The fastest run of tram-capable road between two stops. Ground an earlier
   * leg took is avoided, so the loop goes round the city instead of up and down
   * one street, but only as long as going round costs less than
   * {@link DETOUR_LIMIT}; past that the line doubles back rather than tour the
   * suburbs to reach the next stop.
   */
  private tramLeg(from: number, to: number, taken: ReadonlySet<number>): number[] | undefined {
    const direct = this.graph.shortestPath(from, to, (edge) => this.carriesTram(edge));
    if (direct === undefined) return undefined;
    const fresh = this.graph.shortestPath(from, to, (edge) => this.carriesTram(edge) && !taken.has(edge.id));
    if (fresh !== undefined && fresh.length <= direct.length * DETOUR_LIMIT) return fresh.edges;
    return direct.edges;
  }

  private carriesTram(edge: RoadEdge): boolean {
    return TIERS[edge.tier].traffic.trams;
  }

  /** Mark a run and the same run the other way as taken, so the next leg looks elsewhere. */
  private take(taken: Set<number>, edge: number): void {
    taken.add(edge);
    const twin = (this.graph.edges[edge] as RoadEdge).twin;
    if (twin >= 0) taken.add(twin);
  }

  private release(taken: Set<number>, edge: number): void {
    taken.delete(edge);
    const twin = (this.graph.edges[edge] as RoadEdge).twin;
    if (twin >= 0) taken.delete(twin);
  }

  /** The centreline of a leg: the points of its runs, end to end. */
  private legLine(route: readonly number[]): Centreline {
    const line = new Centreline();
    for (const e of route) {
      const edge = this.graph.edges[e] as RoadEdge;
      for (const p of this.graph.edgePoints(e)) line.push(p, edge.curve);
    }
    return line;
  }

  /**
   * The stops the loop calls at: one for each core and inner district, at the
   * nearest junction of the arterial network, ordered the way the districts
   * stand around the core so the line runs a ring rather than a scribble.
   *
   * A district further from the network than {@link STOP_REACH} goes without,
   * because a stop that far from the streets it is named for serves nobody. On
   * a seed whose arterials leave fewer than {@link MIN_STOPS} districts inside
   * that reach, the nearest few keep their stops anyway: a short line is better
   * than no line at all.
   */
  private stopNodes(): StopSite[] {
    const core = this.world.core;
    const network = this.tramNetwork();
    const served: (StopSite & { away: number; bearing: number })[] = [];
    const used = new Set<number>();
    for (const d of this.world.districts) {
      if (d.zone !== 'core' && d.zone !== 'inner') continue;
      const node = this.nearestTramNode(network, d.x, d.y);
      if (node === undefined || used.has(node.id)) continue;
      used.add(node.id);
      served.push({
        node: node.id,
        x: node.x,
        y: node.y,
        district: d.id,
        away: dist(d.x, d.y, node.x, node.y),
        bearing: Math.atan2(d.y - core.y, d.x - core.x),
      });
    }

    const reach = this.world.size * STOP_REACH;
    let chosen = served.filter((s) => s.away <= reach);
    if (chosen.length < MIN_STOPS) {
      chosen = [...served].sort((a, b) => a.away - b.away || a.district - b.district).slice(0, MIN_STOPS);
    }
    return chosen.sort((a, b) => a.bearing - b.bearing || a.district - b.district);
  }

  /**
   * The junctions of the largest run of tram-capable road, one flag each. The
   * arterials fall into a few pieces the tram cannot drive between, and a line
   * that called at a stop on another piece could not reach it, so the stops all
   * come from the biggest one.
   */
  private tramNetwork(): Uint8Array {
    const count = this.graph.nodes.length;
    const parent = new Int32Array(count);
    for (let i = 0; i < count; i++) parent[i] = i;
    const find = (i: number): number => {
      let at = i;
      while ((parent[at] as number) !== at) {
        parent[at] = parent[parent[at] as number] as number;
        at = parent[at] as number;
      }
      return at;
    };
    const onTram = new Uint8Array(count);
    for (const edge of this.graph.edges) {
      if (!this.carriesTram(edge)) continue;
      onTram[edge.from] = 1;
      onTram[edge.to] = 1;
      parent[find(edge.from)] = find(edge.to);
    }

    const size = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      if (onTram[i] !== 1) continue;
      const at = find(i);
      size[at] = (size[at] as number) + 1;
    }
    let root = -1;
    let best = 0;
    for (let i = 0; i < count; i++) {
      if ((size[i] as number) <= best) continue;
      best = size[i] as number;
      root = i;
    }
    const network = new Uint8Array(count);
    for (let i = 0; i < count; i++) if (onTram[i] === 1 && find(i) === root) network[i] = 1;
    return network;
  }

  /** The nearest junction of a network to a place. */
  private nearestTramNode(network: Uint8Array, x: number, y: number): RoadNode | undefined {
    let best: RoadNode | undefined;
    let bestD = Infinity;
    for (const node of this.graph.nodes) {
      if (network[node.id] !== 1) continue;
      const d = dist(x, y, node.x, node.y);
      if (d >= bestD) continue;
      bestD = d;
      best = node;
    }
    return best;
  }

  /**
   * Every junction on the route another road meets, and which roads those are.
   * A junction where the line only changes from one arterial to the next is no
   * crossing: nothing crosses the tram there.
   */
  private levelCrossings(routes: readonly (readonly number[])[]): TramLevelCrossing[] {
    // The curves the line itself runs along at each junction it passes.
    const mine = new Map<number, number[]>();
    const order: number[] = [];
    for (const route of routes) {
      for (const e of route) {
        const edge = this.graph.edges[e] as RoadEdge;
        for (const node of [edge.from, edge.to]) {
          let curves = mine.get(node);
          if (curves === undefined) {
            curves = [];
            mine.set(node, curves);
            order.push(node);
          }
          if (!curves.includes(edge.curve)) curves.push(edge.curve);
        }
      }
    }

    const crossings: TramLevelCrossing[] = [];
    for (const id of order) {
      const node = this.graph.nodes[id] as RoadNode;
      const own = mine.get(id) as number[];
      const roads: number[] = [];
      for (const e of node.edges) {
        const curve = (this.graph.edges[e] as RoadEdge).curve;
        if (own.includes(curve) || roads.includes(curve)) continue;
        roads.push(curve);
      }
      if (roads.length === 0) continue;
      roads.sort(compareNumbers);
      crossings.push({ x: node.x, y: node.y, node: id, roads });
    }
    return crossings;
  }

  // ------------------------------------------------------------ the elevated

  /**
   * The ground under every deck that stands over land. A deck over water covers
   * no ground, so it owns no corridor; a deck over a dip owns the dip.
   */
  private buildElevated(): void {
    for (const road of this.roads) {
      const halfWidth = TIERS[road.tier].width / 2 + DECK_VERGE;
      for (const run of this.deckRuns(road)) {
        const line = new Centreline();
        for (let i = run.from; i <= run.to + 1; i++) line.push(road.points[i] as Point, road.id);
        this.claim('elevated', line, halfWidth, true);
      }
    }
  }

  /** Runs of neighbouring deck segments of one curve that stand over land. */
  private deckRuns(road: RoadCurve): { from: number; to: number }[] {
    const runs: { from: number; to: number }[] = [];
    let open: { from: number; to: number } | undefined;
    for (const at of road.bridges) {
      const a = road.points[at] as Point | undefined;
      const b = road.points[at + 1] as Point | undefined;
      if (a === undefined || b === undefined || this.overWater(a, b)) {
        open = undefined;
        continue;
      }
      if (open !== undefined && open.to === at - 1) open.to = at;
      else runs.push((open = { from: at, to: at }));
    }
    return runs;
  }

  /** True when any part of a span stands over water, so no land lies under it. */
  private overWater(a: Point, b: Point): boolean {
    const sea = this.world.water.seaLevel;
    const steps = Math.max(1, Math.ceil(dist(a.x, a.y, b.x, b.y) / WET_SAMPLE));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (this.hf.sample(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) < sea) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ claims

  /**
   * Claim the strip along a centreline. A line that turns back on itself is cut
   * at the turn first: a strip that folded over a corner would claim the same
   * ground twice, and the two halves of it then claim against each other like
   * any other pair.
   */
  private claim(kind: CorridorKind, line: Centreline, halfWidth: number, pillars: boolean): Corridor[] {
    const made: Corridor[] = [];
    for (const part of unfold(line)) made.push(...this.claimStraightaway(kind, part, halfWidth, pillars));
    return made;
  }

  /**
   * Claim one line that never turns back, and add what is left of it as
   * corridors. The strip is claimed segment by segment: a segment whose ground
   * another corridor already holds is given up, and the run continues on the
   * far side of it as a corridor of its own.
   *
   * A segment standing over water is given up the same way, because there is no
   * ground under it to claim. The tram is what needs that: its lane runs down
   * the middle of an arterial, and an arterial crosses a strait on a deck. A
   * deck run is cut on the same rule before it is claimed at all.
   */
  private claimStraightaway(kind: CorridorKind, line: Centreline, halfWidth: number, pillars: boolean): Corridor[] {
    const points = line.points;
    if (points.length < 2) return [];
    const { left, right } = offsetSides(points, halfWidth);
    const run = this.nextRun++;
    const pieces: { from: number; to: number }[] = [];
    let open: { from: number; to: number } | undefined;
    for (let i = 0; i + 1 < points.length; i++) {
      const quad = [left[i] as Point, left[i + 1] as Point, right[i + 1] as Point, right[i] as Point];
      if (this.overWater(points[i] as Point, points[i + 1] as Point) || this.claims.taken(run, quad)) {
        open = undefined;
        continue;
      }
      this.claims.add(run, quad);
      if (open !== undefined && open.to === i - 1) open.to = i;
      else pieces.push((open = { from: i, to: i }));
    }

    const made: Corridor[] = [];
    for (const piece of pieces) {
      const own = points.slice(piece.from, piece.to + 2);
      const roads: number[] = [];
      for (let i = piece.from; i <= piece.to; i++) {
        const curve = line.curves[i] as number;
        if (!roads.includes(curve)) roads.push(curve);
      }
      roads.sort(compareNumbers);
      const polygon = [
        ...right.slice(piece.from, piece.to + 2),
        ...left.slice(piece.from, piece.to + 2).reverse(),
      ];
      const corridor: Corridor = {
        id: this.corridors.length,
        kind,
        roads,
        points: own,
        halfWidth,
        polygon,
        pillars: pillars ? pillarFeet(own, halfWidth, polygon) : [],
      };
      this.corridors.push(corridor);
      made.push(corridor);
    }
    return made;
  }
}

/** A district's place on the tram line: the junction it is served from. */
interface StopSite {
  node: number;
  x: number;
  y: number;
  district: number;
}

/**
 * One centreline cut into the parts that never turn back on themselves. A line
 * that comes back the way it went — the tram turning round at a junction — is
 * cut at the turn, because a strip laid round a corner that sharp would fold
 * over itself and claim the same ground twice.
 */
function unfold(line: Centreline): Centreline[] {
  const parts: Centreline[] = [];
  let part = new Centreline();
  for (let i = 0; i < line.points.length; i++) {
    const here = line.points[i] as Point;
    // The curve of the segment that arrives here; the first point of a part has none.
    const arriving = i > 0 ? (line.curves[i - 1] as number) : 0;
    if (i > 0 && i + 1 < line.points.length && bend(line.points, i) > MAX_BEND) {
      part.push(here, arriving);
      parts.push(part);
      part = new Centreline();
    }
    part.push(here, arriving);
  }
  parts.push(part);
  return parts.filter((p) => p.points.length > 1);
}

/** How far the line turns at one of its points, in radians away from straight on. */
function bend(points: readonly Point[], at: number): number {
  const back = direction(points[at - 1] as Point, points[at] as Point);
  const ahead = direction(points[at] as Point, points[at + 1] as Point);
  return Math.acos(clamp(back.x * ahead.x + back.y * ahead.y, -1, 1));
}

/**
 * The feet of the pillars under a deck: a pair across the centreline at every
 * bay, spaced evenly so neither abutment carries a pillar of its own.
 *
 * A foot stands on the ground the corridor claims and nowhere else, so one that
 * falls outside the strip — which a short claim cut out of a longer one can do —
 * is drawn in towards the centreline until it is inside, and dropped where even
 * the centreline is not.
 */
function pillarFeet(points: readonly Point[], halfWidth: number, ground: readonly Point[]): Point[] {
  const length = polylineLength(points);
  const bays = Math.max(2, Math.round(length / PILLAR_SPACING));
  const feet: Point[] = [];
  for (let i = 1; i < bays; i++) {
    const at = pointAlong(points, (length * i) / bays);
    for (const side of [1, -1]) {
      const foot = standing(at, side * halfWidth * PILLAR_INSET, ground);
      if (foot !== undefined) feet.push(foot);
    }
  }
  return feet;
}

/**
 * A pillar foot at an offset across the line, brought in towards the line until
 * it stands on the corridor's own ground. Undefined where nothing on the line
 * across does.
 */
function standing(
  at: { x: number; y: number; dx: number; dy: number },
  offset: number,
  ground: readonly Point[],
): Point | undefined {
  for (let step = 0; step < PILLAR_TRIES; step++) {
    const out = offset * (1 - step / PILLAR_TRIES);
    const foot = { x: at.x - at.dy * out, y: at.y + at.dx * out };
    if (pointInRing(foot, ground)) return foot;
  }
  return undefined;
}

/** The point a given distance along a polyline, and the way the line runs there. */
function pointAlong(points: readonly Point[], metres: number): { x: number; y: number; dx: number; dy: number } {
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

/** A centreline with both ends pulled back by the given distance, curve by curve. */
function trimEnds(line: Centreline, metres: number): Centreline {
  const out = new Centreline();
  const length = polylineLength(line.points);
  if (length <= 2 * metres) return out;
  let run = 0;
  const head = pointAlong(line.points, metres);
  out.push({ x: head.x, y: head.y }, line.curves[0] as number);
  for (let i = 0; i + 1 < line.points.length; i++) {
    const a = line.points[i] as Point;
    const b = line.points[i + 1] as Point;
    run += dist(a.x, a.y, b.x, b.y);
    if (run <= metres) continue;
    if (run >= length - metres) break;
    out.push(b, line.curves[i] as number);
  }
  const tail = pointAlong(line.points, length - metres);
  out.push({ x: tail.x, y: tail.y }, line.curves[line.curves.length - 1] as number);
  return out;
}

function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    total += dist(a.x, a.y, b.x, b.y);
  }
  return total;
}

/** One claimed piece of ground: a convex quad, and the run of centreline it came from. */
interface Claim {
  run: number;
  quad: Point[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The ground the corridors have claimed, in a uniform grid of buckets, so
 * "is this strip free?" costs a handful of comparisons rather than a walk over
 * everything claimed so far.
 */
class ClaimIndex {
  private readonly cell: number;
  private readonly n: number;
  private readonly origin: number;
  private readonly buckets: Claim[][] = [];

  constructor(size: number, cell: number) {
    this.cell = cell;
    this.origin = -size / 2 - 2 * cell;
    this.n = Math.ceil((size + 4 * cell) / cell) + 1;
    for (let i = 0; i < this.n * this.n; i++) this.buckets.push([]);
  }

  private column(v: number): number {
    return clamp(Math.floor((v - this.origin) / this.cell), 0, this.n - 1);
  }

  add(run: number, quad: Point[]): void {
    const claim = { run, quad, ...boundsOf(quad) };
    for (let iy = this.column(claim.minY); iy <= this.column(claim.maxY); iy++) {
      for (let ix = this.column(claim.minX); ix <= this.column(claim.maxX); ix++) {
        (this.buckets[iy * this.n + ix] as Claim[]).push(claim);
      }
    }
  }

  /** True when a quad stands within {@link CLAIM_CLEARANCE} of ground another run holds. */
  taken(run: number, quad: Point[]): boolean {
    const box = boundsOf(quad);
    for (let iy = this.column(box.minY); iy <= this.column(box.maxY); iy++) {
      for (let ix = this.column(box.minX); ix <= this.column(box.maxX); ix++) {
        for (const claim of this.buckets[iy * this.n + ix] as Claim[]) {
          if (claim.run === run) continue;
          if (claim.minX - box.maxX >= CLAIM_CLEARANCE || box.minX - claim.maxX >= CLAIM_CLEARANCE) continue;
          if (claim.minY - box.maxY >= CLAIM_CLEARANCE || box.minY - claim.maxY >= CLAIM_CLEARANCE) continue;
          if (near(quad, claim.quad, CLAIM_CLEARANCE)) return true;
        }
      }
    }
    return false;
  }
}

function boundsOf(quad: readonly Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of quad) {
    if (p.x < box.minX) box.minX = p.x;
    if (p.y < box.minY) box.minY = p.y;
    if (p.x > box.maxX) box.maxX = p.x;
    if (p.y > box.maxY) box.maxY = p.y;
  }
  return box;
}

/**
 * True when two convex rings stand less than `gap` metres apart. Separating
 * axes: where the two shapes cast disjoint shadows on the normal of any of
 * their edges, and the shadows stand `gap` apart, nothing of one is that close
 * to the other.
 */
function near(a: readonly Point[], b: readonly Point[], gap: number): boolean {
  return !apart(a, b, gap) && !apart(b, a, gap);
}

function apart(a: readonly Point[], b: readonly Point[], gap: number): boolean {
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as Point;
    const q = a[(i + 1) % a.length] as Point;
    const len = dist(p.x, p.y, q.x, q.y);
    if (len < EPSILON) continue;
    const nx = -(q.y - p.y) / len;
    const ny = (q.x - p.x) / len;
    const sa = span(a, nx, ny);
    const sb = span(b, nx, ny);
    if (sb.lo - sa.hi >= gap || sa.lo - sb.hi >= gap) return true;
  }
  return false;
}

/** The shadow a ring casts on an axis. */
function span(ring: readonly Point[], nx: number, ny: number): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ring) {
    const v = p.x * nx + p.y * ny;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}
