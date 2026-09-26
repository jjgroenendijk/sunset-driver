/**
 * The roads a unit on a route drives or walks: the police of spec section 14
 * and the faction enforcers of spec section 17.2.
 *
 * A unit is not steered at a target: it is routed to one. `RoadGraph.shortestPath`
 * is Dijkstra over travel time, so a car takes the arterial that gets there
 * first rather than the alley that points the right way, and that is what lets
 * the police cut a player off instead of following their exact path.
 *
 * A drive is the edges it runs over and the metres covered along them. The
 * record holds the edge ids and the distance, which are plain numbers; the
 * legs a sampler needs are built from them here and cached, because a route is
 * planned every few seconds and read every tick.
 *
 * Pure: the same graph, the same places and the same distance give the same
 * point. Nothing here reads a clock or a random stream.
 */
import { atan2, hypot } from '../../core/libm.ts';
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import { heightOff, RouteSampler, type RouteLegs, type RoutePoint } from '../traffic/route-sample.ts';
import { offsetIn, tramLanes, type TrafficRoads } from '../traffic/traffic.ts';

/** Where a unit is on the ground: the lane point, the road height and the way it faces. */
export interface DrivePose {
  x: number;
  y: number;
  height: number;
  heading: number;
}

/** Metres behind and ahead of a car its heading is read over, so it turns a corner as a curve. */
const SMOOTH = 4;

/** Metres between the readings {@link UnitRoads.nearestAlong} walks a drive in. */
const NEAR_STEP = 4;

/**
 * The road network as the police read it: the graph to route over and the bed
 * to drive on. {@link UnitRoads} is built once for a world and holds no
 * state of the chase.
 */
export class UnitRoads {
  readonly graph: RoadGraph;
  private readonly sampler: RouteSampler;
  /** The legs of the route last asked about, keyed by the unit that drives it. */
  private readonly legs = new Map<number, { edges: readonly number[]; legs: RouteLegs }>();
  /** The tram flags of each run, so a unit keeps off the tram's lane and platform as the traffic does. */
  private readonly tramLane: Uint8Array;
  private readonly point: RoutePoint = { x: 0, y: 0, height: 0, tiltX: 0, tiltY: 0, rightX: 0, rightY: 0, edge: undefined as unknown as RoadEdge };

  constructor(roads: TrafficRoads) {
    this.graph = roads.graph;
    this.sampler = new RouteSampler(roads.roads, roads.graph, roads.heightAt, roads.tiltAt);
    this.tramLane = tramLanes(roads);
  }

  /** The edge nearest a place, or -1 where the world has no roads at all. */
  edgeNear(x: number, y: number): number {
    return this.graph.nearestEdge(x, y)?.edge ?? -1;
  }

  /** The node nearest a place, or -1 on a world with no roads. */
  nodeNear(x: number, y: number): number {
    return this.graph.nearestNode(x, y) ?? -1;
  }

  /**
   * The edges of a drive from one edge to the place a goal stands at. The
   * drive starts with `from`, so a car already on a road finishes the run it is
   * on rather than turning round in the street, and ends at the node nearest
   * the goal. Undefined where the graph cannot join the two.
   */
  plan(from: number, goalX: number, goalY: number): number[] | undefined {
    const goal = this.nodeNear(goalX, goalY);
    return goal < 0 ? undefined : this.planToNode(from, goal);
  }

  /** The edges of a drive from one edge to a node, as {@link plan} describes it. */
  planToNode(from: number, goal: number): number[] | undefined {
    const edge = this.graph.edges[from];
    if (edge === undefined) return undefined;
    if (goal === edge.to) return [from];
    const route = this.graph.shortestPath(edge.to, goal);
    if (route === undefined) return undefined;
    return [from, ...route.edges];
  }

  /**
   * A drive that ends beside a place rather than at the node nearest it: the
   * route to the start of the run of road the place stands on, and then that
   * run itself.
   *
   * {@link plan} ends at a node, and the nodes of a city are a block apart, so
   * a unit sent to a fire in the middle of a street would stop at the junction
   * it is nearest. This drives the street itself, and {@link nearestAlong}
   * says where along it to pull up. It falls back on {@link plan} where the
   * graph cannot join the two.
   */
  planBeside(from: number, goalX: number, goalY: number): number[] | undefined {
    const near = this.graph.nearestEdge(goalX, goalY);
    if (near === undefined) return undefined;
    const target = this.graph.edges[near.edge] as RoadEdge;
    const head = this.planToNode(from, target.from);
    if (head === undefined) return this.plan(from, goalX, goalY);
    return (head[head.length - 1] as number) === target.id ? head : [...head, target.id];
  }

  /** Metres from one end of a drive to the other. */
  length(edges: readonly number[]): number {
    let length = 0;
    for (const id of edges) length += (this.graph.edges[id] as RoadEdge).length;
    return length;
  }

  /** The speed limit of the edge a drive stands on at a distance, in metres per second. */
  limitAt(unit: number, edges: readonly number[], distance: number): number {
    const legs = this.legsOf(unit, edges);
    const at = this.sampler.sample(legs, this.clamp(legs, distance), this.point);
    return at.edge.speedLimit;
  }

  /**
   * Where a drive stands a distance along it, in the unit's own lane. A
   * distance past the end of the drive stands at the end of it, because a
   * drive is a line and not a loop.
   */
  pose(unit: number, edges: readonly number[], distance: number, out: DrivePose): DrivePose {
    const legs = this.legsOf(unit, edges);
    const here = this.clamp(legs, distance);
    const at = this.sampler.sample(legs, here, this.point);
    const offset = this.kerbOffset(at.edge);
    out.x = at.x + at.rightX * offset;
    out.y = at.y + at.rightY * offset;
    out.height = heightOff(at, offset);
    // The heading is read from a point behind to a point ahead, so a car rounds
    // a corner rather than snapping round at the node.
    const back = this.sampler.sample(legs, this.clamp(legs, here - SMOOTH), this.point);
    const bx = back.x + back.rightX * this.kerbOffset(back.edge);
    const by = back.y + back.rightY * this.kerbOffset(back.edge);
    const front = this.sampler.sample(legs, this.clamp(legs, here + SMOOTH), this.point);
    const fx = front.x + front.rightX * this.kerbOffset(front.edge);
    const fy = front.y + front.rightY * this.kerbOffset(front.edge);
    out.heading = fx === bx && fy === by ? 0 : atan2(fy - by, fx - bx);
    return out;
  }

  /**
   * Metres along a drive at which it passes nearest a place, read every
   * {@link NEAR_STEP} metres.
   *
   * A drive is planned between nodes, and the nodes of a city are a block
   * apart, so the end of a route can be well down the street from what the
   * unit was sent to. A unit that pulls up here instead stops beside the
   * scene.
   */
  nearestAlong(unit: number, edges: readonly number[], x: number, y: number): number {
    const legs = this.legsOf(unit, edges);
    let best = 0;
    let gap = Infinity;
    for (let along = 0; along <= legs.length; along += NEAR_STEP) {
      const at = this.sampler.sample(legs, this.clamp(legs, along), this.point);
      const here = hypot(at.x - x, at.y - y);
      if (here >= gap) continue;
      gap = here;
      best = along;
    }
    return Math.min(best, legs.length);
  }

  /**
   * The edge a drive stands on a distance along it, and the metres covered on
   * that edge. A route planned again starts from here, so a car keeps its place
   * on the road it is on rather than jumping back to a node.
   */
  edgeAt(unit: number, edges: readonly number[], distance: number): { edge: number; into: number } {
    const legs = this.legsOf(unit, edges);
    const here = this.clamp(legs, distance);
    let leg = 0;
    while (leg + 1 < edges.length && (legs.startDistance[leg + 1] as number) <= here) leg++;
    return { edge: edges[leg] as number, into: here - (legs.startDistance[leg] as number) };
  }

  /** Forget the legs cached for a unit that has gone. */
  forget(unit: number): void {
    this.legs.delete(unit);
  }

  /** The legs of a unit's drive, rebuilt only when the unit is given a new one. */
  /**
   * Metres right of the middle of a run a unit drives at: the lane nearest the
   * kerb of its own side, which is the outermost one.
   */
  private kerbOffset(edge: RoadEdge): number {
    return offsetIn(edge, edge.lanes - 1, this.tramLane);
  }

  private legsOf(unit: number, edges: readonly number[]): RouteLegs {
    const held = this.legs.get(unit);
    if (held !== undefined && held.edges === edges) return held.legs;
    const startDistance = new Float64Array(edges.length + 1);
    let length = 0;
    for (let i = 0; i < edges.length; i++) {
      startDistance[i] = length;
      length += (this.graph.edges[edges[i] as number] as RoadEdge).length;
    }
    startDistance[edges.length] = length;
    const legs: RouteLegs = { edges: Int32Array.from(edges), startDistance, length };
    this.legs.set(unit, { edges, legs });
    return legs;
  }

  /** A distance held inside a drive, a hair short of its end so the last leg is the last one. */
  private clamp(legs: RouteLegs, distance: number): number {
    return Math.min(Math.max(0, distance), Math.max(0, legs.length - 0.001));
  }
}
