/**
 * The engine note of spec section 15, as numbers: what a vehicle's revolutions,
 * its load and its class come to before anything is synthesised.
 *
 * The roster carries no gearbox, because the physics does not need one: a wheel
 * is pushed by a force and the top speed is what bounds it (`drivetrain.ts`).
 * An ear does need one, since what a driver hears is the engine climbing a gear
 * and dropping back at the change. So the gearbox lives here, in the audio, and
 * is read off the speed the record already carries. Nothing here reaches into
 * the simulation or is read by it.
 */
import type { VehicleClass, VehicleSpec } from '../sim/vehicle.ts';

/** What one class sounds like, before the speed is read. */
export interface EngineTimbre {
  /**
   * Cylinders of a four-stroke, which is what sets the firing rate: a cylinder
   * fires once every two turns, so the note is `rpm / 60 * cylinders / 2`. A
   * four fires at half its revolutions and a V8 at twice that, which is the
   * whole difference between a hatchback and a muscle car.
   */
  cylinders: number;
  /** Revolutions a minute at rest, and the highest the gearbox lets it reach. */
  idle: number;
  redline: number;
  /**
   * How much of the voice is intake and exhaust noise rather than the firing
   * note, 0 to 1. A diesel truck is mostly noise; a sports car is mostly note.
   */
  roughness: number;
  /**
   * Where each gear ends, as a fraction of the vehicle's top speed. The last
   * is always 1, because the last gear is what reaches the top speed.
   */
  gears: readonly number[];
}

/** Gear ratios a road car uses, as fractions of its top speed. */
const ROAD_GEARS: readonly number[] = [0.18, 0.34, 0.54, 0.76, 1];

/**
 * What each class of the roster sounds like (spec section 15). The numbers are
 * the real ones where a real engine has them: a bus idles low and pulls from
 * nothing, a motorcycle screams to 11 000, and a boat has one ratio, so its
 * revolutions rise with the water and never drop at a change.
 */
export const ENGINES: Record<VehicleClass, EngineTimbre> = {
  compact: { cylinders: 4, idle: 800, redline: 6200, roughness: 0.35, gears: ROAD_GEARS },
  saloon: { cylinders: 6, idle: 750, redline: 6000, roughness: 0.3, gears: ROAD_GEARS },
  sports: { cylinders: 8, idle: 900, redline: 7600, roughness: 0.2, gears: ROAD_GEARS },
  van: { cylinders: 4, idle: 700, redline: 4600, roughness: 0.5, gears: [0.22, 0.42, 0.66, 1] },
  truck: { cylinders: 6, idle: 600, redline: 3000, roughness: 0.7, gears: [0.16, 0.3, 0.46, 0.66, 0.84, 1] },
  bus: { cylinders: 6, idle: 620, redline: 2800, roughness: 0.68, gears: [0.2, 0.38, 0.6, 0.82, 1] },
  motorcycle: { cylinders: 2, idle: 1200, redline: 11_000, roughness: 0.25, gears: [0.2, 0.36, 0.52, 0.7, 0.86, 1] },
  offroad: { cylinders: 6, idle: 750, redline: 5200, roughness: 0.45, gears: [0.2, 0.4, 0.64, 1] },
  buggy: { cylinders: 4, idle: 1000, redline: 7000, roughness: 0.55, gears: [0.24, 0.46, 0.72, 1] },
  emergency: { cylinders: 8, idle: 800, redline: 6400, roughness: 0.3, gears: ROAD_GEARS },
  boat: { cylinders: 6, idle: 700, redline: 4800, roughness: 0.4, gears: [1] },
};

/** The note of one engine at one moment, which is what the synthesiser is set from. */
export interface EngineNote {
  /** Revolutions a minute, between the timbre's idle and its redline. */
  rpm: number;
  /** How hard the engine is working, 0 on the overrun to 1 at full throttle. */
  load: number;
  /** The gear it is in, counted from 0. Always 0 on a boat, which has one. */
  gear: number;
}

/** Speed under which a vehicle counts as standing still, in metres per second. */
const STANDING = 0.6;

/** How much of the rev range a blip of the throttle raises a standing engine by. */
const BLIP = 0.4;

/** The lowest an engine under way sits in its gear, as a share of the rev range. */
const GEAR_FLOOR = 0.3;

/** What the engine idles at, as a load, so a standing engine is still heard. */
const IDLE_LOAD = 0.12;

/** The gear a fraction of the top speed falls in, counted from 0. */
export function gearAt(gears: readonly number[], fraction: number): number {
  for (let i = 0; i < gears.length; i++) {
    if (fraction <= (gears[i] as number)) return i;
  }
  return gears.length - 1;
}

/**
 * The note an engine is turning at, from the record and the pedal.
 *
 * `speed` is the vehicle's own forward speed, which the record carries, and
 * `throttle` the input frame's forward axis. Reverse is geared short, so it is
 * read against the reverse top speed and revs high at a walking pace, the way
 * it does in a real car.
 *
 * A standing engine sits at its idle and a blip of the throttle lifts it, which
 * is what makes a car waiting at a light sound alive.
 */
export function engineNote(spec: VehicleSpec, speed: number, throttle: number): EngineNote {
  const timbre = ENGINES[spec.cls];
  const range = timbre.redline - timbre.idle;
  const pedal = Math.min(1, Math.abs(throttle));
  const forward = Math.abs(speed);
  // What the throttle alone pulls the engine up to, whatever the wheels are
  // doing: a blip at a light, and the clutch slipping as a car pulls away.
  const blip = timbre.idle + range * BLIP * pedal;
  if (forward < STANDING) {
    return { rpm: blip, load: Math.max(IDLE_LOAD, pedal), gear: 0 };
  }
  const top = speed < 0 ? spec.topSpeed * spec.reverse : spec.topSpeed;
  const fraction = Math.min(1, forward / Math.max(1, top));
  const gear = gearAt(timbre.gears, fraction);
  const low = gear === 0 ? 0 : (timbre.gears[gear - 1] as number);
  const high = timbre.gears[gear] as number;
  const within = high > low ? (fraction - low) / (high - low) : 1;
  // The first gear starts at the idle, because that is where the clutch lets
  // go; every gear after it starts where the change dropped the revs to.
  const floor = gear === 0 ? 0 : GEAR_FLOOR;
  const geared = timbre.idle + range * (floor + (1 - floor) * within);
  return { rpm: Math.max(geared, blip), load: Math.max(IDLE_LOAD, pedal), gear };
}

/**
 * Hertz the cylinders fire at, which is the note the ear hears. The harmonics
 * over it are what make one engine sound unlike another; this is the root.
 */
export function firingHz(rpm: number, cylinders: number): number {
  return (rpm / 60) * (cylinders / 2);
}
