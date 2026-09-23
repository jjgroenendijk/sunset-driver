/**
 * Ambient traffic (spec sections 5.3, 13.1): every vehicle of the city's
 * traffic as a function of `(seed, tick)` and a stable id.
 *
 * The vehicles are placed once for a world. Each directed run of road gets a
 * number of them from its tier's density and the district it runs through,
 * each in a lane on the right-hand side of the carriageway. Each vehicle then
 * drives the loop `traffic-tour.ts` walks for it, at the speed limit of the
 * road it is on, and stops where a traffic light (`signals.ts`) is red. Each
 * carries a driver from `driver.ts` (spec section 20.2), and its tour is timed
 * the way that driver drives: their speed, their gap in a queue, the moment
 * they take over a green, and whether they run an amber. No tour reads
 * another one, so the city's traffic never has to be stepped as a whole. Near
 * the player, `give-way.ts` holds a vehicle back on its tour so it keeps off
 * the others, and every reader there asks for the tick through `heldTime`.
 *
 * Where a vehicle is can be asked two ways, and they agree exactly:
 * {@link AmbientTraffic.cursorAt} evaluates it at any tick on demand, and
 * {@link AmbientTraffic.advance} steps a cursor one tick. The physics steps the
 * vehicles near the player and evaluates the ones that come into range; the
 * renderer evaluates between two ticks. Nothing here is simulation state. The
 * record only holds the vehicles the player has touched, in
 * {@link TrafficState}, because from then on the physics owns them.
 */
import { hashInts } from '../core/hash.ts';
import { rngFor, Subsystem, type Rng } from '../core/rng.ts';
import { atan2, cos, sin } from '../core/libm.ts';
import { RoadBeds } from '../world/bed.ts';
import { layoutZones, districtAt } from '../world/districts.ts';
import { buildRoadGraph, type RoadEdge, type RoadGraph } from '../world/graph.ts';
import { buildJunctions, type JunctionMap } from '../world/junctions.ts';
import { TIERS, TRAM_LANE } from '../world/tiers.ts';
import type { Point, RoadCurve, RoadTier, TramDescription, TramStop, WorldDescription, Zone } from '../world/types.ts';
import { busDemandOf, type BusDemand } from './bus.ts';
import { TICK_RATE } from './clock.ts';
import { drawDriver, type Driver } from './driver.ts';
import { createHolds, type Holds } from './hold.ts';
import { EdgeIndex } from './edge-index.ts';
import { PoseMemo } from './pose-memo.ts';
import { heightOff, RouteSampler, type BedTilt, type RoutePoint } from './route-sample.ts';
import { SIGNAL_CYCLE, TrafficSignals } from './signals.ts';
import { legAt, timeTour, walkTour, type Permit, type Tour } from './traffic-tour.ts';
import { tramGuardOf, type TramGuard } from './tram-guard.ts';
import { specOf, type VehicleClass, type VehicleState } from './vehicle.ts';

/** Metres each way of one bucket of the index that says which vehicles can be near a place. */
export const TRAFFIC_CELL = 100;

/**
 * Metres behind and ahead of a vehicle its pose is read at. The vehicle stands
 * between the two readings and faces from one to the other, so it takes a
 * corner as a curve rather than snapping round at the node.
 */
export const SMOOTH = 4;

/** Metres a vehicle may stand off the line of its road: its lane and the corner it cuts. */
const REACH = 16;

/** How busy each zone's roads are, as a share of the tier's density. */
export const ZONE_TRAFFIC: Record<Zone, number> = {
  core: 1,
  inner: 0.85,
  industrial: 0.6,
  suburban: 0.45,
  outskirts: 0.25,
  wilderness: 0.15,
};

/**
 * The classes of the roster each tier's traffic is made of, and how often each
 * comes up. The patrol car, the boat and the buggy are not ambient traffic.
 */
export const TIER_MIX: Record<RoadTier, Partial<Record<VehicleClass, number>>> = {
  highway: { saloon: 4, compact: 2, sports: 2, van: 2, truck: 2, bus: 1 },
  arterial: { saloon: 4, compact: 3, sports: 1, van: 2, truck: 1, bus: 1, motorcycle: 1 },
  street: { compact: 4, saloon: 3, sports: 1, van: 1, motorcycle: 1, offroad: 1 },
  alley: { compact: 3, van: 2, motorcycle: 1 },
  dirt: { offroad: 4, truck: 2, van: 1, compact: 1 },
};

/** Every class that drives in ambient traffic, in roster order. */
export const AMBIENT_CLASSES: readonly VehicleClass[] = [
  'compact',
  'saloon',
  'sports',
  'van',
  'truck',
  'bus',
  'motorcycle',
  'offroad',
];

/** The paints a car of the traffic comes in. A bus keeps the livery of its row. */
export const PAINTS: readonly number[] = [
  0x3f7d63, 0xb8352c, 0xe0b13a, 0xd8d4c8, 0x2f5d86, 0x1f1f24, 0x8a8f96, 0x6b2f4a, 0xf2f4f5, 0x4a5a3a, 0xc4592f, 0x27404f,
];

/** The keys of the two streams traffic draws from, so neither shifts the other. */
const EDGE_STREAM = 1;
const VEHICLE_STREAM = 2;

/** The road network as traffic needs it. */
export interface TrafficRoads {
  roads: readonly RoadCurve[];
  graph: RoadGraph;
  /** How busy the roads at a place are, 0 to 1. Everywhere as busy as the core when left out. */
  busyAt?(x: number, y: number): number;
  /** The height the road drives at, `t` along a segment of a curve that stands at `(x, y)`. */
  heightAt(curve: number, segment: number, t: number, x: number, y: number): number;
  /** How the road surface tilts there, inside a junction's mouth. Level across everywhere when left out. */
  tiltAt?: BedTilt;
  /** The junctions, which is where the traffic lights stand. No lights when left out. */
  junctions?: JunctionMap;
  /**
   * The tram line (spec section 13.2): the runs it drives, whose middle the
   * traffic keeps out of, and the level crossings, each of which takes a light.
   * No tram when left out.
   */
  tram?: Pick<TramDescription, 'edges' | 'crossings' | 'stops'>;
}

/** One vehicle of the traffic: what it is, who is driving it and the loop it drives. */
export interface AmbientVehicle {
  id: number;
  cls: VehicleClass;
  paint: number;
  /** Lanes out from the middle of the road, 0 nearest it. A road with fewer lanes uses its outermost. */
  lane: number;
  /** The tick of its tour it stands at on tick 0. */
  phase: number;
  /** Who is behind the wheel (spec section 20.2). Its tour was timed the way they drive. */
  driver: Driver;
  tour: Tour;
}

/** Where on its tour a vehicle is: the step, and the whole ticks it has spent on it. */
export interface TrafficCursor {
  id: number;
  step: number;
  into: number;
}

/** A vehicle placed on the map. `y` is the map's; `height` is up. */
export interface AmbientPose {
  x: number;
  y: number;
  /** The road under the middle of the vehicle. */
  height: number;
  heading: number;
  /** Metres per second along the heading. */
  speed: number;
}

/** A vehicle the player has touched, and the record the physics now keeps of it (spec section 5.3). */
export interface PromotedVehicle {
  id: number;
  /** The colour it was painted while it drove its tour or stood in its bay. */
  paint: number;
  vehicle: VehicleState;
}

/** What the simulation record holds of the traffic: only what has left its trajectory. */
export interface TrafficState {
  /** Ascending by id. */
  promoted: PromotedVehicle[];
  /** The vehicles near the player that giving way has held behind their tours (`give-way.ts`). */
  held: Holds;
}

export function createTrafficState(): TrafficState {
  return { promoted: [], held: createHolds() };
}

/** The record of a promoted vehicle, or undefined while it still drives its tour. */
export function promotedOf(state: TrafficState, id: number): PromotedVehicle | undefined {
  const list = state.promoted;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = (list[mid] as PromotedVehicle).id;
    if (at === id) return list[mid];
    if (at < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** Add a promoted vehicle, keeping the list in id order. */
export function addPromoted(state: TrafficState, promoted: PromotedVehicle): void {
  let i = state.promoted.length;
  while (i > 0 && (state.promoted[i - 1] as PromotedVehicle).id > promoted.id) i--;
  state.promoted.splice(i, 0, promoted);
}

/** One reading along a tour: a point in the lane, and the road height under it. */
interface Sample {
  x: number;
  y: number;
  height: number;
}

export class AmbientTraffic {
  readonly vehicles: readonly AmbientVehicle[];
  /** The traffic lights the vehicles stop at; undefined when the roads came without junctions. */
  readonly signals: TrafficSignals | undefined;
  /** The turns held while a tram crosses them (`tram-guard.ts`); undefined without a tram or lights. */
  readonly guard: TramGuard | undefined;
  readonly roads: TrafficRoads;
  /**
   * How many people the stop on each leg gathers (`bus.ts`). It is held here
   * because two readers have to agree on it: the timing, which stands a bus at
   * the kerb for as long as they take to board, and `bus-stops.ts`, which
   * draws them standing there.
   */
  readonly demand: BusDemand;
  private readonly sampler: RouteSampler;
  private readonly point: RoutePoint;
  /** 1 on each run the tram drives either way, and {@link PLATFORM_LANE} where it also calls. */
  private readonly tramLane: Uint8Array;
  /** Which vehicles can be near a place: each is filed under the edges of its tour. */
  private readonly index: EdgeIndex;
  private readonly behind: Sample = { x: 0, y: 0, height: 0 };
  private readonly ahead: Sample = { x: 0, y: 0, height: 0 };
  private readonly memo: PoseMemo;

  constructor(seed: number, roads: TrafficRoads) {
    this.roads = roads;
    const graph = roads.graph;
    this.index = new EdgeIndex(roads.roads, graph, REACH, TRAFFIC_CELL);
    this.sampler = new RouteSampler(roads.roads, graph, roads.heightAt, roads.tiltAt);
    this.point = { x: 0, y: 0, height: 0, tiltX: 0, tiltY: 0, rightX: 0, rightY: 0, edge: graph.edges[0] as RoadEdge };
    this.tramLane = tramLaneOf(graph, roads.tram?.edges ?? [], roads.tram?.stops ?? []);

    const junctions = roads.junctions;
    const crossings = (roads.tram?.crossings ?? []).map((crossing) => crossing.node);
    this.signals = junctions === undefined ? undefined : new TrafficSignals(seed, roads.roads, graph, junctions, roads.heightAt, crossings);
    this.guard = tramGuardOf(graph, this.signals, roads.tram);
    const busy = new Float64Array(graph.edges.length);
    for (const edge of graph.edges) {
      const mid = this.midpoint(edge);
      busy[edge.id] = roads.busyAt?.(mid.x, mid.y) ?? 1;
    }
    this.demand = busDemandOf(seed, (edge) => busy[edge.id] as number);
    const vehicles: AmbientVehicle[] = [];
    for (const edge of graph.edges) this.place(seed, edge, busy, vehicles);
    this.vehicles = vehicles;
    this.memo = new PoseMemo(vehicles.length);
  }

  /** Where a vehicle is on its tour at a tick, evaluated without stepping it there. */
  cursorAt(id: number, tick: number, out: TrafficCursor = { id, step: 0, into: 0 }): TrafficCursor {
    const vehicle = this.vehicles[id] as AmbientVehicle;
    const tour = vehicle.tour;
    const at = (((tick + vehicle.phase) % tour.period) + tour.period) % tour.period;
    out.id = id;
    out.step = legAt(tour.stepStart, at);
    out.into = at - (tour.stepStart[out.step] as number);
    return out;
  }

  /** Step a cursor one tick along its tour. */
  advance(cursor: TrafficCursor): void {
    const tour = (this.vehicles[cursor.id] as AmbientVehicle).tour;
    cursor.into += 1;
    if (cursor.into < (tour.stepTicks[cursor.step] as number)) return;
    cursor.into = 0;
    cursor.step = (cursor.step + 1) % tour.stepTicks.length;
  }

  /** The pose a cursor stands at. */
  pose(cursor: TrafficCursor, out: AmbientPose): AmbientPose {
    return this.poseOn(cursor.id, cursor.step, cursor.into, out);
  }

  /**
   * The pose of a vehicle at a tick, which may fall between two ticks: the
   * renderer draws the traffic between the last two. At a whole tick it is
   * exactly the pose of the cursor there.
   */
  poseAt(id: number, tick: number, out: AmbientPose): AmbientPose {
    const vehicle = this.vehicles[id] as AmbientVehicle;
    const tour = vehicle.tour;
    const at = (((tick + vehicle.phase) % tour.period) + tour.period) % tour.period;
    const step = legAt(tour.stepStart, at);
    return this.poseOn(id, step, at - (tour.stepStart[step] as number), out);
  }

  /** The edge a cursor is driving, which is what a caller skips a far vehicle by. */
  edgeOf(cursor: TrafficCursor): number {
    const tour = (this.vehicles[cursor.id] as AmbientVehicle).tour;
    return tour.edges[tour.stepLeg[cursor.step] as number] as number;
  }

  /** Metres along its edge a cursor stands at. */
  metresOf(cursor: TrafficCursor): number {
    const tour = (this.vehicles[cursor.id] as AmbientVehicle).tour;
    const from = tour.stepFrom[cursor.step] as number;
    const to = tour.stepTo[cursor.step] as number;
    return from + (cursor.into / (tour.stepTicks[cursor.step] as number)) * (to - from);
  }

  /** True when a cursor's step is a wait: at a light, in a queue or at a stop. */
  isWait(cursor: TrafficCursor): boolean {
    const tour = (this.vehicles[cursor.id] as AmbientVehicle).tour;
    return tour.stepFrom[cursor.step] === tour.stepTo[cursor.step];
  }

  /** Ticks a cursor stands still for from here, or 0 where its step is a drive. */
  waitLeft(cursor: TrafficCursor): number {
    if (!this.isWait(cursor)) return 0;
    const tour = (this.vehicles[cursor.id] as AmbientVehicle).tour;
    return (tour.stepTicks[cursor.step] as number) - 1 - cursor.into;
  }

  /** True when an edge, grown by the reach of its lanes, overlaps a box. */
  edgeMeets(edge: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
    return this.index.meets(edge, minX, minY, maxX, maxY);
  }

  /**
   * The ids of every vehicle whose tour passes through a box, ascending and
   * without repeats. Those are the only vehicles that can be in it at any tick.
   */
  near(minX: number, minY: number, maxX: number, maxY: number, out: number[]): number[] {
    return this.index.near(minX, minY, maxX, maxY, out);
  }

  private poseOn(id: number, step: number, into: number, out: AmbientPose): AmbientPose {
    const vehicle = this.vehicles[id] as AmbientVehicle;
    const tour = vehicle.tour;
    const leg = tour.stepLeg[step] as number;
    const ticks = tour.stepTicks[step] as number;
    const from = tour.stepFrom[step] as number;
    const metres = (tour.stepTo[step] as number) - from;
    // A whole tick is asked for many times over; the renderer's moments between ticks are not.
    const whole = Number.isInteger(into);
    const at = (tour.stepStart[step] as number) + into;
    if (!whole || !this.memo.read(id, at, out)) {
      const along = (tour.startDistance[leg] as number) + from + (into / ticks) * metres;
      this.sample(vehicle, along - SMOOTH, this.behind);
      this.sample(vehicle, along + SMOOTH, this.ahead);
      out.x = (this.behind.x + this.ahead.x) / 2;
      out.y = (this.behind.y + this.ahead.y) / 2;
      out.height = (this.behind.height + this.ahead.height) / 2;
      out.heading = atan2(this.ahead.y - this.behind.y, this.ahead.x - this.behind.x);
      if (whole) this.memo.write(id, at, out);
    }
    out.speed = (metres / ticks) * TICK_RATE;
    return out;
  }

  /** The point in a vehicle's lane a distance round its tour, and the road height there. */
  private sample(vehicle: AmbientVehicle, distance: number, out: Sample): void {
    const at = this.sampler.sample(vehicle.tour, distance, this.point);
    const reserved = this.tramLane[at.edge.id] as number;
    const offset = laneOffset(at.edge, vehicle.lane, reserved > 0, reserved === PLATFORM_LANE);
    // The right hand of the direction of travel, which is where the lane is.
    out.x = at.x + at.rightX * offset;
    out.y = at.y + at.rightY * offset;
    out.height = heightOff(at, offset);
  }

  /** Put the vehicles of one directed run of road down, and walk each its tour. */
  private place(seed: number, edge: RoadEdge, busy: Float64Array, vehicles: AmbientVehicle[]): void {
    const graph = this.roads.graph;
    const expected = (edge.length / 1000) * edge.lanes * TIERS[edge.tier].density * (busy[edge.id] as number);
    const rng = rngFor(seed, 0, Subsystem.Traffic, hashInts(EDGE_STREAM, edge.id));
    const count = Math.floor(expected + rng.float());
    for (let j = 0; j < count; j++) {
      const id = vehicles.length;
      const cls = pickClass(TIER_MIX[edge.tier], rng);
      const offset = ((j + rng.range(0.25, 0.75)) / count) * edge.length;
      const lane = rng.int(0, edge.lanes - 1);
      const paint = cls === 'bus' ? specOf(cls).paint : (PAINTS[rng.int(0, PAINTS.length - 1)] as number);
      const walk = rngFor(seed, 0, Subsystem.Traffic, hashInts(VEHICLE_STREAM, id));
      const route = walkTour(graph, edge.id, walk, permitOf(cls));
      // Its own place in every queue it joins, which is what holds it off the
      // vehicles that wait at the same lights, and the driver whose speed, gap,
      // reaction and nerve at an amber the whole lap is then timed to. A bus
      // also calls at the stops of its route (spec section 20.2), so its lap
      // carries the dwell at every kerb it pulls in at.
      const place = walk.float();
      const driver = drawDriver(walk);
      const tour = timeTour(graph, route, this.signals, { place, driver, calls: cls === 'bus', demand: this.demand }, this.guard);
      const phase = phaseOf(tour, tour.edges.indexOf(edge.id), offset, walk);
      vehicles.push({ id, cls, paint, lane, phase, driver, tour });
      for (const e of tour.edges) this.index.file(id, e);
    }
  }

  private midpoint(edge: RoadEdge): Point {
    const points = (this.roads.roads[edge.curve] as RoadCurve).points;
    return points[(edge.start + edge.end) >> 1] as Point;
  }
}

/**
 * The tick of its tour a vehicle stands at on tick 0: `offset` metres along
 * its home leg. A tour timed to the signals has to start on the tick of the
 * cycle it was timed from, so its vehicle is moved by at most half a cycle to
 * the nearest tick that does. That leaves few ticks of a lap a vehicle may
 * stand at, and the slot placement drew for it is lost. What keeps two
 * vehicles apart afterwards is the queue place `traffic-timing.ts` times each
 * tour from, not this.
 */
function phaseOf(tour: Tour, home: number, offset: number, rng: Rng): number {
  let at = -1;
  for (let i = 0; i < tour.stepLeg.length && at < 0; i++) {
    const from = tour.stepFrom[i] as number;
    const to = tour.stepTo[i] as number;
    if (tour.stepLeg[i] !== home || to <= from || offset < from || offset >= to) continue;
    at = (tour.stepStart[i] as number) + Math.floor(((offset - from) / (to - from)) * (tour.stepTicks[i] as number));
  }
  if (at < 0) at = rng.int(0, tour.period - 1);
  if (tour.sync < 0) return at;
  let shift = mod(-tour.sync - at, SIGNAL_CYCLE);
  if (shift >= SIGNAL_CYCLE / 2) shift -= SIGNAL_CYCLE;
  return mod(at + shift, tour.period);
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

/**
 * Metres from the centreline to the middle of a lane. The lanes of one
 * direction share the right half of the carriageway evenly, less the parking
 * strip at the kerb, as the markings of `road-section.ts` divide it. An alley
 * and a dirt road have one lane both ways share, and a vehicle keeps to its
 * right half of it. On a run the tram drives, the lanes also give up the
 * middle of the road, which is the tram's reserved lane (spec section 6.3),
 * and on one that carries a stop they give up the island platform beside it
 * too, so no car drives over the ground a passenger stands on.
 */
export function laneOffset(edge: Pick<RoadEdge, 'tier' | 'lanes'>, lane: number, tram = false, platform = false): number {
  const spec = TIERS[edge.tier];
  const inner = tram ? TRAM_LANE.halfWidth + (platform ? TRAM_LANE.platform : 0) : 0;
  const width = (spec.width / 2 - spec.parking - inner) / edge.lanes;
  return inner + (Math.min(lane, edge.lanes - 1) + 0.5) * width;
}

/** The flag of a run that carries a tram stop, whose island platform the traffic keeps off. */
const PLATFORM_LANE = 2;

/**
 * One flag per edge: 1 on the runs a tram drives, and on the same runs the
 * other way; {@link PLATFORM_LANE} on the runs it calls at, which give up the
 * platform as well. A tram halts at the end of the run before the one it leaves
 * on, so both of those carry the stop.
 */
function tramLaneOf(graph: RoadGraph, edges: readonly number[], stops: readonly TramStop[]): Uint8Array {
  const flags = new Uint8Array(graph.edges.length);
  const mark = (id: number | undefined, flag: number): void => {
    const edge = id === undefined ? undefined : graph.edges[id];
    if (edge === undefined) return;
    flags[edge.id] = Math.max(flags[edge.id] as number, flag);
    if (edge.twin >= 0) flags[edge.twin] = Math.max(flags[edge.twin] as number, flag);
  };
  for (const id of edges) mark(id, 1);
  for (const stop of stops) {
    mark(edges[stop.leaves], PLATFORM_LANE);
    mark(edges[(stop.leaves + edges.length - 1) % edges.length], PLATFORM_LANE);
  }
  return flags;
}

/** Which tiers a class may drive: a truck and a bus keep to the tiers that let them on. */
export function permitOf(cls: VehicleClass): Permit {
  if (cls === 'truck') return (edge) => TIERS[edge.tier].traffic.trucks;
  if (cls === 'bus') return (edge) => TIERS[edge.tier].traffic.buses;
  return () => true;
}

function pickClass(mix: Partial<Record<VehicleClass, number>>, rng: Rng): VehicleClass {
  let total = 0;
  for (const cls of AMBIENT_CLASSES) total += mix[cls] ?? 0;
  let pick = rng.float() * total;
  for (const cls of AMBIENT_CLASSES) {
    pick -= mix[cls] ?? 0;
    if (pick < 0) return cls;
  }
  return 'saloon';
}

/** A vehicle or a person seen from above: a box about its middle, turned to a heading. */
export interface Footprint {
  x: number;
  y: number;
  heading: number;
  halfLength: number;
  halfWidth: number;
}

/**
 * True when two footprints overlap or stand within `margin` of each other.
 * The separating-axis test on the four sides of the two boxes, which is exact
 * for two rectangles.
 */
export function footprintsTouch(a: Footprint, b: Footprint, margin: number): boolean {
  const ca = cos(a.heading);
  const sa = sin(a.heading);
  const cb = cos(b.heading);
  const sb = sin(b.heading);
  // Each box's length and then its width: the axis a quarter turn on is (-sin, cos).
  return (
    overlapsAlong(a, b, ca, sa, cb, sb, ca, sa, margin) &&
    overlapsAlong(a, b, ca, sa, cb, sb, -sa, ca, margin) &&
    overlapsAlong(a, b, ca, sa, cb, sb, cb, sb, margin) &&
    overlapsAlong(a, b, ca, sa, cb, sb, -sb, cb, margin)
  );
}

/**
 * True when the two boxes overlap along one axis, grown by the margin.
 * `ca, sa` and `cb, sb` are the cosine and sine of their headings.
 */
function overlapsAlong(a: Footprint, b: Footprint, ca: number, sa: number, cb: number, sb: number, ax: number, ay: number, margin: number): boolean {
  const reach = extent(a, ca, sa, ax, ay) + extent(b, cb, sb, ax, ay) + margin;
  return Math.abs((b.x - a.x) * ax + (b.y - a.y) * ay) <= reach;
}

/** Half the length of a box heading along `(fx, fy)` along an axis. */
function extent(box: Footprint, fx: number, fy: number, ax: number, ay: number): number {
  return box.halfLength * Math.abs(fx * ax + fy * ay) + box.halfWidth * Math.abs(-fy * ax + fx * ay);
}

/**
 * The road network of a generated world as traffic reads it: the graph, how
 * busy each district is, the height of each road's bed, so a vehicle on a
 * bridge drives on the deck, the junctions the traffic lights stand at, and
 * the tram line.
 */
export function trafficRoadsOf(
  world: WorldDescription,
  graph: RoadGraph = buildRoadGraph(world.roads),
  beds?: RoadBeds,
  junctions: JunctionMap = buildJunctions(world.roads, graph),
): TrafficRoads {
  const bed = beds ?? new RoadBeds(world.terrain, world.roads, junctions);
  const zones = layoutZones(world.size, world.core, world.water);
  return {
    roads: world.roads,
    graph,
    busyAt: (x, y) => {
      const district = districtAt(world.districts, zones, x, y);
      return ZONE_TRAFFIC[district.zone] * (0.6 + 0.4 * district.density);
    },
    heightAt: (curve, segment, t) => bed.heightAt(curve, segment, t),
    tiltAt: (curve, segment, t) => bed.profileAt(curve, segment, t),
    junctions,
    tram: world.tram,
  };
}
