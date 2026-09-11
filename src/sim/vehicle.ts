/**
 * The car the player drives (spec section 11.3).
 *
 * This holds three things and nothing else: the numbers one vehicle is made of,
 * the serialisable state of one vehicle, and what a tyre finds on each surface.
 * `physics.ts` turns them into a Rapier body and a
 * `DynamicRayCastVehicleController`; nothing here touches Rapier, so the table
 * can be read headless and the handling roster of spec section 11.3 can grow
 * into it.
 *
 * The vehicle's own frame has forward along local `+x`, up along `+y` and the
 * axle along `+z`, which is the frame the character model already uses: a yaw
 * of `-heading` about `y` points local `+x` along `(cos heading, sin heading)`
 * on the map. Map `y` is world `z`, as everywhere else in the renderer.
 */
import type { Surface } from '../world/surface.ts';

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

/** What one vehicle is made of. The roster of spec section 11.3 is a table of these. */
export interface VehicleSpec {
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
  /**
   * Newtons the engine puts through the driven wheels at a standstill. It falls
   * away as the vehicle nears {@link VehicleSpec.topSpeed}, which is what gives
   * the vehicle a top speed on the flat without a speed clamp: on a climb the
   * same force has the slope to fight, so the hill decides the speed instead.
   */
  enginePower: number;
  /** Metres per second the engine can reach on the flat. */
  topSpeed: number;
  /** Reverse is geared shorter: a fraction of the power and of the top speed. */
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
}

/**
 * The player's car until the roster of spec section 11.3 lands: a rear-wheel
 * drive saloon. Four and a bit metres long, 1200 kg, 190 km/h on the flat.
 */
export const SALOON: VehicleSpec = {
  mass: 1200,
  halfLength: 2.15,
  halfHeight: 0.55,
  halfWidth: 0.88,
  wheelRadius: 0.34,
  wheelWidth: 0.24,
  wheels: wheelsOf(1.3, 0.78, -0.25),
  enginePower: 9000,
  topSpeed: 53,
  reverse: 0.3,
  brakeForce: 3000,
  handbrakeForce: 6000,
  drag: 0.02,
  maxSteer: 0.55,
  steerAtSpeed: 0.18,
  steerRate: 3.2,
  suspensionRest: 0.32,
  suspensionStiffness: 26,
  suspensionCompression: 0.85,
  suspensionRelaxation: 0.9,
  suspensionTravel: 0.2,
  maxSuspensionForce: 24_000,
};

/**
 * Four wheels at a wheelbase and a track, hung this far below the middle of the
 * body. Front wheels steer, rear wheels drive and take the handbrake.
 */
function wheelsOf(halfBase: number, halfTrack: number, drop: number): WheelSpec[] {
  const wheels: WheelSpec[] = [];
  for (const front of [true, false]) {
    for (const side of [1, -1]) {
      wheels.push({
        x: front ? halfBase : -halfBase,
        y: drop,
        z: side * halfTrack,
        steered: front,
        driven: !front,
        handbraked: !front,
      });
    }
  }
  return wheels;
}

/** How high the middle of the body stands over flat ground when the vehicle is at rest. */
export function rideHeight(spec: VehicleSpec): number {
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

/**
 * What is left of the grip when the surface is wet, as a fraction. Weather does
 * not exist yet (spec section 13.4), so nothing sets a wetness above zero; the
 * term is here so the grip has one definition when weather arrives rather than
 * a second one written beside it.
 */
export const WET_GRIP = 0.62;

/** The grip of a surface, with `wetness` from 0 (dry) to 1 (standing water). */
export function gripOf(surface: Surface, wetness: number): SurfaceGrip {
  const dry = SURFACE_GRIP[surface];
  if (wetness <= 0) return dry;
  const wet = 1 - (1 - WET_GRIP) * Math.min(1, wetness);
  return { friction: dry.friction * wet, side: dry.side * wet, roll: dry.roll };
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
}

/**
 * One vehicle, as the simulation stores it: plain numbers, and enough of them
 * to rebuild the Rapier body exactly. Nothing here is a Rapier handle.
 */
export interface VehicleState {
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
}

/** A vehicle at rest at a place, with its wheels hanging at their rest length. */
export function createVehicleState(spec: VehicleSpec, x = 0, z = 0, y = 0, heading = 0): VehicleState {
  const half = -heading / 2;
  const wheels: WheelState[] = spec.wheels.map(() => ({
    rotation: 0,
    steer: 0,
    suspension: spec.suspensionRest,
    contact: false,
  }));
  return {
    x,
    y,
    z,
    qx: 0,
    qy: Math.sin(half),
    qz: 0,
    qw: Math.cos(half),
    vx: 0,
    vy: 0,
    vz: 0,
    ax: 0,
    ay: 0,
    az: 0,
    wheels,
    speed: 0,
  };
}

/** Which way a vehicle points on the map, in radians. */
export function headingOf(v: VehicleState): number {
  // The forward axis is local +x, so this is that axis turned by the rotation.
  const fx = 1 - 2 * (v.qy * v.qy + v.qz * v.qz);
  const fz = 2 * (v.qx * v.qz - v.qy * v.qw);
  return Math.atan2(fz, fx);
}
