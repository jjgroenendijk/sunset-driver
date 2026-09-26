/**
 * The aircraft of spec section 11.3, row by row: four helicopters and five
 * planes. `roster.ts` takes them into the one roster; they live here so that
 * file stays a table of the cars.
 *
 * A helicopter has no wheels: it stands on its skids, which are the bottom of
 * its body, and the rotor of `flight.ts` is all that moves it. A plane rolls on
 * a tricycle of wheels the engine does not drive: the propeller or the jet of
 * `flight.ts` pushes it, and the wheels steer and brake it on the ground. The
 * seaplane has a hull instead, so it floats.
 *
 * The collider is the fuselage alone. The wings and the rotor are drawn, not
 * felt, so a plane does not catch its wingtip on every lamp post it taxies by.
 */
import type { AircraftClass } from '../../world/types.ts';
import type { FlightSpec, VehicleSpec, WheelSpec } from './vehicle.ts';

/** What every aircraft shares unless its own row says otherwise. */
const AIR = {
  wheelWidth: 0.18,
  tyres: { grip: 1, loose: 1 },
  reverse: 0.3,
  enginePower: 0,
  steerAtSpeed: 0.12,
  steerRate: 3,
  maxSteer: 0.5,
  suspensionCompression: 0.85,
  suspensionRelaxation: 0.9,
  suspensionTravel: 0.25,
  balance: 0,
  inline: false,
  // Every aircraft is worth stealing, so every one is behind a lock (spec
  // section 11.4): a civil one on the apron as much as a military one.
  alarm: true,
  luxury: true,
  drag: 0.04,
  trim: 0x1d2026,
} as const;

/** What a helicopter has in place of wheels: nothing to steer, drive or spring. */
const SKIDS = {
  wheelRadius: 0,
  wheelWidth: 0,
  wheels: [] as WheelSpec[],
  brakeForce: 0,
  handbrakeForce: 0,
  maxSteer: 0,
  steerRate: 0,
  suspensionRest: 0,
  suspensionStiffness: 0,
  suspensionTravel: 0,
  maxSuspensionForce: 0,
} as const;

/**
 * A plane's tricycle: a steered nose wheel pair close to the centreline and a
 * main pair under the wings that the brakes and the handbrake hold.
 */
function tricycle(nose: number, main: number, track: number, drop: number): WheelSpec[] {
  const wheels: WheelSpec[] = [];
  for (const side of [1, -1]) wheels.push({ x: nose, y: drop, z: side * 0.25, steered: true, driven: false, handbraked: false });
  for (const side of [1, -1]) wheels.push({ x: main, y: drop, z: side * track, steered: false, driven: false, handbraked: true });
  return wheels;
}

/** The gear and the springs of a plane of this mass. */
function gear(mass: number, wheels: WheelSpec[]): Pick<VehicleSpec, 'wheels' | 'wheelRadius' | 'suspensionRest' | 'suspensionStiffness' | 'maxSuspensionForce' | 'brakeForce' | 'handbrakeForce'> {
  return {
    wheels,
    wheelRadius: 0.32,
    suspensionRest: 0.35,
    suspensionStiffness: 28,
    maxSuspensionForce: mass * 25,
    brakeForce: mass * 1.2,
    handbrakeForce: mass * 2,
  };
}

/** A rotor that climbs at `climb` and turns at `turn`. */
function rotor(topSpeed: number, thrust: number, climb: number, turn: number, bank: number): FlightSpec {
  return { kind: 'rotor', topSpeed, thrust, stall: 0, climb, turn, bank };
}

/** A wing that lifts its weight at `stall`. */
function wing(topSpeed: number, thrust: number, stall: number, climb: number, turn: number, bank: number): FlightSpec {
  return { kind: 'wing', topSpeed, thrust, stall, climb, turn, bank };
}

/** A two-seat helicopter: light, nimble, slow. */
const HELI_LIGHT: VehicleSpec = {
  ...AIR,
  ...SKIDS,
  cls: 'heli-light',
  name: 'Light helicopter',
  mass: 750,
  halfLength: 4.2,
  halfHeight: 1.1,
  halfWidth: 0.9,
  topSpeed: 45,
  flight: rotor(45, 6, 7, 1.5, 0.3),
  paint: 0xe0782c,
};

/** The police helicopter, with the searchlight under its nose and a gun at its side. */
const HELI_POLICE: VehicleSpec = {
  ...AIR,
  ...SKIDS,
  cls: 'heli-police',
  name: 'Police helicopter',
  mass: 1400,
  halfLength: 5,
  halfHeight: 1.25,
  halfWidth: 1.1,
  topSpeed: 55,
  flight: rotor(55, 7, 8, 1.4, 0.3),
  paint: 0x1d3d7a,
  trim: 0xf2f4f5,
};

/** A twin-rotor transport: heavy, slow to climb and slow to turn. */
const HELI_TRANSPORT: VehicleSpec = {
  ...AIR,
  ...SKIDS,
  cls: 'heli-transport',
  name: 'Transport helicopter',
  mass: 5500,
  halfLength: 7.5,
  halfHeight: 1.7,
  halfWidth: 1.5,
  topSpeed: 42,
  flight: rotor(42, 4, 5, 0.8, 0.2),
  paint: 0x55603f,
};

/** A narrow gunship: the fastest rotor there is, and military. */
const HELI_ATTACK: VehicleSpec = {
  ...AIR,
  ...SKIDS,
  cls: 'heli-attack',
  name: 'Attack helicopter',
  mass: 4000,
  halfLength: 6.8,
  halfHeight: 1.3,
  halfWidth: 0.8,
  topSpeed: 70,
  flight: rotor(70, 9, 10, 1.8, 0.4),
  paint: 0x4a5236,
  trim: 0x23261c,
};

/** A single-engine high-wing plane: the one a strip keeps. */
const PLANE_LIGHT: VehicleSpec = {
  ...AIR,
  ...gear(1000, tricycle(2.4, -0.4, 1.3, -0.7)),
  cls: 'plane-light',
  name: 'Light plane',
  mass: 1000,
  halfLength: 4,
  halfHeight: 1,
  halfWidth: 0.9,
  topSpeed: 60,
  flight: wing(60, 5, 26, 7, 0.7, 0.5),
  paint: 0xe8c23a,
};

/** A light plane on floats: it takes off from the water, and it floats on it. */
const SEAPLANE: VehicleSpec = {
  ...AIR,
  ...SKIDS,
  cls: 'seaplane',
  name: 'Seaplane',
  mass: 1400,
  halfLength: 4.6,
  halfHeight: 1.1,
  halfWidth: 1,
  topSpeed: 55,
  hull: {
    draft: 0.35,
    liftLength: 0.62,
    liftWidth: 0.8,
    buoyancy: 1.4,
    heave: 2.4,
    thrust: 5000,
    topSpeed: 20,
    reverse: 0.25,
    waterDrag: 0.1,
    sideDrag: 3,
    rudder: 9000,
  },
  flight: wing(55, 4.5, 24, 6, 0.6, 0.5),
  paint: 0xf2f4f5,
  trim: 0x1d5c7a,
};

/** A stunt biplane: short, light and quick to turn and to climb. */
const BIPLANE: VehicleSpec = {
  ...AIR,
  ...gear(700, tricycle(1.9, -0.3, 1.1, -0.8)),
  cls: 'biplane',
  name: 'Stunt biplane',
  mass: 700,
  halfLength: 3.5,
  halfHeight: 1.2,
  halfWidth: 0.9,
  topSpeed: 55,
  flight: wing(55, 6, 20, 9, 1.2, 0.8),
  paint: 0xc4302b,
  trim: 0xf2e6c8,
};

/** A twin-engine business jet: long on the runway and fast once it is up. */
const BIZJET: VehicleSpec = {
  ...AIR,
  ...gear(8000, tricycle(6.5, -1.2, 1.8, -0.9)),
  cls: 'bizjet',
  name: 'Business jet',
  mass: 8000,
  halfLength: 9.5,
  halfHeight: 1.3,
  halfWidth: 1.2,
  topSpeed: 100,
  flight: wing(100, 5, 48, 12, 0.5, 0.45),
  paint: 0xf4f5f7,
  trim: 0x2a3a5c,
};

/** A fighter: the fastest thing in the city, and military. */
const FIGHTER: VehicleSpec = {
  ...AIR,
  ...gear(12000, tricycle(4.5, -1.5, 1.6, -0.8)),
  cls: 'fighter',
  name: 'Fighter jet',
  mass: 12000,
  halfLength: 8,
  halfHeight: 1.1,
  halfWidth: 1.3,
  topSpeed: 130,
  flight: wing(130, 9, 55, 22, 1, 0.9),
  paint: 0x7d858c,
  trim: 0x2b3036,
};

/** The aircraft of the roster, by class. */
export const AIRCRAFT_ROSTER: Record<AircraftClass, VehicleSpec> = {
  'heli-light': HELI_LIGHT,
  'heli-police': HELI_POLICE,
  'heli-transport': HELI_TRANSPORT,
  'heli-attack': HELI_ATTACK,
  'plane-light': PLANE_LIGHT,
  seaplane: SEAPLANE,
  biplane: BIPLANE,
  bizjet: BIZJET,
  fighter: FIGHTER,
};

/** True on the aircraft the military keeps behind its fence (spec section 14). */
export function isMilitary(cls: AircraftClass): boolean {
  return cls === 'fighter' || cls === 'heli-attack';
}
