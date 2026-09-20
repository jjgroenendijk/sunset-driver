/**
 * Corridors (spec section 6.3) and the tram route (spec section 13.2).
 *
 * A corridor is a strip of land a road owns without driving on it. Two kinds
 * exist. An elevated corridor is the ground under a deck: the road stands off
 * it, so the strip is a parcel of its own — the under-structure of spec section
 * 6.3, where car parks, dealers' pitches and alley-grade access go — and the
 * pillars that carry the deck stand inside it, off every road that passes under
 * the deck (`piers.ts`). A tram corridor
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
import { acos, atan2 } from '../core/libm.ts';
import { clamp, direction, dist } from '../core/math.ts';
import { compareNumbers } from '../core/sort.ts';
import { ClaimIndex } from './corridor-claims.ts';
import type { RoadEdge, RoadGraph, RoadNode } from './graph.ts';
import { Heightfield } from './heightfield.ts';
import { deckHalfWidth, deckRuns, overWater, pierFeet, pointAlong, polylineLength, RoadGround } from './piers.ts';
import { TIERS, TRAM_LANE } from './tiers.ts';
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

/** Metres of a leg given up at each end, so the strips of two legs never meet at a stop. */
const STOP_CLEARANCE = 8;
/** The sharpest corner a strip is carried round. Past a right angle it is cut instead. */
const MAX_BEND = Math.PI / 2;
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
  /** The ground the roads stand on, which no pillar foot may stand on. */
  private readonly ground: RoadGround;
  private readonly corridors: Corridor[] = [];
  /** Which run of centreline each claimed quad belongs to; a run never blocks itself. */
  private nextRun = 0;

  constructor(world: WorldSkeleton, roads: readonly RoadCurve[], graph: RoadGraph) {
    this.world = world;
    this.roads = roads;
    this.graph = graph;
    this.hf = new Heightfield(world.terrain);
    this.claims = new ClaimIndex(world.size, INDEX_CELL);
    this.ground = new RoadGround(roads);
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
      for (const corridor of this.claim('tram', line, TRAM_LANE.halfWidth, -1)) corridors.push(corridor.id);
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

  /**
   * True where the tram may run down an edge: an arterial, but never a ramp of
   * an interchange. A ramp is laid at the arterial's tier and runs one way, and
   * a loop that goes out along one has no way back down it.
   */
  private carriesTram(edge: RoadEdge): boolean {
    return TIERS[edge.tier].traffic.trams && (this.roads[edge.curve] as RoadCurve).oneWay !== true;
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
    const network = this.tramNetwork();
    const nearest = this.servedDistricts(network, false);
    // Where the districts crowd round one or two junctions, each after the
    // first finds the junction taken and goes without a stop, and a line of
    // two stops is no loop, so the seed gets no tram at all. So the districts
    // are asked again, each taking the nearest junction still free (issue #373).
    const served = nearest.length >= MIN_STOPS ? nearest : this.servedDistricts(network, true);

    const reach = this.world.size * STOP_REACH;
    let chosen = served.filter((s) => s.away <= reach);
    if (chosen.length < MIN_STOPS) {
      chosen = [...served].sort((a, b) => a.away - b.away || a.district - b.district).slice(0, MIN_STOPS);
    }
    return chosen.sort((a, b) => a.bearing - b.bearing || a.district - b.district);
  }

  /**
   * One stop for each core and inner district, at a junction of the tram
   * network. Two districts never share a stop: the second of them goes without.
   * `spread` gives it the nearest junction still free instead, which is the
   * answer where too few districts are left to make a loop.
   */
  private servedDistricts(network: Uint8Array, spread: boolean): StopChoice[] {
    const core = this.world.core;
    const served: StopChoice[] = [];
    const used = new Set<number>();
    for (const d of this.world.districts) {
      if (d.zone !== 'core' && d.zone !== 'inner') continue;
      const node = this.nearestTramNode(network, d.x, d.y, spread ? used : undefined);
      if (node === undefined || used.has(node.id)) continue;
      used.add(node.id);
      served.push({
        node: node.id,
        x: node.x,
        y: node.y,
        district: d.id,
        away: dist(d.x, d.y, node.x, node.y),
        bearing: atan2(d.y - core.y, d.x - core.x),
      });
    }
    return served;
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

  /** The nearest junction of a network to a place, leaving out the ones already `taken`. */
  private nearestTramNode(network: Uint8Array, x: number, y: number, taken?: ReadonlySet<number>): RoadNode | undefined {
    let best: RoadNode | undefined;
    let bestD = Infinity;
    for (const node of this.graph.nodes) {
      if (network[node.id] !== 1 || taken?.has(node.id) === true) continue;
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
      for (const run of deckRuns(road, (a, b) => this.overWater(a, b), false)) {
        const line = new Centreline();
        for (let i = run.from; i <= run.to + 1; i++) line.push(road.points[i] as Point, road.id);
        this.claim('elevated', line, deckHalfWidth(road), road.id);
      }
    }
  }

  private overWater(a: Point, b: Point): boolean {
    return overWater(this.hf, this.world.water.seaLevel, a, b);
  }

  // ------------------------------------------------------------------ claims

  /**
   * Claim the strip along a centreline. A line that turns back on itself is cut
   * at the turn first: a strip that folded over a corner would claim the same
   * ground twice, and the two halves of it then claim against each other like
   * any other pair. `deck` is the curve an elevated corridor carries, which
   * stands its pillars; a tram corridor passes -1 and stands none.
   */
  private claim(kind: CorridorKind, line: Centreline, halfWidth: number, deck: number): Corridor[] {
    const made: Corridor[] = [];
    for (const part of unfold(line)) made.push(...this.claimStraightaway(kind, part, halfWidth, deck));
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
  private claimStraightaway(kind: CorridorKind, line: Centreline, halfWidth: number, deck: number): Corridor[] {
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
        pillars: deck < 0 ? [] : this.pillarsOf(own, halfWidth, polygon, deck),
      };
      this.corridors.push(corridor);
      made.push(corridor);
    }
    return made;
  }

  /**
   * The feet of the pillars under a deck. A foot stands on the ground the
   * corridor claims and nowhere else — a short claim cut out of a longer one
   * can leave a bay outside it — and never on a road that passes under the deck.
   */
  private pillarsOf(points: readonly Point[], halfWidth: number, polygon: readonly Point[], deck: number): Point[] {
    return pierFeet(points, halfWidth, (foot) => pointInRing(foot, polygon) && !this.ground.covers(foot, deck));
  }
}

/** A district's place on the tram line: the junction it is served from. */
interface StopSite {
  node: number;
  x: number;
  y: number;
  district: number;
}

/** A stop as it is chosen: how far its district stands from it, and where it lies round the core. */
interface StopChoice extends StopSite {
  away: number;
  bearing: number;
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
  return acos(clamp(back.x * ahead.x + back.y * ahead.y, -1, 1));
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
