/**
 * The engine note of spec section 15, modelled from what the record already
 * holds: the speed, the throttle and the roster row of the vehicle.
 *
 * There is no RPM in `sim/vehicle.ts`, and there should not be: the drivetrain
 * of spec section 11.3 puts a force through the wheels and reads a speed back,
 * with no gearbox in between. So the gearbox lives here, in the audio, where it
 * is heard and nowhere else. It is a pure function of the speed, so a replay of
 * the same drive changes up at the same moment, and nothing the player hears
 * can ever change how the car drives.
 *
 * The box is geometric: first gear reaches {@link FIRST_GEAR} of the top speed
 * and each gear after it is the same step longer, which is how a real ratio set
 * is spaced. Within a gear the revs run from idle to the redline, so a pull
 * through the box sweeps up, drops, and sweeps up again.
 */
import { enginePowerScale } from '../sim/damage.ts';
import type { VehicleClass, VehicleSpec, VehicleState } from '../sim/vehicle.ts';

/** Where the revs sit with the engine running and the vehicle standing still. */
export const IDLE_REV = 0.17;

/** The share of the top speed first gear reaches. The rest of the box is spaced from it. */
const FIRST_GEAR = 0.22;

/** How many gears each class of spec section 11.3 has. A boat has none: it is direct drive. */
export const GEARS: Readonly<Record<VehicleClass, number>> = Object.freeze({
  compact: 5,
  saloon: 5,
  sports: 6,
  van: 5,
  truck: 8,
  bus: 6,
  motorcycle: 6,
  offroad: 5,
  buggy: 4,
  emergency: 5,
  boat: 1,
  // A rotor and a propeller turn at the speed the engine does, so every
  // aircraft is direct drive.
  'heli-light': 1,
  'heli-police': 1,
  'heli-transport': 1,
  'heli-attack': 1,
  'plane-light': 1,
  seaplane: 1,
  biplane: 1,
  bizjet: 1,
  fighter: 1,
});

/** What the engine is doing, in the two numbers a voice needs and the gear that explains them. */
export interface EngineSound {
  /** {@link IDLE_REV} at a standstill, 1 at the redline. */
  rev: number;
  /** 0 off the throttle, 1 with the pedal down. */
  load: number;
  /** Which gear the box is in, counted from 0, and -1 in reverse. */
  gear: number;
  /** False once the engine is dead, which is the one thing that silences it. */
  running: boolean;
}

/** An engine that is not turning at all, which is what a dead one sounds like. */
const ENGINE_OFF: EngineSound = Object.freeze({ rev: 0, load: 0, gear: 0, running: false });

/**
 * The note the player's own vehicle is making. `throttle` is the input frame's
 * forward axis, so lifting off drops the load while the revs fall with the
 * speed, which is the overrun a coasting car makes.
 */
export function engineSound(spec: VehicleSpec, vehicle: VehicleState, throttle: number): EngineSound {
  if (enginePowerScale(vehicle.damage) === 0) return ENGINE_OFF;
  const speed = vehicle.speed;
  const load = Math.max(0, Math.min(1, Math.abs(throttle)));
  if (speed < 0) {
    // Reverse is one short gear, so it holds the same rising note all the way.
    const reach = Math.min(1, -speed / Math.max(0.1, spec.topSpeed * spec.reverse));
    return { rev: IDLE_REV + (1 - IDLE_REV) * reach, load, gear: -1, running: true };
  }
  const gears = GEARS[spec.cls];
  if (gears <= 1) {
    // Direct drive: the note follows the speed the whole way up, with the
    // throttle alone telling a boat idling on the plane from one pushing.
    const reach = Math.min(1, speed / Math.max(0.1, spec.topSpeed));
    return { rev: IDLE_REV + (1 - IDLE_REV) * reach, load, gear: 0, running: true };
  }
  const gear = gearAt(spec, speed);
  const top = gearTop(spec, gear);
  const floor = gear === 0 ? 0 : gearTop(spec, gear - 1);
  const reach = Math.max(0, Math.min(1, (speed - floor) / Math.max(0.1, top - floor)));
  return { rev: IDLE_REV + (1 - IDLE_REV) * reach, load, gear, running: true };
}

/**
 * How far the whole note is shifted for a vehicle of this mass, as a factor
 * either side of 1. A bus rumbles and a buggy buzzes, and the roster's own
 * kilograms are what say which: nothing else has to be written down per class.
 */
export function enginePitch(mass: number): number {
  return Math.max(0.6, Math.min(1.6, Math.pow(1400 / Math.max(1, mass), 0.4)));
}

/** The speed, in metres per second, at which gear `gear` hits the redline. */
export function gearTop(spec: VehicleSpec, gear: number): number {
  const gears = GEARS[spec.cls];
  if (gears <= 1) return spec.topSpeed;
  const step = (gears - 1 - gear) / (gears - 1);
  return spec.topSpeed * Math.pow(FIRST_GEAR, step);
}

/** The gear a vehicle at this speed is in, counted from 0. */
export function gearAt(spec: VehicleSpec, speed: number): number {
  const gears = GEARS[spec.cls];
  for (let gear = 0; gear < gears - 1; gear++) {
    if (speed <= gearTop(spec, gear)) return gear;
  }
  return gears - 1;
}
