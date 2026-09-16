/**
 * The roads a police unit drives (spec section 14).
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
import type { RoadEdge, RoadGraph } from '../world/graph.ts';
import { RouteSampler, type RouteLegs, type RoutePoint } from './route-sample.ts';
import { laneOffset, type TrafficRoads } from './traffic.ts';

/** Where a unit is on the ground: the lane point, the road height and the way it faces. */
export interface DrivePose {
  x: number;
  y: number;
  height: number;
  heading: number;
}

/** The lane a police car drives in, which is the one nearest the kerb of its own side. */
const POLICE_LANE = 0;

/** Metres behind and ahead of a car its heading is read over, so it turns a corner as a curve. */
const SMOOTH = 4;

/**
 * The road network as the police read it: the graph to route over and the bed
 * to drive on. {@link PoliceRoads} is built once for a world and holds no
 * state of the chase.
 */
export class PoliceRoads {
  readonly graph: RoadGraph;
  private readonly sampler: RouteSampler;
  /** The legs of the route last asked about, keyed by the unit that drives it. */
  private readonly legs = new Map<number, { edges: readonly number[]; legs: RouteLegs }>();
  private readonly point: RoutePoint = { x: 0, y: 0, height: 0, rightX: 0, rightY: 0, edge: undefined as unknown as RoadEdge };

  constructor(roads: TrafficRoads) {
    this.graph = roads.graph;
    this.sampler = new RouteSampler(roads.roads, roads.graph, roads.heightAt);
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
    const edge = this.graph.edges[from];
    if (edge === undefined) return undefined;
    const goal = this.nodeNear(goalX, goalY);
    if (goal < 0) return undefined;
    if (goal === edge.to) return [from];
    const route = this.graph.shortestPath(edge.to, goal);
    if (route === undefined) return undefined;
    return [from, ...route.edges];
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
    const offset = laneOffset(at.edge, POLICE_LANE);
    out.x = at.x + at.rightX * offset;
    out.y = at.y + at.rightY * offset;
    out.height = at.height;
    // The heading is read from a point behind to a point ahead, so a car rounds
    // a corner rather than snapping round at the node.
    const back = this.sampler.sample(legs, this.clamp(legs, here - SMOOTH), this.point);
    const bx = back.x + back.rightX * laneOffset(back.edge, POLICE_LANE);
    const by = back.y + back.rightY * laneOffset(back.edge, POLICE_LANE);
    const front = this.sampler.sample(legs, this.clamp(legs, here + SMOOTH), this.point);
    const fx = front.x + front.rightX * laneOffset(front.edge, POLICE_LANE);
    const fy = front.y + front.rightY * laneOffset(front.edge, POLICE_LANE);
    out.heading = fx === bx && fy === by ? 0 : Math.atan2(fy - by, fx - bx);
    return out;
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
