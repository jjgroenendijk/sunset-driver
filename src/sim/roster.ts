/**
 * The roster of spec section 11.3, row by row: every class the spec lists, with
 * the mass, size, wheels, tyres, engine, brakes, steering and suspension of
 * each. Nothing else in the project should carry these numbers.
 *
 * What a row is made of, and the record of one vehicle, is `vehicle.ts`.
 */
import type { TyreSpec, VehicleClass, VehicleSpec, WheelSpec } from './vehicle.ts';

/** Road tyres: the reference every other set is measured against. */
export const ROAD_TYRES: TyreSpec = { grip: 1, loose: 1 };

/**
 * Four wheels at a wheelbase and a track, hung this far below the middle of the
 * body. Front wheels steer; `driveFront` says which end the engine drives and
 * the handbrake always locks the rear.
 */
function wheelsOf(halfBase: number, halfTrack: number, drop: number, driveFront = false): WheelSpec[] {
  const wheels: WheelSpec[] = [];
  for (const front of [true, false]) {
    for (const side of [1, -1]) {
      wheels.push({
        x: front ? halfBase : -halfBase,
        y: drop,
        z: side * halfTrack,
        steered: front,
        driven: front === driveFront,
        handbraked: !front,
      });
    }
  }
  return wheels;
}

/** Six wheels: one steered axle at the front and two driven axles at the back. */
function sixWheelsOf(halfBase: number, rearGap: number, halfTrack: number, drop: number): WheelSpec[] {
  const wheels: WheelSpec[] = [];
  for (const x of [halfBase, -halfBase + rearGap, -halfBase - rearGap]) {
    for (const side of [1, -1]) {
      const front = x > 0;
      wheels.push({ x, y: drop, z: side * halfTrack, steered: front, driven: !front, handbraked: !front });
    }
  }
  return wheels;
}

/**
 * Everything a vehicle shares unless its own row says otherwise. A row then
 * carries only what makes that class the class it is, which is what keeps the
 * roster readable as a table.
 */
const COMMON = {
  wheelWidth: 0.24,
  tyres: ROAD_TYRES,
  reverse: 0.3,
  steerAtSpeed: 0.18,
  suspensionCompression: 0.85,
  suspensionRelaxation: 0.9,
  suspensionTravel: 0.2,
  balance: 0,
  inline: false,
  alarm: false,
  luxury: false,
  trim: 0x1d2026,
} as const;

/** Knobbly tyres: a little less on tarmac, a great deal more on everything else. */
const KNOBBLY: TyreSpec = { grip: 0.94, loose: 1.42 };

/** A small hatchback: slow, light and easy to thread through traffic. */
const COMPACT: VehicleSpec = {
  ...COMMON,
  cls: 'compact',
  name: 'Compact',
  mass: 950,
  halfLength: 1.85,
  halfHeight: 0.6,
  halfWidth: 0.8,
  wheelRadius: 0.3,
  wheelWidth: 0.2,
  // Front-wheel drive, as a hatchback is: it understeers rather than snapping.
  wheels: wheelsOf(1.15, 0.72, -0.28, true),
  enginePower: 6500,
  topSpeed: 44,
  brakeForce: 2400,
  handbrakeForce: 5000,
  drag: 0.03,
  maxSteer: 0.68,
  steerRate: 4.2,
  suspensionRest: 0.3,
  suspensionStiffness: 24,
  maxSuspensionForce: 20_000,
  paint: 0x3f7d63,
};

/** A rear-wheel drive saloon: the reference every other row is read against. */
export const SALOON: VehicleSpec = {
  ...COMMON,
  cls: 'saloon',
  name: 'Saloon',
  mass: 1200,
  halfLength: 2.15,
  halfHeight: 0.55,
  halfWidth: 0.88,
  wheelRadius: 0.34,
  wheels: wheelsOf(1.3, 0.78, -0.25),
  enginePower: 9000,
  topSpeed: 53,
  brakeForce: 3000,
  handbrakeForce: 6000,
  drag: 0.02,
  maxSteer: 0.65,
  steerRate: 4.0,
  suspensionRest: 0.32,
  suspensionStiffness: 26,
  maxSuspensionForce: 24_000,
  paint: 0xb8352c,
};

/** Low, wide and fast, with an alarm on it because it is worth stealing. */
const SPORTS: VehicleSpec = {
  ...COMMON,
  cls: 'sports',
  name: 'Sports car',
  mass: 1300,
  halfLength: 2.25,
  halfHeight: 0.42,
  halfWidth: 0.96,
  wheelRadius: 0.33,
  wheelWidth: 0.3,
  wheels: wheelsOf(1.35, 0.86, -0.14),
  tyres: { grip: 1.24, loose: 0.86 },
  enginePower: 14_000,
  topSpeed: 66,
  brakeForce: 4600,
  handbrakeForce: 8000,
  drag: 0.016,
  maxSteer: 0.6,
  steerAtSpeed: 0.22,
  steerRate: 5.2,
  suspensionRest: 0.22,
  suspensionStiffness: 42,
  suspensionCompression: 1.1,
  suspensionRelaxation: 1.2,
  suspensionTravel: 0.12,
  maxSuspensionForce: 30_000,
  alarm: true,
  luxury: true,
  paint: 0xe0b13a,
};

/** A panel van: tall, blind and slow to change its mind. */
const VAN: VehicleSpec = {
  ...COMMON,
  cls: 'van',
  name: 'Van',
  mass: 1900,
  halfLength: 2.6,
  halfHeight: 0.95,
  halfWidth: 0.95,
  wheelRadius: 0.36,
  wheelWidth: 0.26,
  wheels: wheelsOf(1.6, 0.82, -0.62),
  enginePower: 10_000,
  topSpeed: 42,
  brakeForce: 4200,
  handbrakeForce: 7000,
  drag: 0.035,
  maxSteer: 0.58,
  steerRate: 3.2,
  suspensionRest: 0.36,
  suspensionStiffness: 28,
  maxSuspensionForce: 34_000,
  paint: 0xd8d4c8,
};

/** A flatbed truck on three axles: heavy, and it stops like it. */
const TRUCK: VehicleSpec = {
  ...COMMON,
  cls: 'truck',
  name: 'Truck',
  mass: 7500,
  halfLength: 4.2,
  halfHeight: 1.35,
  halfWidth: 1.25,
  wheelRadius: 0.52,
  wheelWidth: 0.34,
  wheels: sixWheelsOf(2.7, 0.66, 1.1, -0.72),
  enginePower: 34_000,
  topSpeed: 33,
  brakeForce: 9000,
  handbrakeForce: 14_000,
  drag: 0.05,
  maxSteer: 0.52,
  steerRate: 2.4,
  suspensionRest: 0.44,
  suspensionStiffness: 34,
  suspensionTravel: 0.16,
  maxSuspensionForce: 90_000,
  paint: 0x2f5d86,
};

/** A city bus: the longest thing on the roads and the slowest away from a stop. */
const BUS: VehicleSpec = {
  ...COMMON,
  cls: 'bus',
  name: 'Bus',
  mass: 11_000,
  halfLength: 6,
  halfHeight: 1.5,
  halfWidth: 1.28,
  wheelRadius: 0.52,
  wheelWidth: 0.32,
  wheels: wheelsOf(3.8, 1.12, -0.9),
  enginePower: 42_000,
  topSpeed: 30,
  brakeForce: 12_000,
  handbrakeForce: 18_000,
  drag: 0.055,
  maxSteer: 0.54,
  steerRate: 2.1,
  suspensionRest: 0.46,
  suspensionStiffness: 32,
  suspensionTravel: 0.16,
  maxSuspensionForce: 120_000,
  paint: 0xc4592f,
};

/**
 * A motorcycle: the quickest thing here away from a standstill, the one that
 * turns in the smallest circle, and the only one a rider has to hold upright.
 *
 * Its engine is small against its weight for a reason. The drive is taken at
 * the rear contact patch, half a metre below the middle of the bike, and the
 * only thing holding the front wheel down is the bike's own weight over a
 * wheelbase of a metre and a half. Enough power and it does not accelerate, it
 * loops.
 */
const MOTORCYCLE: VehicleSpec = {
  ...COMMON,
  cls: 'motorcycle',
  name: 'Motorcycle',
  mass: 220,
  halfLength: 1.05,
  halfHeight: 0.3,
  halfWidth: 0.34,
  wheelRadius: 0.32,
  wheelWidth: 0.14,
  // A pair at each end, a hand's width apart: Rapier takes a vehicle's roll
  // stiffness from where its wheels stand, so two wheels on the centreline
  // have none and the bike falls over the moment it is touched. A track this
  // narrow is enough to stand it up and little enough that it still turns like
  // a bike. `inline` below is what draws the two wheels the rider sees.
  wheels: wheelsOf(0.76, 0.085, -0.02),
  enginePower: 2200,
  topSpeed: 58,
  brakeForce: 1400,
  handbrakeForce: 2200,
  drag: 0.03,
  maxSteer: 0.8,
  steerAtSpeed: 0.16,
  steerRate: 5.8,
  suspensionRest: 0.22,
  suspensionStiffness: 44,
  suspensionTravel: 0.12,
  maxSuspensionForce: 8000,
  balance: 1500,
  inline: true,
  paint: 0x1f1f24,
};

/** A four-wheel drive off-roader: tall, soft and happy off the tarmac. */
const OFFROAD: VehicleSpec = {
  ...COMMON,
  cls: 'offroad',
  name: 'Off-roader',
  mass: 2200,
  halfLength: 2.45,
  halfHeight: 0.92,
  halfWidth: 1.02,
  wheelRadius: 0.42,
  wheelWidth: 0.32,
  // Every wheel driven, which is the whole point of it.
  wheels: wheelsOf(1.52, 0.88, -0.5).map((w) => ({ ...w, driven: true })),
  tyres: KNOBBLY,
  enginePower: 13_000,
  topSpeed: 46,
  brakeForce: 4800,
  handbrakeForce: 8000,
  drag: 0.04,
  maxSteer: 0.64,
  steerRate: 3.5,
  suspensionRest: 0.42,
  suspensionStiffness: 22,
  suspensionTravel: 0.3,
  maxSuspensionForce: 40_000,
  paint: 0x6f7350,
};

/** A beach buggy: an engine, a cage and four fat tyres. Sand is what it is for. */
const BUGGY: VehicleSpec = {
  ...COMMON,
  cls: 'buggy',
  name: 'Beach buggy',
  mass: 700,
  halfLength: 1.9,
  halfHeight: 0.5,
  halfWidth: 0.98,
  wheelRadius: 0.4,
  wheelWidth: 0.38,
  wheels: wheelsOf(1.25, 0.96, -0.3),
  tyres: { grip: 0.98, loose: 1.55 },
  enginePower: 7000,
  topSpeed: 40,
  brakeForce: 2200,
  handbrakeForce: 4200,
  drag: 0.05,
  maxSteer: 0.72,
  steerRate: 4.8,
  suspensionRest: 0.38,
  suspensionStiffness: 20,
  suspensionTravel: 0.3,
  maxSuspensionForce: 16_000,
  paint: 0xe2622c,
};

/** A patrol car: a saloon with the engine and the tyres it is given for the job. */
const EMERGENCY: VehicleSpec = {
  ...COMMON,
  cls: 'emergency',
  name: 'Patrol car',
  mass: 1500,
  halfLength: 2.35,
  halfHeight: 0.58,
  halfWidth: 0.92,
  wheelRadius: 0.35,
  wheelWidth: 0.26,
  wheels: wheelsOf(1.42, 0.82, -0.24),
  tyres: { grip: 1.14, loose: 0.96 },
  enginePower: 14_000,
  topSpeed: 64,
  brakeForce: 4000,
  handbrakeForce: 7000,
  drag: 0.02,
  maxSteer: 0.65,
  steerRate: 4.5,
  suspensionRest: 0.32,
  suspensionStiffness: 30,
  maxSuspensionForce: 28_000,
  alarm: true,
  paint: 0xe8e8ec,
  trim: 0x151b28,
};

/** A speedboat: no wheels, a hull and a rudder that only bites under way. */
const BOAT: VehicleSpec = {
  ...COMMON,
  cls: 'boat',
  name: 'Speedboat',
  mass: 1400,
  halfLength: 3,
  halfHeight: 0.7,
  halfWidth: 1.05,
  wheelRadius: 0,
  wheelWidth: 0,
  wheels: [],
  enginePower: 0,
  topSpeed: 28,
  brakeForce: 0,
  handbrakeForce: 0,
  drag: 0.01,
  maxSteer: 0,
  steerRate: 0,
  suspensionRest: 0,
  suspensionStiffness: 0,
  suspensionTravel: 0,
  maxSuspensionForce: 0,
  hull: {
    draft: 0.42,
    liftLength: 0.62,
    liftWidth: 0.6,
    buoyancy: 1.35,
    heave: 2.4,
    thrust: 9000,
    topSpeed: 28,
    reverse: 0.28,
    waterDrag: 0.12,
    sideDrag: 3.2,
    rudder: 9000,
  },
  alarm: true,
  luxury: true,
  paint: 0xf2f4f5,
  trim: 0x1d5c7a,
};

/** The roster of spec section 11.3. Read it with {@link specOf}. */
export const ROSTER: Record<VehicleClass, VehicleSpec> = {
  compact: COMPACT,
  saloon: SALOON,
  sports: SPORTS,
  van: VAN,
  truck: TRUCK,
  bus: BUS,
  motorcycle: MOTORCYCLE,
  offroad: OFFROAD,
  buggy: BUGGY,
  emergency: EMERGENCY,
  boat: BOAT,
};

/** The class a new session starts in. */
export const DEFAULT_CLASS: VehicleClass = 'saloon';

/** What a class is made of. An unknown class from an old save falls back on the default. */
export function specOf(cls: VehicleClass): VehicleSpec {
  return ROSTER[cls] ?? ROSTER[DEFAULT_CLASS];
}
