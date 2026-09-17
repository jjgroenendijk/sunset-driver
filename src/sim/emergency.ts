/**
 * The emergency services (spec section 20.3): the fire engines and the
 * ambulances that answer what happens in the city.
 *
 * What happens is written down as a call on the record: a fire where a vehicle
 * is alight, a casualty where a crash was bad enough to hurt somebody or a
 * blast went off. A call waits the district's own response time — the same one
 * the police of spec section 14 answer in — and is then given to a unit, which
 * comes in on a road away from the scene and is routed to it over the road
 * graph by `unit-route.ts`. A fire engine that reaches the scene puts out
 * everything the hose reaches (`fire.ts`), keeps hosing while it stands there,
 * and drives off again.
 *
 * The police are not here. They come out on the heat of `crime.ts`, which is
 * about the player, and these two come out on what has happened, which is not:
 * a car left burning across town draws an engine whether or not anybody is
 * watching.
 *
 * Everything is plain data stepped from `(seed, tick)` and the record, and the
 * units are stepped in id order, so a replayed session sends the same engines
 * down the same streets.
 */
import { rngFor, Subsystem } from '../core/rng.ts';
import { TICK_RATE } from './clock.ts';
import { douseFires, firesOf } from './fire.ts';
import { responseTicks, type DistrictAt } from './police.ts';
import type { SimState } from './simulation.ts';
import type { TrafficRoads } from './traffic.ts';
import { UnitRoads, type DrivePose } from './unit-route.ts';

/** What a unit is: the engine that answers a fire, or the ambulance that answers a casualty. */
export type EmergencyKind = 'engine' | 'ambulance';

/** What a unit is doing. */
export type EmergencyTask =
  /** Driving at the scene it was given. */
  | 'respond'
  /** Standing at the scene and working it. */
  | 'work'
  /** Done, and driving back out of the city. */
  | 'leave';

/** Something that has happened and wants answering. */
export interface EmergencyCall {
  id: number;
  kind: EmergencyKind;
  /** Where it happened. */
  x: number;
  y: number;
  /** The tick it came in, which the response time is measured from. */
  tick: number;
  /** The unit that has taken it, or -1 while none has. */
  unit: number;
}

/** One fire engine or ambulance, as the record carries it. */
export interface EmergencyUnit {
  id: number;
  kind: EmergencyKind;
  task: EmergencyTask;
  /** The call it is answering, or -1 once it has finished with one. */
  call: number;
  /** Where it stands on the map, and which way it faces. */
  x: number;
  y: number;
  heading: number;
  /** The road height under it. */
  height: number;
  /** Metres per second it covered over the last tick. */
  speed: number;
  /** The edges of the drive it is on, in order. */
  edges: number[];
  /** Metres covered along that drive. */
  distance: number;
  /** Metres along the drive it pulls up at, which is where the drive passes nearest its goal. */
  stop: number;
  /** The tick the drive was planned at, so it is planned again on a cadence. */
  planned: number;
  /** Where it is driving to. */
  goalX: number;
  goalY: number;
  /** The road it came in on, which is where it drives back to once it is done. */
  homeX: number;
  homeY: number;
  /** The tick it stops working the scene, or -1 while it has not reached one. */
  until: number;
}

/** What the services are answering and who is out (spec section 20.3). */
export interface EmergencyState {
  units: EmergencyUnit[];
  calls: EmergencyCall[];
  /** The id the next unit is given, so no two units of a session share one. */
  nextUnit: number;
  /** The id the next call is given. */
  nextCall: number;
  /** The earliest tick the next unit may come out on. */
  dispatchTick: number;
}

/** Metres per second each kind drives at. An engine is heavy; an ambulance is not. */
export const UNIT_SPEED: Record<EmergencyKind, number> = {
  engine: 22,
  ambulance: 28,
};

/** How much of a road's speed limit a unit drives, which is over it: the siren is on. */
const URGENCY = 1.15;

/**
 * Metres of an open call a new one folds into. A row of cars alight is one
 * scene, and a crash that goes on being crashed into is one call.
 */
export const CALL_RANGE = 25;

/** Metres from the scene a unit comes in at, which is well beyond what the camera shows. */
const SPAWN_RANGE = 320;

/** Metres a hose reaches from where the engine stands. */
export const HOSE_RANGE = 12;

/** Metres from the scene a unit counts as having arrived at it. */
const ARRIVE_RANGE = 10;

/** Ticks each kind works a scene before it leaves. */
export const WORK_TICKS: Record<EmergencyKind, number> = {
  engine: 18 * TICK_RATE,
  ambulance: 12 * TICK_RATE,
};

/** The most units of both services out at once. */
export const UNITS_OUT = 3;

/** Ticks between one dispatch and the next, on top of the district's response time. */
const DISPATCH_GAP = 3 * TICK_RATE;

/** Ticks a unit drives before its route is planned again. */
const REPLAN = 2 * TICK_RATE;

/** Ticks a call nobody could answer is kept before it is given up on. */
export const CALL_STALE = 5 * 60 * TICK_RATE;

/** Metres from the player a unit on its way out is taken off the map. */
const RETIRE_RANGE = 240;

/**
 * The severity of a crash an ambulance is called to, on the scale `damage.ts`
 * measures one in. It is the severity the crowd gathers at (spec section
 * 20.1): what is worth standing and watching is worth calling in.
 */
export const CALL_SEVERITY = 0.5;

export function createEmergencyState(): EmergencyState {
  return { units: [], calls: [], nextUnit: 0, nextCall: 0, dispatchTick: 0 };
}

/**
 * Call an ambulance to a place: a crash worth watching, or a blast. A call
 * within {@link CALL_RANGE} of one already open is the same scene, so a
 * firefight in one street does not bring out the whole service.
 */
export function callAmbulance(state: SimState, x: number, y: number): void {
  raiseCall(state, 'ambulance', x, y);
}

/** Add a call, unless the same scene is already on the record. */
function raiseCall(state: SimState, kind: EmergencyKind, x: number, y: number): void {
  const calls = state.emergency.calls;
  for (const call of calls) {
    if (call.kind !== kind) continue;
    if (Math.hypot(call.x - x, call.y - y) <= CALL_RANGE) return;
  }
  const id = state.emergency.nextCall;
  state.emergency.nextCall = id + 1;
  calls.push({ id, kind, x, y, tick: state.tick, unit: -1 });
}

/**
 * The services of one session: the roads their units drive and the districts
 * they answer from. Like the police, they hold no state of their own — it is
 * all on the record — so a save is loaded and the same engines carry on.
 */
export class EmergencyServices {
  private readonly roads: UnitRoads;
  private readonly districtAt: DistrictAt;
  private readonly pose: DrivePose = { x: 0, y: 0, height: 0, heading: 0 };
  /** The units that were out last tick, so the routes of the ones that have gone are forgotten. */
  private out: number[] = [];

  constructor(roads: TrafficRoads, districtAt: DistrictAt) {
    this.roads = new UnitRoads(roads);
    this.districtAt = districtAt;
  }

  /**
   * One tick of the whole service: what has happened, who is sent, and where
   * every unit gets to. `crash` is the severity the player's car took this
   * tick, which `physics.ts` has just measured.
   *
   * Called after the world has been stepped, so a unit answers the tick the
   * player has just driven and a fire is seen where the record left it.
   */
  step(state: SimState, crash = 0): void {
    this.listen(state, crash);
    this.dispatch(state);
    for (const unit of state.emergency.units) this.drive(state, unit);
    this.close(state);
    this.retire(state);
    this.sweep(state);
  }

  /** What has happened this tick: the fires on the record, and the crash the player took. */
  private listen(state: SimState, crash: number): void {
    for (const fire of firesOf(state)) raiseCall(state, 'engine', fire.x, fire.y);
    if (crash >= CALL_SEVERITY) callAmbulance(state, state.vehicle.x, state.vehicle.z);
  }

  /**
   * Send a unit to the oldest call nobody has taken, once the district has had
   * time to answer it. The unit comes in on a road {@link SPAWN_RANGE} from the
   * scene, on a bearing of its own stream, so it arrives from a different
   * quarter each time.
   */
  private dispatch(state: SimState): void {
    const service = state.emergency;
    if (service.units.length >= UNITS_OUT || state.tick < service.dispatchTick) return;
    const call = this.waiting(state);
    if (call === undefined) return;
    const id = service.nextUnit;
    const rng = rngFor(state.seed, state.tick, Subsystem.Emergency, id);
    const bearing = rng.float() * Math.PI * 2;
    const unit = this.raise(id, call, call.x + Math.cos(bearing) * SPAWN_RANGE, call.y + Math.sin(bearing) * SPAWN_RANGE);
    if (unit === undefined) return;
    service.nextUnit = id + 1;
    service.units.push(unit);
    call.unit = id;
    service.dispatchTick = state.tick + DISPATCH_GAP;
  }

  /** The oldest call nobody is on and the district has had time to answer, if there is one. */
  private waiting(state: SimState): EmergencyCall | undefined {
    for (const call of state.emergency.calls) {
      if (call.unit >= 0) continue;
      if (state.tick - call.tick < responseTicks(this.districtAt(call.x, call.y))) continue;
      return call;
    }
    return undefined;
  }

  /**
   * A unit standing on the road nearest a place, or undefined where there is
   * no road to come in on: a fire out in the wilderness is one nobody answers.
   */
  private raise(id: number, call: EmergencyCall, x: number, y: number): EmergencyUnit | undefined {
    const edge = this.roads.edgeNear(x, y);
    if (edge < 0) return undefined;
    const unit: EmergencyUnit = {
      id,
      kind: call.kind,
      task: 'respond',
      call: call.id,
      x,
      y,
      heading: 0,
      height: 0,
      speed: 0,
      edges: [edge],
      distance: 0,
      stop: 0,
      planned: -REPLAN,
      goalX: call.x,
      goalY: call.y,
      homeX: x,
      homeY: y,
      until: -1,
    };
    this.roads.pose(id, unit.edges, 0, this.pose);
    unit.x = this.pose.x;
    unit.y = this.pose.y;
    unit.height = this.pose.height;
    unit.heading = this.pose.heading;
    unit.homeX = this.pose.x;
    unit.homeY = this.pose.y;
    return unit;
  }

  /** One tick of a unit: what it is doing, and where the road it is on takes it. */
  private drive(state: SimState, unit: EmergencyUnit): void {
    // The route first, so a unit that has just come out or just been given a
    // new goal is judged against the drive it is really on. A unit standing at
    // a scene is driving nowhere and needs none.
    const moving = unit.task !== 'work';
    if (moving && (state.tick - unit.planned >= REPLAN || unit.distance >= unit.stop)) this.replan(state, unit);
    // A unit has arrived when it has driven as near the scene as its route
    // goes, or when it is within reach of it: the nodes a route is planned
    // between are a block apart, so the two are rarely the same place.
    const arrived = unit.distance >= unit.stop || Math.hypot(unit.x - unit.goalX, unit.y - unit.goalY) <= ARRIVE_RANGE;
    if (unit.task === 'respond' && arrived) {
      unit.task = 'work';
      unit.until = state.tick + WORK_TICKS[unit.kind];
    }
    if (unit.task === 'work') {
      // The hose goes on playing over the scene while the engine stands there,
      // so a fire that reaches the next car along is put out too.
      if (unit.kind === 'engine') douseFires(state, unit.x, unit.y, HOSE_RANGE);
      if (state.tick >= unit.until) this.dismiss(state, unit);
      unit.speed = 0;
      return;
    }
    // A unit that has driven all the way home and is still in sight of the
    // player carries on out of it, rather than standing in the street or
    // vanishing where somebody is watching.
    if (unit.task === 'leave' && arrived) this.onward(state, unit);
    this.run(unit);
  }

  /** Let a unit go: the call it answered is finished with, and it drives back out. */
  private dismiss(state: SimState, unit: EmergencyUnit): void {
    for (let i = state.emergency.calls.length - 1; i >= 0; i--) {
      if ((state.emergency.calls[i] as EmergencyCall).id === unit.call) state.emergency.calls.splice(i, 1);
    }
    unit.task = 'leave';
    unit.call = -1;
    unit.goalX = unit.homeX;
    unit.goalY = unit.homeY;
    unit.until = -1;
    unit.planned = -REPLAN;
  }

  /**
   * Send a unit that has got home another {@link SPAWN_RANGE} the same way,
   * which is away from the player. It is taken off the map as soon as that
   * puts it out of sight, so this only ever runs where it would not have been.
   */
  private onward(state: SimState, unit: EmergencyUnit): void {
    const p = state.player;
    const x = p.driving ? state.vehicle.x : p.x;
    const y = p.driving ? state.vehicle.z : p.y;
    const away = Math.hypot(unit.x - x, unit.y - y);
    const dirX = away > 0 ? (unit.x - x) / away : Math.cos(unit.heading);
    const dirY = away > 0 ? (unit.y - y) / away : Math.sin(unit.heading);
    unit.goalX = unit.x + dirX * SPAWN_RANGE;
    unit.goalY = unit.y + dirY * SPAWN_RANGE;
    unit.homeX = unit.goalX;
    unit.homeY = unit.goalY;
    unit.planned = -REPLAN;
  }

  /** Run a unit along its route, planning it again where it is due or has run out of road. */
  private run(unit: EmergencyUnit): void {
    const limit = this.roads.limitAt(unit.id, unit.edges, unit.distance);
    const speed = Math.min(UNIT_SPEED[unit.kind], limit * URGENCY);
    const was = unit.distance;
    unit.distance = Math.min(unit.distance + speed / TICK_RATE, unit.stop);
    this.roads.pose(unit.id, unit.edges, unit.distance, this.pose);
    unit.x = this.pose.x;
    unit.y = this.pose.y;
    unit.height = this.pose.height;
    // A unit that has pulled up keeps the heading it arrived on rather than
    // reading one off a line it is no longer moving along.
    if (unit.distance > was) unit.heading = this.pose.heading;
    unit.speed = (unit.distance - was) * TICK_RATE;
  }

  /**
   * Route a unit to its goal from the road it is on, so it finishes the run it
   * is driving rather than turning round in the street. A goal the graph cannot
   * be routed to leaves the drive as it was.
   */
  private replan(state: SimState, unit: EmergencyUnit): void {
    const from =
      unit.edges.length > 0
        ? this.roads.edgeAt(unit.id, unit.edges, unit.distance)
        : { edge: this.roads.edgeNear(unit.x, unit.y), into: 0 };
    if (from.edge < 0) return;
    const edges = this.roads.planBeside(from.edge, unit.goalX, unit.goalY);
    unit.planned = state.tick;
    if (edges === undefined) return;
    unit.edges = edges;
    unit.distance = from.into;
    unit.stop = Math.max(from.into, this.roads.nearestAlong(unit.id, edges, unit.goalX, unit.goalY));
  }

  /**
   * Drop the calls that are finished with: a fire that is out before anybody
   * reached it, and a call nobody has been able to answer for
   * {@link CALL_STALE}. A call a unit is on is left alone — the unit is what
   * closes it.
   */
  private close(state: SimState): void {
    const calls = state.emergency.calls;
    const fires = firesOf(state);
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i] as EmergencyCall;
      if (call.unit >= 0) continue;
      const alight = fires.some((fire) => Math.hypot(fire.x - call.x, fire.y - call.y) <= CALL_RANGE);
      if (call.kind === 'engine' && alight) continue;
      if (call.kind !== 'engine' && state.tick - call.tick < CALL_STALE) continue;
      calls.splice(i, 1);
    }
  }

  /** Take a unit on its way out off the map, once it is far enough away to go unseen. */
  private retire(state: SimState): void {
    const p = state.player;
    const x = p.driving ? state.vehicle.x : p.x;
    const y = p.driving ? state.vehicle.z : p.y;
    const units = state.emergency.units;
    for (let i = units.length - 1; i >= 0; i--) {
      const unit = units[i] as EmergencyUnit;
      if (unit.task !== 'leave') continue;
      if (Math.hypot(unit.x - x, unit.y - y) < RETIRE_RANGE) continue;
      units.splice(i, 1);
    }
  }

  /** Forget the route of every unit that is no longer out, so the cache does not grow. */
  private sweep(state: SimState): void {
    const ids = state.emergency.units.map((unit: EmergencyUnit) => unit.id);
    for (const id of this.out) {
      if (!ids.includes(id)) this.roads.forget(id);
    }
    this.out = ids;
  }
}
