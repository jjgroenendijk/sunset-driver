/**
 * The vehicles of spec section 11.3: the roster, and what one is made of.
 *
 * This holds four things and nothing else: the numbers one vehicle is made of,
 * the table of every class, the serialisable state of one vehicle, and what a
 * tyre finds on each surface. `physics.ts` turns them into a Rapier body and
 * either a `DynamicRayCastVehicleController` or the boat controller; nothing
 * here touches Rapier, so the whole roster can be read headless.
 *
 * The vehicle's own frame has forward along local `+x`, up along `+y` and the
 * axle along `+z`, which is the frame the character model already uses: a yaw
 * of `-heading` about `y` points local `+x` along `(cos heading, sin heading)`
 * on the map. Map `y` is world `z`, as everywhere else in the renderer.
 *
 * A vehicle's class is carried in its state, so the record says what is being
 * driven and the body, the model and the handling are all rebuilt from it.
 */
import type { Surface } from '../world/surface.ts';
import { createDamageState, type DamageState } from './damage.ts';

/**
 * The classes of spec section 11.3, in the order the debug picker shows them:
 * the ordinary cars first, then the big vehicles, then the specials.
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
  | 'boat';

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

/** Road tyres: the reference every other set is measured against. */
export const ROAD_TYRES: TyreSpec = { grip: 1, loose: 1 };

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
  maxSteer: 0.58,
  steerRate: 3.4,
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
  maxSteer: 0.55,
  steerRate: 3.2,
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
  maxSteer: 0.5,
  steerAtSpeed: 0.22,
  steerRate: 4.2,
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
  maxSteer: 0.48,
  steerRate: 2.6,
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
  maxSteer: 0.42,
  steerRate: 1.9,
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
  maxSteer: 0.44,
  steerRate: 1.7,
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
  maxSteer: 0.7,
  steerAtSpeed: 0.16,
  steerRate: 4.6,
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
  maxSteer: 0.54,
  steerRate: 2.8,
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
  maxSteer: 0.62,
  steerRate: 3.8,
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
  maxSteer: 0.55,
  steerRate: 3.6,
  suspensionRest: 0.32,
  suspensionStiffness: 30,
  maxSuspensionForce: 28_000,
  alarm: true,
  paint: 0xe8e8ec,
  trim: 0x16325c,
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
   * True once its lock has been beaten (spec section 11.4). A vehicle that
   * needs no hotwiring never reads it; one that does is worked at once and not
   * again, so stepping out to look at something is not a second break-in.
   */
  hotwired: boolean;
}

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
    afloat: false,
    damage: createDamageState(),
    hotwired: false,
  };
}

/** Which way a vehicle points on the map, in radians. */
export function headingOf(v: VehicleState): number {
  // The forward axis is local +x, so this is that axis turned by the rotation.
  const fx = 1 - 2 * (v.qy * v.qy + v.qz * v.qz);
  const fz = 2 * (v.qx * v.qz - v.qy * v.qw);
  return Math.atan2(fz, fx);
}
