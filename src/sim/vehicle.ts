/**
 * The vehicles of spec section 11.3: what one is made of, and its record.
 *
 * This holds three things and nothing else: the numbers one vehicle is made
 * of, the serialisable state of one vehicle, and what a tyre finds on each
 * surface. The rows of the roster are `roster.ts`, re-exported here, so this
 * file stays the one door onto the model. `physics.ts` turns them into a
 * Rapier body and either a `DynamicRayCastVehicleController` or the boat
 * controller; nothing here touches Rapier, so the whole roster can be read
 * headless.
 *
 * The vehicle's own frame has forward along local `+x`, up along `+y` and the
 * axle along `+z`, which is the frame the character model already uses: a yaw
 * of `-heading` about `y` points local `+x` along `(cos heading, sin heading)`
 * on the map. Map `y` is world `z`, as everywhere else in the renderer.
 *
 * A vehicle's class is carried in its state, so the record says what is being
 * driven and the body, the model and the handling are all rebuilt from it.
 */
import { atan2, cos, sin } from '../core/libm.ts';
import type { Surface } from '../world/surface.ts';
import { AIRCRAFT_CLASSES, type AircraftClass } from '../world/types.ts';
import { createDamageState, type DamageState } from './damage.ts';
import { ROAD_TYRES } from './roster.ts';

// The rows live next door and come out through this file, so nothing outside
// `src/sim` needs to know which of the two holds what.
export { DEFAULT_CLASS, ROAD_TYRES, ROSTER, SALOON, specOf } from './roster.ts';

/**
 * The classes of spec section 11.3, in the order the debug picker shows them:
 * the ordinary cars first, then the big vehicles, then the specials, then the
 * aircraft of `aircraft-roster.ts`.
 */
export type VehicleClass =
  | 'compact'
  | 'saloon'
  | 'sports'
  | 'van'
  | 'truck'
  | 'bus'
  | 'motorcycle'
  | 'offroad'
  | 'buggy'
  | 'emergency'
  | 'boat'
  | AircraftClass;

/** Every class, in picker order. Nothing else should list them. */
export const VEHICLE_CLASSES: readonly VehicleClass[] = [
  'compact',
  'saloon',
  'sports',
  'van',
  'truck',
  'bus',
  'motorcycle',
  'offroad',
  'buggy',
  'emergency',
  'boat',
  ...AIRCRAFT_CLASSES,
];

/** A wheel, where it sits on the chassis and what it is asked to do. */
export interface WheelSpec {
  /** Position on the chassis, in the vehicle's own frame. */
  x: number;
  y: number;
  z: number;
  /** True on a wheel the steering turns. */
  steered: boolean;
  /** True on a wheel the engine drives. */
  driven: boolean;
  /** True on a wheel the handbrake locks. */
  handbraked: boolean;
}

/**
 * What a vehicle's tyres are worth, as multipliers on {@link SURFACE_GRIP}.
 *
 * `grip` is what they are worth everywhere. `loose` is what they are worth on
 * top of that on dirt, open ground and sand, which is the one thing that
 * separates an off-roader and a beach buggy from a saloon: knobbly tyres take
 * back most of what loose ground costs and give away a little on tarmac.
 */
export interface TyreSpec {
  grip: number;
  loose: number;
}

/**
 * What a boat is made of (spec section 11.3). A hull has no wheels: it floats,
 * it is pushed from the stern and it is turned by a rudder that only bites
 * while water is flowing past it.
 */
export interface HullSpec {
  /** Metres of hull below the waterline when it floats at rest. */
  draft: number;
  /**
   * Depths at which lift is taken, as fractions of the half length and half
   * width: four points, one at each quarter of the hull, so the boat pitches
   * and rolls rather than bobbing as a point.
   */
  liftLength: number;
  liftWidth: number;
  /** How much of the boat's weight one fully submerged point carries. */
  buoyancy: number;
  /** How much of the vertical speed the water takes back, per second. */
  heave: number;
  /** Newtons the propeller puts through the stern at a standstill. */
  thrust: number;
  /** Metres per second the hull can reach on flat water. */
  topSpeed: number;
  /** Astern is geared shorter: a fraction of the thrust and of the top speed. */
  reverse: number;
  /** How much of the speed the water takes back along the hull, per second. */
  waterDrag: number;
  /** The same across the hull, which is what makes a boat track rather than slide. */
  sideDrag: number;
  /** Newton-metres of yaw the rudder gives per unit of steering at {@link HullSpec.topSpeed}. */
  rudder: number;
}

/**
 * What an aircraft is made of (spec section 11.3). The flight is arcade: the
 * throttle and the steering work as they do in a car, the jump key climbs and
 * the sprint key descends. A rotor hovers; a wing needs {@link FlightSpec.stall}
 * of speed before it lifts, and sinks when it loses it.
 */
export interface FlightSpec {
  /** A rotor hovers and flies any way it points; a wing has to keep moving. */
  kind: 'rotor' | 'wing';
  /** Metres per second it reaches in level flight. */
  topSpeed: number;
  /** Metres per second squared the engine gives at a standstill. It falls away toward the top speed. */
  thrust: number;
  /** Metres per second a wing lifts its whole weight at, and zero on a rotor. */
  stall: number;
  /** Metres per second it climbs and descends at, with the key held. */
  climb: number;
  /** Radians per second it turns at, at full lock. */
  turn: number;
  /** Radians it banks into a turn at full lock, which is what the camera sees of it. */
  bank: number;
}

/** What one vehicle is made of. The roster of spec section 11.3 is a table of these. */
export interface VehicleSpec {
  /** The class this is the entry for. */
  cls: VehicleClass;
  /** What the debug picker and the HUD call it. */
  name: string;
  /** Kilograms of the whole vehicle. */
  mass: number;
  /** Half the body's length, height and width, in metres. */
  halfLength: number;
  halfHeight: number;
  halfWidth: number;
  wheelRadius: number;
  /** Metres of the wheel's width, for the model that is drawn on it. */
  wheelWidth: number;
  wheels: WheelSpec[];
  tyres: TyreSpec;
  /**
   * Newtons the engine puts through the driven wheels at a standstill. It falls
   * away as the vehicle nears {@link VehicleSpec.topSpeed}, which is what gives
   * the vehicle a top speed on the flat without a speed clamp: on a climb the
   * same force has the slope to fight, so the hill decides the speed instead.
   */
  enginePower: number;
  /** Metres per second the engine can reach on the flat. */
  topSpeed: number;
  /**
   * Reverse is geared shorter: a fraction of the top speed. It pulls with most
   * of the engine, so a car backs out of a three-point turn at a useful pace.
   */
  reverse: number;
  /** Newtons of braking the brake pedal and the handbrake apply at one wheel. */
  brakeForce: number;
  handbrakeForce: number;
  /** How much of the vehicle's speed the air takes back, per second per metre per second. */
  drag: number;
  /** Radians the steered wheels turn at a standstill. */
  maxSteer: number;
  /**
   * Fraction of {@link VehicleSpec.maxSteer} still available at
   * {@link VehicleSpec.topSpeed}. Steering that stayed at full lock would spin
   * the car at any speed worth driving at.
   */
  steerAtSpeed: number;
  /** Radians per second the steered wheels move toward the angle asked for. */
  steerRate: number;
  /** Suspension: rest length, spring rate, damping and travel, in metres and Rapier's own units. */
  suspensionRest: number;
  suspensionStiffness: number;
  suspensionCompression: number;
  suspensionRelaxation: number;
  suspensionTravel: number;
  maxSuspensionForce: number;
  /**
   * Newton-metres per radian of roll the rider puts in to stay upright, and
   * zero on anything a rider does not have to hold up. A two-wheeler stands on
   * a track of a few centimetres, which is enough to keep it off its side and
   * not enough to keep it steady; the rider is the rest of it.
   */
  balance: number;
  /**
   * True where the model draws one wheel per axle, on the centreline, whatever
   * the physics stands on. A motorcycle is the only row that sets it: it rides
   * on two wheels and the physics stands it on four at a track of a few
   * centimetres.
   */
  inline: boolean;
  /** Set on a boat, and undefined on everything that drives (spec section 11.3). */
  hull?: HullSpec;
  /** Set on an aircraft, and undefined on everything that stays on the ground or the water. */
  flight?: FlightSpec;
  /**
   * True on a vehicle with an alarm, and true on a luxury or high-end one.
   * Spec section 11.4 gives exactly these the hotwire minigame; everything
   * else is get in and go.
   */
  alarm: boolean;
  luxury: boolean;
  /** Body paint and the trim the model picks its details out in. */
  paint: number;
  trim: number;
}

/** Metres between the front and rear axles. Zero on a boat, which has none. */
export function wheelbaseOf(spec: VehicleSpec): number {
  if (spec.wheels.length === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const wheel of spec.wheels) {
    min = Math.min(min, wheel.x);
    max = Math.max(max, wheel.x);
  }
  return max - min;
}

/**
 * How high the middle of the body stands over the ground it rests on. On a
 * wheeled vehicle that is the ground; on a boat it is the waterline, and the
 * hull's draft is what stands below it.
 */
export function rideHeight(spec: VehicleSpec): number {
  if (spec.hull !== undefined) return spec.halfHeight - spec.hull.draft;
  // A helicopter stands on its skids, which are the bottom of its body.
  if (spec.wheels.length === 0) return spec.halfHeight;
  const wheel = spec.wheels[0] as WheelSpec;
  return spec.suspensionRest - wheel.y + spec.wheelRadius;
}

/**
 * What a tyre finds on one surface.
 *
 * `friction` is Rapier's tyre traction: how hard the wheel may push the vehicle
 * along before it slips, so it bounds acceleration and braking together.
 * `side` is how hard it resists being pushed sideways, which is what makes sand
 * and gravel slide. `roll` is the rolling resistance of the surface, as a
 * fraction of the weight on the wheel: loose ground drags on a wheel that is
 * only turning through it, which is why a car runs out of speed on sand long
 * before it does on tarmac.
 */
export interface SurfaceGrip {
  friction: number;
  side: number;
  roll: number;
}

/**
 * Grip by surface (spec section 11.3). Asphalt is the reference; a dirt road
 * gives away about a third of it, open ground a little more, and sand is what
 * a beach buggy is for.
 */
export const SURFACE_GRIP: Record<Surface, SurfaceGrip> = {
  asphalt: { friction: 2.2, side: 1, roll: 0.015 },
  dirt: { friction: 1.45, side: 0.62, roll: 0.05 },
  ground: { friction: 1.3, side: 0.55, roll: 0.07 },
  sand: { friction: 0.9, side: 0.38, roll: 0.14 },
};

/** True where the ground is loose, which is where knobbly tyres earn their keep. */
export function isLoose(surface: Surface): boolean {
  return surface !== 'asphalt';
}

/**
 * What is left of the grip when the surface is wet, as a fraction. A road
 * under standing water gives up a little over a third of what it had, which is
 * enough that a corner taken at a dry speed runs wide. `weather.ts` is what
 * sets the wetness, and `physics.ts` what hands it to the wheels.
 */
export const WET_GRIP = 0.62;

/**
 * The grip of a surface, with `wetness` from 0 (dry) to 1 (standing water) and
 * the tyres that are standing on it. Rolling resistance is the surface's alone:
 * it is what the ground drags out of a turning wheel, and a tyre compound does
 * not change it.
 */
export function gripOf(surface: Surface, wetness: number, tyres: TyreSpec = ROAD_TYRES): SurfaceGrip {
  const dry = SURFACE_GRIP[surface];
  const tyre = tyres.grip * (isLoose(surface) ? tyres.loose : 1);
  const wet = wetness > 0 ? 1 - (1 - WET_GRIP) * Math.min(1, wetness) : 1;
  const scale = tyre * wet;
  if (scale === 1) return dry;
  return { friction: dry.friction * scale, side: dry.side * scale, roll: dry.roll };
}

/** One wheel, as the state carries it. Everything here is drawn or read back; none of it is Rapier's. */
export interface WheelState {
  /** Radians turned on the axle, so the model's wheels roll with the ground. */
  rotation: number;
  /** Radians the wheel is steered to. */
  steer: number;
  /** Metres the suspension is extended to, so the body leans and dives. */
  suspension: number;
  /** True while the wheel's ray-cast reaches the ground. */
  contact: boolean;
  /**
   * True while the tyre is sliding across the road rather than rolling along
   * it, which is what leaves a skid mark (spec section 11.3). One rule covers
   * every way of getting there: a handbrake turn, a corner taken too fast and
   * a spin all slide the vehicle across its own axle.
   */
  skid: boolean;
}

/**
 * One vehicle, as the simulation stores it: plain numbers, and enough of them
 * to rebuild the Rapier body exactly. Nothing here is a Rapier handle.
 */
export interface VehicleState {
  /** Which row of the roster this is, so the record says what is being driven. */
  cls: VehicleClass;
  /** The middle of the body, in metres. `y` is up; `z` is the map's `y`. */
  x: number;
  y: number;
  z: number;
  /** Orientation, as a unit quaternion. */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** Metres per second. */
  vx: number;
  vy: number;
  vz: number;
  /** Radians per second. */
  ax: number;
  ay: number;
  az: number;
  wheels: WheelState[];
  /** Forward speed in metres per second, negative in reverse. */
  speed: number;
  /** True while a boat's hull is in the water. Always false on a wheeled vehicle. */
  afloat: boolean;
  /**
   * What has been done to it: the dents, the panels it has lost, and whether
   * it is burning (spec section 11.3). `damage.ts` holds the rules; this is
   * where the record carries them.
   */
  damage: DamageState;
  /**
   * How far round the radio dial this vehicle has been turned (spec section
   * 15). It is per vehicle, so a car keeps the station it was left on and a
   * stolen one comes with whatever its owner was listening to. Unbounded on
   * purpose: `src/audio/dial.ts` wraps it, because the number of stations is
   * no business of the simulation's. A vehicle starts one step back from the
   * first station, which is Off: the radio plays once the player tunes it.
   */
  station: number;
  /**
   * True once its lock has been beaten (spec section 11.4). A vehicle that
   * needs no hotwiring never reads it; one that does is worked at once and not
   * again, so stepping out to look at something is not a second break-in.
   */
  hotwired: boolean;
  /**
   * The colour its body is painted: the colour of its row of the roster until a
   * workshop resprays it (spec section 16.1). It is per vehicle, because a
   * respray is what was done to one car and not what the class is built in.
   */
  paint: number;
}

/** Where a new vehicle's dial stands: one step back from the first station, which is Off. */
const RADIO_OFF = -1;

/** A vehicle at rest at a place, with its wheels hanging at their rest length. */
export function createVehicleState(spec: VehicleSpec, x = 0, z = 0, y = 0, heading = 0): VehicleState {
  const half = -heading / 2;
  const wheels: WheelState[] = spec.wheels.map(() => ({
    rotation: 0,
    steer: 0,
    suspension: spec.suspensionRest,
    contact: false,
    skid: false,
  }));
  return {
    cls: spec.cls,
    x,
    y,
    z,
    qx: 0,
    qy: sin(half),
    qz: 0,
    qw: cos(half),
    vx: 0,
    vy: 0,
    vz: 0,
    ax: 0,
    ay: 0,
    az: 0,
    wheels,
    speed: 0,
    afloat: false,
    damage: createDamageState(),
    station: RADIO_OFF,
    hotwired: false,
    paint: spec.paint,
  };
}

/** True on a row that flies (spec section 11.3). */
export function isAircraft(cls: VehicleClass): cls is AircraftClass {
  return (AIRCRAFT_CLASSES as readonly VehicleClass[]).includes(cls);
}

/** Which way a vehicle points on the map, in radians. */
export function headingOf(v: VehicleState): number {
  // The forward axis is local +x, so this is that axis turned by the rotation.
  const fx = 1 - 2 * (v.qy * v.qy + v.qz * v.qz);
  const fz = 2 * (v.qx * v.qz - v.qy * v.qw);
  return atan2(fz, fx);
}
