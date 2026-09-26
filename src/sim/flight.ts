/**
 * The flight of spec section 11.3: an arcade controller for the rotor of a
 * helicopter and the wing of a plane.
 *
 * It is written as targets rather than aerodynamics. The throttle asks for a
 * speed along the heading, the jump key for a climb and the sprint key for a
 * descent, and the steering for a rate of turn; each is a force or a torque
 * that closes the gap between what the body is doing and what was asked. The
 * attitude is held the same way: level, banked into a turn, and pitched with
 * the climb. So an aircraft goes where it points, and nobody needs a manual.
 *
 * - A **rotor** lifts its weight at any speed, so it hovers, and it only moves
 *   off the ground when it is asked to climb.
 * - A **wing** lifts in proportion to its speed, and all of its weight from
 *   {@link FlightSpec.stall} up. Below it the lift fades, so a plane has to
 *   run down a runway to leave it, and one that slows in the air sinks. The
 *   sink is damped, so a stall is a gentle drop rather than a dive.
 *
 * `physics.ts` calls {@link Flight.fly} each tick after the wheels or the hull
 * have had their say, so a plane rolls and brakes on its wheels and a seaplane
 * floats on its hull; what this adds is the engine and the air. A damaged
 * engine gives less, and a dead one nothing: a helicopter with a dead engine
 * falls, and a plane glides until it runs out of speed.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { asin, atan2, hypot } from '../core/libm.ts';
import { enginePowerScale } from './damage.ts';
import { rotate } from './frame.ts';
import type { Ground } from './ground-bodies.ts';
import type { InputFrame } from './input.ts';
import { rideHeight, type FlightSpec, type VehicleSpec, type VehicleState } from './vehicle.ts';

/** Metres per second squared. */
const GRAVITY = 9.81;

/** Metres over the ground an aircraft may climb to. Above it the climb is taken back. */
export const CEILING = 260;

/** Metres of clearance over its rest height at which a body with no wheels is in the air. */
const AIRBORNE = 1.2;

/** How hard the lift closes on the climb rate asked for, per second. */
const LIFT_GAIN = 2.5;

/** The most the lift gives, as a multiple of the weight. */
const LIFT_MAX = 2.5;

/** How hard a rotor closes on the speed asked for, per second. */
const ROTOR_GAIN = 0.9;

/** The share of a rotor's top speed it flies backwards at. */
const ROTOR_REVERSE = 0.3;

/** How much of the speed across its heading the air takes back from an aircraft, per second. */
const SIDE_GRIP = 2;

/** How hard the brake in the air takes speed back, per second. */
const AIR_BRAKE = 0.3;

/** The share of the stall speed over which a wing's lift fades in. */
const LIFT_FADE = 0.3;

/** How hard a stalled wing's sink is damped, per second, and the sink it allows undamped. */
const STALL_DAMPING = 1.2;
const STALL_SINK = 4;

/** Radians a wing pitches up or down at most, and a rotor tips into the way it flies. */
const PITCH_LIMIT = 0.35;
const ROTOR_TILT = 0.18;

/** How hard the attitude is held, per second squared and per second. */
const ATTITUDE = 10;
const ATTITUDE_DAMPING = 6;

/** How hard the rate of turn closes on the one asked for, per second. */
const YAW_GAIN = 4;

/** The engine and the air of every aircraft. It owns no state but its scratch vectors. */
export class Flight {
  private readonly ground: Ground;
  /** Scratch vectors, so a tick allocates nothing. */
  private readonly nose = { x: 0, y: 0, z: 0 };
  private readonly axle = { x: 0, y: 0, z: 0 };
  private readonly force = { x: 0, y: 0, z: 0 };
  /** Scratch for what the rotor or the wing reads, filled before either is asked. */
  private readonly pose: Pose = { power: 0, along: 0, climb: 0, airborne: false, flying: false };

  constructor(ground: Ground) {
    this.ground = ground;
  }

  /** Metres the underside of an aircraft stands over the ground, or over the sea where it floats. */
  clearance(v: VehicleState, spec: VehicleSpec): number {
    const land = this.ground.heightAt(v.x, v.z);
    const floor = spec.hull === undefined ? land : Math.max(land, this.ground.seaLevel);
    return v.y - rideHeight(spec) - floor;
  }

  /** Apply the engine and the air to an aircraft for one tick. */
  fly(chassis: RAPIER.RigidBody, v: VehicleState, input: InputFrame, spec: VehicleSpec): void {
    const flight = spec.flight as FlightSpec;
    const mass = spec.mass;
    const power = enginePowerScale(v.damage);
    const clearance = this.clearance(v, spec);
    const airborne = spec.wheels.length > 0 ? clearance > 0.3 && v.wheels.every((w) => !w.contact) : clearance > AIRBORNE;

    rotate(this.nose, v, 1, 0, 0);
    rotate(this.axle, v, 0, 0, 1);
    // The heading flat on the map, and the velocity along it and across it.
    const flat = hypot(this.nose.x, this.nose.z) || 1;
    const hx = this.nose.x / flat;
    const hz = this.nose.z / flat;
    const along = v.vx * hx + v.vz * hz;
    const across = -v.vx * hz + v.vz * hx;

    const ask = (input.jump ? 1 : 0) - (input.sprint ? 1 : 0);
    let climb = ask * flight.climb;
    if (clearance > CEILING) climb = Math.min(climb, 0) - (clearance - CEILING) * 0.2;

    // Nothing leaves the ground until it is asked to climb: an aircraft
    // standing on it idles, and a plane taxies on its wheels.
    const flying = airborne || ask > 0;
    const pose = this.pose;
    pose.power = power;
    pose.along = along;
    pose.climb = climb;
    pose.airborne = airborne;
    pose.flying = flying;
    if (flight.kind === 'rotor') rotorAero(v, input, flight, pose);
    else wingAero(v, input, flight, pose);
    const push = aero.push;
    const lift = clamp(aero.lift, 0, LIFT_MAX * GRAVITY);
    const pitch = aero.pitch;
    const turn = aero.turn;
    const slip = airborne ? -SIDE_GRIP * across : 0;
    this.force.x = mass * (hx * push - hz * slip);
    this.force.y = mass * lift;
    this.force.z = mass * (hz * push + hx * slip);
    chassis.addForce(this.force, true);

    // On the ground a plane steers on its wheels and a seaplane on its rudder;
    // in the air every aircraft is turned and held level from here.
    if (!airborne) return;
    const a2 = spec.halfLength * spec.halfLength;
    const b2 = spec.halfHeight * spec.halfHeight;
    const c2 = spec.halfWidth * spec.halfWidth;
    const rollInertia = (mass * (b2 + c2)) / 3;
    const yawInertia = (mass * (a2 + c2)) / 3;
    const pitchInertia = (mass * (a2 + b2)) / 3;
    // The map's heading runs the other way round the up axis, so steering
    // right is a negative yaw, and the right-hand side is the axle's `+z`.
    const yaw = yawInertia * YAW_GAIN * (-input.steer * flight.turn * turn - v.ay);
    const nowPitch = asin(clamp(this.nose.y, -1, 1));
    const nowRoll = -asin(clamp(this.axle.y, -1, 1));
    const pitchRate = v.ax * this.axle.x + v.ay * this.axle.y + v.az * this.axle.z;
    const rollRate = v.ax * this.nose.x + v.ay * this.nose.y + v.az * this.nose.z;
    const bank = input.steer * flight.bank * turn;
    const aboutAxle = pitchInertia * (ATTITUDE * (pitch - nowPitch) - ATTITUDE_DAMPING * pitchRate);
    const aboutNose = rollInertia * (ATTITUDE * (bank - nowRoll) - ATTITUDE_DAMPING * rollRate);
    this.force.x = this.axle.x * aboutAxle + this.nose.x * aboutNose;
    this.force.y = this.axle.y * aboutAxle + this.nose.y * aboutNose + yaw;
    this.force.z = this.axle.z * aboutAxle + this.nose.z * aboutNose;
    chassis.addTorque(this.force, true);
  }
}

/** What one tick of flight is worked out from, beside the state, the input and the spec. */
interface Pose {
  power: number;
  along: number;
  climb: number;
  airborne: boolean;
  flying: boolean;
}

/** The thrust, lift, pitch and share of the turn one tick asks for, written by the two below. */
const aero = { push: 0, lift: 0, pitch: 0, turn: 0 };

/** A rotor: it holds a speed asked for, lifts its weight at any speed and tips into the way it flies. */
function rotorAero(v: VehicleState, input: InputFrame, flight: FlightSpec, p: Pose): void {
  const power = p.power;
  aero.push = 0;
  aero.lift = 0;
  const top = flight.topSpeed * power;
  const wanted = input.throttle >= 0 ? input.throttle * top : input.throttle * top * ROTOR_REVERSE;
  if (p.airborne) aero.push = clamp(ROTOR_GAIN * (wanted - p.along), -flight.thrust, flight.thrust) * power;
  if (p.flying) aero.lift = power * (GRAVITY + LIFT_GAIN * (p.climb - v.vy));
  aero.pitch = -ROTOR_TILT * input.throttle;
  aero.turn = 1;
}

/** A wing: it lifts with its speed, fades below the stall and sinks gently when stalled. */
function wingAero(v: VehicleState, input: InputFrame, flight: FlightSpec, p: Pose): void {
  const power = p.power;
  const along = p.along;
  aero.push = 0;
  aero.lift = 0;
  if (input.throttle > 0) aero.push = input.throttle * flight.thrust * power * Math.max(0, 1 - along / flight.topSpeed);
  else if (input.throttle < 0 && p.airborne) aero.push = input.throttle * AIR_BRAKE * Math.max(0, along);
  const share = clamp((along - (1 - LIFT_FADE) * flight.stall) / (LIFT_FADE * flight.stall), 0, 1);
  if (p.flying) aero.lift = share * (GRAVITY + LIFT_GAIN * (p.climb - v.vy));
  // A stalled wing sinks, but gently: the fall past a walking pace is damped.
  if (p.airborne) aero.lift += (1 - share) * STALL_DAMPING * Math.max(0, -v.vy - STALL_SINK);
  aero.pitch = clamp(atan2(v.vy, Math.max(along, 5)), -PITCH_LIMIT, PITCH_LIMIT);
  aero.turn = Math.min(1, Math.max(0, along) / flight.stall);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
