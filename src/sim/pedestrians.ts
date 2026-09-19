/**
 * Ambient pedestrians (spec sections 5.3, 13.1): every person on the city's
 * pavements as a function of `(seed, tick)` and a stable id.
 *
 * The crowd is placed once for a world, the way the traffic is. Each directed
 * run of a road with a pavement gets a number of people from its tier's
 * `walkers` and the district it runs through. Each person walks a loop of the
 * road graph for ever, on one pavement, at their own pace, crossing where the
 * loop turns (`pedestrian-route.ts`). Their look and their gait come from the
 * district (`pedestrian-look.ts`). No person reads another one.
 *
 * Where a person is can be asked two ways, and they agree exactly:
 * {@link AmbientPedestrians.cursorAt} evaluates them at any tick, and
 * {@link AmbientPedestrians.advance} steps a cursor one tick. A loop takes a
 * whole number of ticks and a whole number of strides, so the walk cycle comes
 * round with the loop and never jumps.
 *
 * A person who reacts to something — a shot, a car on the pavement — leaves
 * the loop. {@link startle} writes them into {@link PedestrianState}, the only
 * part of the crowd the record holds, and {@link startledPose} says where they
 * are from then on. The living city of spec section 20.1 is what calls it.
 */
import { hashInts } from '../core/hash.ts';
import { rngFor, Subsystem, type Rng } from '../core/rng.ts';
import { atan2, cos, hypot, sin } from '../core/libm.ts';
import type { RoadEdge, RoadGraph } from '../world/graph.ts';
import { TIERS } from '../world/tiers.ts';
import { districtAt, layoutZones } from '../world/districts.ts';
import type { District, Point, RoadCurve, WorldDescription, Zone } from '../world/types.ts';
import { TICK_RATE } from './clock.ts';
import { EdgeIndex } from './edge-index.ts';
import { lookOf, strideOf, type Gait, type PedestrianLook } from './pedestrian-look.ts';
import { Pavements, pavementOffset, type WalkPoint, type WalkRoute } from './pedestrian-route.ts';
import { backOf, walkOut } from './traffic-tour.ts';
import type { TrafficRoads } from './traffic.ts';

/** Metres each way of one bucket of the index that says which people can be near a place. */
export const PEDESTRIAN_CELL = 100;

/** Metres behind and ahead of a person their pose is read at, so they turn a corner rather than snap round. */
export const HALF_STEP = 0.3;

/** How busy each zone's pavements are, as a share of the tier's walkers. */
export const ZONE_PEDESTRIANS: Record<Zone, number> = {
  core: 1,
  inner: 0.75,
  industrial: 0.25,
  suburban: 0.3,
  outskirts: 0.1,
  wilderness: 0.03,
};

/** Metres a walk covers before it turns back, so a person stays in their own few blocks. */
export const WALK_REACH = 700;

/** Metres a loop of pavement has to be before a walk ends on it: once round a city block. */
export const WALK_LOOP = 250;

/** The keys of the two streams the crowd draws from, so neither shifts the other. */
const EDGE_STREAM = 1;
const PERSON_STREAM = 2;
/** The key of the stream a reaction draws from. */
const REACTION_STREAM = 3;

/** The district at a place, as far as the crowd needs it. */
export type DistrictAt = (x: number, y: number) => Pick<District, 'zone' | 'density'>;

/** The districts of a generated world, as the crowd reads them. */
export function crowdDistrictsOf(world: WorldDescription): DistrictAt {
  const zones = layoutZones(world.size, world.core, world.water);
  return (x, y) => districtAt(world.districts, zones, x, y);
}

/** One person of the crowd: how they look, and the loop they walk. */
export interface AmbientPedestrian {
  id: number;
  look: PedestrianLook;
  /** +1 on the pavement to the right of the loop's direction, -1 on the left. */
  side: number;
  /** The tick of the loop they stand at on tick 0. */
  phase: number;
  /** Ticks once round the loop. */
  period: number;
  /** Whole walk cycles once round the loop. */
  strides: number;
  route: WalkRoute;
}

/** Where on the loop a person is: the whole ticks into it. */
export interface PedestrianCursor {
  id: number;
  at: number;
}

/** A person placed on the map. `y` is the map's; `height` is up. */
export interface PedestrianPose {
  x: number;
  y: number;
  /** The ground under their feet. */
  height: number;
  heading: number;
  /** Metres per second along the heading. */
  speed: number;
  /** How far through the walk cycle they are, 0 to 1. */
  cycle: number;
  gait: Gait;
}

/** What makes a person leave their loop. */
export type Reaction = 'flee' | 'scatter' | 'gather';

/** How a reaction moves a person: their pace, how long for, and the gait they move in. */
export interface ReactionSpec {
  speed: number;
  ticks: number;
  gait: Gait;
  /** True for a reaction that walks a person to the place rather than off it. */
  toward: boolean;
}

/** How far and how fast each reaction moves a person, and the gait they move in. */
export const REACTIONS: Record<Reaction, ReactionSpec> = {
  // Away from gunfire, at a run, for a good distance.
  flee: { speed: 4, ticks: 8 * TICK_RATE, gait: 'run', toward: false },
  // Out of the way of a car: a few quick steps to the side.
  scatter: { speed: 3.2, ticks: Math.round(1.2 * TICK_RATE), gait: 'run', toward: false },
  // Towards a crash, for a few steps, and then they stand and watch it.
  gather: { speed: 1.5, ticks: 2 * TICK_RATE, gait: 'brisk', toward: true },
};

/** A person who has left their loop, and the record the simulation keeps of them. */
export interface StartledPedestrian {
  id: number;
  reaction: Reaction;
  /** The tick they reacted on. */
  since: number;
  /** Where they stood then, and the way they move off. */
  x: number;
  y: number;
  height: number;
  heading: number;
}

/** What the simulation record holds of the crowd: only who has left their loops. */
export interface PedestrianState {
  /** Ascending by id. */
  startled: StartledPedestrian[];
}

export function createPedestrianState(): PedestrianState {
  return { startled: [] };
}

/** The record of a startled person, or undefined while they still walk their loop. */
export function startledOf(state: PedestrianState, id: number): StartledPedestrian | undefined {
  const list = state.startled;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = (list[mid] as StartledPedestrian).id;
    if (at === id) return list[mid];
    if (at < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

export class AmbientPedestrians {
  readonly people: readonly AmbientPedestrian[];
  readonly pavements: Pavements;
  private readonly seed: number;
  private readonly index: EdgeIndex;
  private readonly behind: WalkPoint = { x: 0, y: 0, height: 0 };
  private readonly ahead: WalkPoint = { x: 0, y: 0, height: 0 };

  constructor(seed: number, roads: TrafficRoads, districtAt?: DistrictAt) {
    this.seed = seed;
    const graph = roads.graph;
    this.pavements = new Pavements(roads.roads, graph, roads.heightAt);
    // A corner can stand a few pavement widths off the node it turns at.
    this.index = new EdgeIndex(roads.roads, graph, 4 * pavementOffset({ tier: 'arterial' }), PEDESTRIAN_CELL);
    const people: AmbientPedestrian[] = [];
    for (const edge of graph.edges) {
      if (!walkable(edge)) continue;
      const mid = midpoint(roads.roads, edge);
      const district = districtAt?.(mid.x, mid.y) ?? { zone: 'core', density: 1 };
      this.place(edge, district, roads, people);
    }
    this.people = people;
  }

  /** Where a person is on their loop at a tick, evaluated without stepping them there. */
  cursorAt(id: number, tick: number, out: PedestrianCursor = { id, at: 0 }): PedestrianCursor {
    const person = this.people[id] as AmbientPedestrian;
    out.id = id;
    out.at = mod(tick + person.phase, person.period);
    return out;
  }

  /** Step a cursor one tick along the loop. */
  advance(cursor: PedestrianCursor): void {
    const person = this.people[cursor.id] as AmbientPedestrian;
    cursor.at = cursor.at + 1 === person.period ? 0 : cursor.at + 1;
  }

  /** The pose a cursor stands at. */
  pose(cursor: PedestrianCursor, out: PedestrianPose): PedestrianPose {
    return this.poseOn(cursor.id, cursor.at, out);
  }

  /**
   * The pose of a person at a moment, which may fall between two ticks: the
   * renderer draws the crowd between the last two. At a whole tick it is
   * exactly the pose of the cursor there.
   */
  poseAt(id: number, time: number, out: PedestrianPose): PedestrianPose {
    const person = this.people[id] as AmbientPedestrian;
    return this.poseOn(id, mod(time + person.phase, person.period), out);
  }

  /**
   * The edge a person walks at a moment, which is what a caller skips a far
   * person by before it reads the pose.
   */
  edgeAt(id: number, time: number): number {
    const person = this.people[id] as AmbientPedestrian;
    const route = person.route;
    const distance = (mod(time + person.phase, person.period) * route.length) / person.period;
    let lo = 0;
    let hi = route.start.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((route.start[mid] as number) <= distance) lo = mid;
      else hi = mid - 1;
    }
    return route.edges[lo] as number;
  }

  /** True when an edge, grown by the reach of its pavements and corners, overlaps a box. */
  edgeMeets(edge: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
    return this.index.meets(edge, minX, minY, maxX, maxY);
  }

  /** The ids of every person whose loop passes through a box, ascending. */
  near(minX: number, minY: number, maxX: number, maxY: number, out: number[]): number[] {
    return this.index.near(minX, minY, maxX, maxY, out);
  }

  /**
   * Take everyone within `radius` of a place off their loops at a tick, as the
   * reaction asks. A person already startled keeps the reaction they have.
   * `flee` runs straight away from the place; `scatter` jumps aside, to
   * whichever side of the threat's line they already stand on; `gather` walks
   * a few steps to the place and stands facing it. Answers how many reacted.
   */
  startle(state: PedestrianState, tick: number, x: number, y: number, radius: number, reaction: Reaction, ids: number[] = []): number {
    const pose: PedestrianPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' };
    let count = 0;
    for (const id of this.near(x - radius, y - radius, x + radius, y + radius, ids)) {
      if (startledOf(state, id) !== undefined) continue;
      this.poseAt(id, tick, pose);
      const dx = pose.x - x;
      const dy = pose.y - y;
      if (dx * dx + dy * dy > radius * radius) continue;
      let heading = dx === 0 && dy === 0 ? pose.heading + Math.PI : atan2(dy, dx);
      if (reaction === 'scatter') {
        // A quarter turn off the line from the threat, and a little more or less.
        const across = dx * sin(pose.heading) - dy * cos(pose.heading) >= 0 ? -1 : 1;
        const rng = rngFor(this.seed, tick, Subsystem.Pedestrians, hashInts(REACTION_STREAM, id));
        heading = pose.heading + across * (Math.PI / 2 + rng.range(-0.4, 0.4));
      } else if (REACTIONS[reaction].toward) {
        heading += Math.PI;
      }
      addStartled(state, { id, reaction, since: tick, x: pose.x, y: pose.y, height: pose.height, heading });
      count++;
    }
    return count;
  }

  private poseOn(id: number, at: number, out: PedestrianPose): PedestrianPose {
    const person = this.people[id] as AmbientPedestrian;
    const route = person.route;
    const pace = route.length / person.period;
    const distance = at * pace;
    this.pavements.sample(route, person.side, distance - HALF_STEP, this.behind);
    this.pavements.sample(route, person.side, distance + HALF_STEP, this.ahead);
    out.x = (this.behind.x + this.ahead.x) / 2;
    out.y = (this.behind.y + this.ahead.y) / 2;
    out.height = (this.behind.height + this.ahead.height) / 2;
    out.heading = atan2(this.ahead.y - this.behind.y, this.ahead.x - this.behind.x);
    out.speed = pace * TICK_RATE;
    const cycles = (at / person.period) * person.strides;
    out.cycle = cycles - Math.floor(cycles);
    out.gait = person.look.gait;
    return out;
  }

  /** Put the people of one directed run of pavement road down, and lay out each one's loop. */
  private place(edge: RoadEdge, district: Pick<District, 'zone' | 'density'>, roads: TrafficRoads, people: AmbientPedestrian[]): void {
    const graph = roads.graph;
    const busy = ZONE_PEDESTRIANS[district.zone] * (0.5 + 0.5 * district.density);
    const expected = (edge.length / 1000) * TIERS[edge.tier].walkers * busy;
    const rng = rngFor(this.seed, 0, Subsystem.Pedestrians, hashInts(EDGE_STREAM, edge.id));
    const count = Math.floor(expected + rng.float());
    for (let j = 0; j < count; j++) {
      const id = people.length;
      const walk = rngFor(this.seed, 0, Subsystem.Pedestrians, hashInts(PERSON_STREAM, id));
      const look = lookOf(district.zone, walk);
      const side = walk.chance(0.5) ? 1 : -1;
      const route = this.pavements.route(loopFrom(graph, edge.id, walk), side);
      const period = Math.max(1, Math.round((route.length / look.speed) * TICK_RATE));
      const strides = Math.max(1, Math.round(route.length / strideOf(look.gait, look.height)));
      // Somewhere along the run they were placed on, which is the first leg of the loop.
      const offset = (j + walk.range(0.2, 0.8)) / count;
      const along = offset * (route.toCorner[0] as number);
      const phase = Math.floor((along / route.length) * period) % period;
      people.push({ id, look, side, phase, period, strides, route });
      for (const e of route.edges) this.index.file(id, e);
    }
  }
}

/**
 * Where a startled person is at a tick: moving off the way they reacted to for
 * as long as the reaction lasts, then standing where it left them.
 */
export function startledPose(record: StartledPedestrian, time: number, out: PedestrianPose): PedestrianPose {
  const reaction = REACTIONS[record.reaction];
  const elapsed = Math.min(Math.max(0, time - record.since), reaction.ticks);
  const moving = time - record.since < reaction.ticks;
  const distance = (elapsed / TICK_RATE) * reaction.speed;
  out.x = record.x + cos(record.heading) * distance;
  out.y = record.y + sin(record.heading) * distance;
  out.height = record.height;
  out.heading = record.heading;
  out.speed = moving ? reaction.speed : 0;
  const cycles = distance / strideOf(reaction.gait, 1.75);
  out.cycle = moving ? cycles - Math.floor(cycles) : 0;
  out.gait = moving ? reaction.gait : 'stand';
  return out;
}

/**
 * Let go of every startled person further than `distance` from a place at a
 * tick. They go back to their loops, which is seen only where nobody is
 * looking.
 */
export function releaseFar(state: PedestrianState, time: number, x: number, y: number, distance: number): void {
  const pose: PedestrianPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' };
  state.startled = state.startled.filter((record) => {
    startledPose(record, time, pose);
    return hypot(pose.x - x, pose.y - y) <= distance;
  });
}

/** Add a startled person, keeping the list in id order. */
function addStartled(state: PedestrianState, record: StartledPedestrian): void {
  let i = state.startled.length;
  while (i > 0 && (state.startled[i - 1] as StartledPedestrian).id > record.id) i--;
  state.startled.splice(i, 0, record);
}

/**
 * The loop a person walks from the run they were placed on. The walk of the
 * traffic may close its loop some way off; a person walks out to that loop,
 * round it, and back the way they came, so the loop starts on their own run
 * and they stay a person of their district.
 */
function loopFrom(graph: RoadGraph, first: number, rng: Rng): number[] {
  const { route, loop } = walkOut(graph, first, rng, walkable, WALK_REACH, WALK_LOOP);
  if (loop === 0) return route;
  const out = loop < 0 ? route : route.slice(0, loop);
  return route.concat(backOf(graph, out));
}

/** True for a run people walk: a tier with a pavement, not bored through the ground. */
function walkable(edge: RoadEdge): boolean {
  return TIERS[edge.tier].walkers > 0 && TIERS[edge.tier].pavement > 0 && !edge.tunnel;
}

function midpoint(roads: readonly RoadCurve[], edge: RoadEdge): Point {
  const points = (roads[edge.curve] as RoadCurve).points;
  return points[(edge.start + edge.end) >> 1] as Point;
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}
