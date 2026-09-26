/**
 * The shape of every vehicle class (spec sections 10.1, 11.3).
 *
 * The camera looks down from 60 m, so what a vehicle needs is a silhouette that
 * reads at a glance: how long it is, how wide, what stands on its roof and
 * which end is the nose. The road bodies and a bike's pieces are lofted
 * (`vehicle-hull.ts`, `loft.ts`); the rest are boxes, and this file is the one
 * place that says which parts each class is made of.
 *
 * It is a plain function of the roster row, with no three.js in it, so the
 * silhouettes can be measured headless. `vehicle.ts` turns the boxes into a
 * model.
 *
 * Every box is in the vehicle's own frame: `length` runs along local `+x`,
 * which is forward, `height` along `+y` and `width` along `+z`, the axle.
 */
import type { Panel } from '../../sim/vehicles/damage.ts';
import { doorAlong } from '../../sim/player/boarding.ts';
import { isAircraft, type VehicleSpec } from '../../sim/vehicles/vehicle.ts';
import { aircraftBoxes } from './aircraft-mesh.ts';
import { arc, loft } from './loft.ts';
import { boat, buggy } from './open-craft.ts';
import { BODY_WIDTH, hullOf } from './vehicle-hull.ts';
import { BEACON_BLUE, BEACON_RED, box, GLASS, LAMP, METAL, SEAT, TAIL, TYRE, UNDER, type VehicleBox } from './vehicle-parts.ts';

export {
  BONNET,
  GLASS,
  LAMP,
  METAL,
  SEAT,
  SPARK,
  TAIL,
  TYRE,
  type Hinge,
  type VehicleBox,
} from './vehicle-parts.ts';

/**
 * The boxes one vehicle is drawn as, each told which panel it stands on.
 *
 * The panel is read off where the box sits rather than written into every
 * shape: a box above the waist is the roof, one at either end is the nose or
 * the tail, and one out at the flank is a door. A class with no box at a panel
 * simply has nothing there to be seen to go.
 */
export function vehicleBoxes(spec: VehicleSpec): VehicleBox[] {
  const boxes = shapeOf(spec);
  for (const part of boxes) {
    // A lofted part says which panel it was cut for; a box is read off where it stands.
    if (part.on === undefined) part.panel = panelAt(spec, part);
    else part.panel = part.on === 'shell' ? undefined : part.on;
  }
  return boxes;
}

/**
 * Which panel a box stands on. The roof is taken first, so a light bar goes
 * with the roof rather than with the side it sits over, and the ends before the
 * flanks, so a lamp at a corner goes with the nose it lights the way from.
 */
export function panelAt(spec: VehicleSpec, part: VehicleBox): Panel | undefined {
  // A vehicle ridden astride has no roof. What stands over its waist is the
  // tank, the seat and the bars, and each of those belongs to the end of the
  // bike it is at: a bike is damaged at the ends, which is where it hits.
  if (!spec.inline && part.y > spec.halfHeight * 0.2) return 'roof';
  if (part.x > spec.halfLength * 0.4) return 'front';
  if (part.x < -spec.halfLength * 0.4) return 'rear';
  if (Math.abs(part.z) > spec.halfWidth * 0.45) return part.z > 0 ? 'left' : 'right';
  return undefined;
}

/** The boxes of one class, before they are told which panel they are on. */
function shapeOf(spec: VehicleSpec): VehicleBox[] {
  switch (spec.cls) {
    case 'emergency':
      return patrolCar(spec);
    case 'sports':
      return lofted(spec, [
        // A wing on two posts over the tail.
        ...[1, -1].map((z) => block(spec, [-0.93, -0.87], [0.6, 0.84], z * 0.55, 0.04, spec.trim)),
        block(spec, [-0.99, -0.84], [0.84, 0.92], 0, 0.96, spec.trim),
      ]);
    case 'offroad':
      return lofted(spec, [
        // The rack, which is the one thing that tells this from a tall van above.
        block(spec, [-0.62, 0.22], [1, 1.05], 0, 0.76, spec.trim),
        // A spare wheel on the back door, and a dark flare over each wheel.
        block(spec, [-1.09, -1], [0.26, 0.62], 0, 0.32, TYRE),
        ...[1, -1].flatMap((z) => [
          block(spec, [0.44, 0.8], [0.1, 0.34], z, 0.08, spec.trim),
          block(spec, [-0.8, -0.44], [0.1, 0.34], z, 0.08, spec.trim),
        ]),
      ]);
    case 'van':
      return lofted(spec, [
        // A vent on the roof, which breaks up a flat white roof from above.
        block(spec, [-0.32, -0.08], [1, 1.05], 0, 0.5, spec.trim),
        block(spec, [0.97, 1.03], [0.04, 0.16], 0, 0.92, BAR_BASE),
        block(spec, [-1.04, -0.98], [0.02, 0.14], 0, 0.98, BAR_BASE),
      ]);
    case 'truck':
      return lofted(spec, [
        // The chassis, the deck behind the cab and the headboard that stops the load.
        block(spec, [-1, 0.6], [0.12, 0.26], 0, 0.5, UNDER),
        block(spec, [-1, 0.52], [0.28, 0.38], 0, 1.08, spec.trim),
        block(spec, [0.5, 0.54], [0.38, 0.78], 0, 1.04, spec.trim),
        block(spec, [0.55, 0.57], [0.4, 1.1], 0.8, 0.06, METAL),
        block(spec, [0.99, 1.03], [0.08, 0.2], 0, 0.98, BAR_BASE),
      ]);
    case 'bus':
      return lofted(spec, [
        // A roof hatch and the air conditioning, so the roof is not one flat colour from above.
        block(spec, [0.2, 0.36], [1, 1.03], 0, 0.4, spec.trim),
        block(spec, [-0.5, -0.1], [1, 1.06], 0, 0.6, spec.trim),
      ]);
    case 'motorcycle':
      return motorcycle(spec);
    case 'buggy':
      return buggy(spec);
    case 'boat':
      return boat(spec);
    default:
      if (isAircraft(spec.cls)) return aircraftBoxes(spec);
      return lofted(spec, []);
  }
}

/** A lofted body (`vehicle-hull.ts`) with the class's own boxes on it. */
function lofted(spec: VehicleSpec, extras: VehicleBox[], patrol = false): VehicleBox[] {
  return [...(hullOf(spec, patrol) ?? []), ...extras];
}

/**
 * A box placed the way a hull is drawn: along the body and up it as fractions
 * of the half length and of the height from the floor, and across it as
 * fractions of the body's half width.
 */
function block(
  spec: VehicleSpec,
  along: readonly [number, number],
  up: readonly [number, number],
  across: number,
  halfWidth: number,
  colour: number,
): VehicleBox {
  const width = spec.halfWidth * BODY_WIDTH;
  const height = spec.halfHeight * 2;
  return box(
    (along[1] - along[0]) * spec.halfLength,
    (up[1] - up[0]) * height,
    halfWidth * width * 2,
    colour,
    ((along[0] + along[1]) / 2) * spec.halfLength,
    -spec.halfHeight + ((up[0] + up[1]) / 2) * height,
    across * width,
  );
}

/**
 * The front door on one side of a vehicle, in its own frame: the edge it
 * swings about, its length, how far out from the middle it stands, and its
 * middle and height. Undefined on a class with no door that swings.
 */
export interface Door {
  hingeX: number;
  length: number;
  z: number;
  y: number;
  height: number;
}

/** The front door on the side `side` stands on, -1 the driver's and +1 the other. */
export function doorOf(spec: VehicleSpec, side: number): Door | undefined {
  const leaf = side < 0 ? 0 : 1;
  const part = vehicleBoxes(spec).find((b) => b.hinge?.leaf === leaf && b.hinge.axis === 'y' && b.glass !== true);
  if (part === undefined) return undefined;
  return { hingeX: part.x + part.length / 2, length: part.length, z: part.z, y: part.y, height: part.height };
}

/**
 * Where the driver's hips rest, in the vehicle's own frame. A class ridden
 * astride has its saddle instead (`saddleOf`). The seat is under the roof, so
 * it only has to be near enough for the body to be seen going to it.
 */
export function seatOf(spec: VehicleSpec): { x: number; y: number; z: number } {
  const length = spec.halfLength * 2;
  const y = -spec.halfHeight + Math.min(0.5, spec.halfHeight);
  const z = -spec.halfWidth * 0.42;
  const door = doorOf(spec, -1);
  if (door !== undefined) return { x: door.hingeX - door.length * 0.7, y, z };
  switch (spec.cls) {
    case 'van':
    case 'truck':
    case 'bus':
      return { x: doorAlong(spec) + 0.1, y, z };
    case 'buggy':
      return { x: -length * 0.06 + 0.3, y, z: -spec.halfWidth * 0.36 };
    case 'boat':
      return { x: doorAlong(spec), y, z: -spec.halfWidth * 0.3 };
    default:
      // A pilot sits just inside the cabin door, not amidships.
      return { x: isAircraft(spec.cls) ? doorAlong(spec) : 0, y, z };
  }
}

/** The dark base of a light bar, a push bar and the like. */
const BAR_BASE = 0x1b1d22;

/** A lamp that flashes, and which of the two phases of the flash it burns in (`beacons.ts`). */
export interface Beacon {
  box: Omit<VehicleBox, 'panel'>;
  phase: 0 | 1;
}

/**
 * The two halves of a patrol car's light bar: red on the left, blue on the
 * right. `vehicleBoxes` draws them unlit, and `police.ts` flashes them.
 */
export function patrolBeacons(spec: VehicleSpec): Beacon[] {
  const width = spec.halfWidth * 2;
  const x = -spec.halfLength * 0.1;
  const half = (colour: number, z: number, phase: 0 | 1): Beacon => ({
    box: { length: 0.26, height: 0.13, width: width * 0.36, x, y: spec.halfHeight + 0.13, z, colour },
    phase,
  });
  return [half(BEACON_RED, -width * 0.2, 0), half(BEACON_BLUE, width * 0.2, 1)];
}

/**
 * A patrol car: a saloon in black and white — dark ends and a white middle —
 * a light bar across the roof and a push bar on the nose. From above that is a
 * white box between two black ends with a red and blue bar across it, which no
 * other car in the city is.
 */
function patrolCar(spec: VehicleSpec): VehicleBox[] {
  const width = spec.halfWidth * 2;
  const extras = [
    // The bar: a dark base across the roof, and the two halves over it.
    box(0.3, 0.06, width * 0.8, BAR_BASE, -spec.halfLength * 0.1, spec.halfHeight + 0.04, 0),
    ...patrolBeacons(spec).map(({ box: b }) => box(b.length, b.height, b.width, b.colour, b.x, b.y, b.z)),
    // The push bar on the nose, which is the one part of it wider than a saloon's front.
    box(0.12, spec.halfHeight * 0.6, width * 0.7, BAR_BASE, spec.halfLength + 0.08, -spec.halfHeight * 0.5, 0),
    // A spotlight on the driver's pillar.
    box(0.16, 0.1, 0.1, METAL, spec.halfLength * 0.24, spec.halfHeight * 0.3, -width * 0.46),
  ];
  return lofted(spec, extras, true);
}

/**
 * Where a rider meets a vehicle they sit astride, in the vehicle's own frame.
 * These are the three places the pose in `rider.ts` is built on, so a bike
 * moved here moves the rider on it with no second table to keep in step.
 */
export interface Saddle {
  /** The middle of the seat, and the top of it: where the hips rest. */
  x: number;
  y: number;
  /** Where the hands close on the bars, and how far out each grip stands. */
  gripX: number;
  gripY: number;
  gripZ: number;
  /** Where the boots stand on the pegs, and how far out each peg stands. */
  pegX: number;
  pegY: number;
  pegZ: number;
}

/** The saddle of a class ridden astride, and undefined on everything else. */
export function saddleOf(spec: VehicleSpec): Saddle | undefined {
  return spec.inline ? saddle(spec) : undefined;
}

/** The saddle of a bike, read whether or not the class is ridden. */
function saddle(spec: VehicleSpec): Saddle {
  // A rider's arms are half a metre long, so the bars stand where a seated
  // body can hold them: any further forward and the hands come off them.
  return {
    x: -spec.halfLength * 0.22,
    y: spec.halfHeight * 0.67,
    gripX: spec.halfLength * 0.4,
    gripY: spec.halfHeight * 1.67,
    gripZ: spec.halfWidth * 0.88,
    pegX: -spec.halfLength * 0.17,
    pegY: -spec.halfHeight * 1.23,
    pegZ: spec.halfWidth * 0.68,
  };
}

/**
 * A motorcycle, built round the rider sat on it (`rider.ts`).
 *
 * A bike is not a small car, so it is not drawn as one box with lamps on it.
 * What says motorcycle from 60 m up is the line of it — a wheel at each end,
 * the tank and the seat strung between them, the bars a T across the front —
 * and what says it from close to are the parts no car has: fork legs, a
 * swingarm, an exhaust down one side, a mirror out past each grip.
 *
 * The places the rider touches come from {@link saddleOf}, so the seat, the
 * grips and the pegs are drawn exactly where the pose puts the body on them.
 */
function motorcycle(spec: VehicleSpec): VehicleBox[] {
  const seat = saddle(spec);
  const wheelY = -0.24;
  const front = spec.halfLength * 0.72;
  const rear = -front;
  const parts = [
    // The tank swells up from the steering head and tapers into the seat: the
    // paint, and the one shape that says motorcycle from above.
    loft([
      { x: 0.4, bottom: 0.14, top: 0.26, half: 0.06 },
      { x: 0.3, bottom: 0.0, top: 0.33, half: 0.13 },
      { x: 0.14, bottom: -0.02, top: 0.35, half: 0.15 },
      { x: 0.02, bottom: 0.02, top: 0.27, half: 0.12 },
      { x: -0.04, bottom: 0.07, top: 0.2, half: 0.08 },
    ], spec.paint, 0.45),
    // The seat, dished where the rider sits, its top at the saddle.
    loft([
      { x: 0.0, bottom: 0.12, top: seat.y, half: 0.09 },
      { x: -0.1, bottom: 0.1, top: seat.y - 0.025, half: 0.14 },
      { x: -0.3, bottom: 0.1, top: seat.y - 0.02, half: 0.14 },
      { x: -0.46, bottom: 0.14, top: seat.y, half: 0.1 },
    ], SEAT, 0.5),
    // The tail rises from under the seat to a point over the rear wheel.
    loft([
      { x: -0.2, bottom: -0.04, top: 0.12, half: 0.1 },
      { x: -0.5, bottom: 0.06, top: 0.16, half: 0.11 },
      { x: -0.78, bottom: 0.16, top: 0.25, half: 0.07 },
      { x: -0.9, bottom: 0.2, top: 0.26, half: 0.04 },
    ], spec.paint, 0.4),
    box(0.05, 0.05, 0.12, TAIL, -0.9, 0.24, 0),
    // The frame runs down from the steering head to the swingarm's pivot.
    loft([
      { x: 0.46, bottom: 0.24, top: 0.42, half: 0.04 },
      { x: 0.2, bottom: -0.1, top: 0.04, half: 0.05 },
      { x: -0.14, bottom: -0.34, top: -0.16, half: 0.06 },
    ], spec.trim),
    // The engine, hung under the tank, and its head leaning forwards.
    loft([
      { x: 0.24, bottom: -0.36, top: -0.12, half: 0.1 },
      { x: 0.12, bottom: -0.46, top: -0.02, half: 0.15 },
      { x: -0.08, bottom: -0.46, top: -0.06, half: 0.15 },
      { x: -0.18, bottom: -0.38, top: -0.14, half: 0.1 },
    ], METAL, 0.45),
    // The nacelle round the headlamp, and the small screen on top of it.
    loft([
      { x: 0.64, bottom: 0.32, top: 0.46, half: 0.08 },
      { x: 0.54, bottom: 0.24, top: 0.52, half: 0.13 },
      { x: 0.42, bottom: 0.28, top: 0.48, half: 0.09 },
    ], spec.paint, 0.5),
    loft([
      { x: 0.6, bottom: 0.47, top: 0.5, half: 0.08 },
      { x: 0.46, bottom: 0.52, top: 0.66, half: 0.1 },
    ], GLASS, 0.3),
    box(0.04, 0.12, 0.13, LAMP, 0.65, 0.39, 0),
    // A mudguard bent round each wheel.
    loft(arc(front, wheelY, spec.wheelRadius + 0.05, 0.45, 2.1, 0.04, 0.07), spec.paint),
    loft(arc(rear, wheelY, spec.wheelRadius + 0.05, 1.2, 2.5, 0.04, 0.08), spec.trim),
    // The exhaust: a pipe out of the engine, under the peg, swelling into the
    // silencer that rises past the rear wheel on the right side.
    loft([
      { x: 0.2, bottom: -0.34, top: -0.26, half: 0.035, z: -0.12 },
      { x: 0.04, bottom: -0.52, top: -0.45, half: 0.035, z: -0.17 },
      { x: -0.3, bottom: -0.48, top: -0.41, half: 0.035, z: -0.2 },
      { x: -0.44, bottom: -0.42, top: -0.28, half: 0.065, z: -0.21 },
      { x: -0.8, bottom: -0.28, top: -0.16, half: 0.055, z: -0.21 },
    ], METAL, 0.5),
    // The bars, on a stem up from the forks: the one part of a bike wider than
    // the bike, and the T it reads as from straight above.
    box(0.16, 0.08, 0.1, BAR_BASE, seat.gripX - 0.06, seat.gripY - 0.05, 0),
    box(0.05, 0.05, seat.gripZ * 2 + 0.14, METAL, seat.gripX, seat.gripY, 0),
  ];
  for (const side of [1, -1]) {
    // A raked fork leg and a swingarm each side, a peg for each boot, a grip
    // at each end of the bars and a mirror on a stalk out past it.
    parts.push(
      loft([
        { x: seat.gripX + 0.02, bottom: 0.26, top: 0.44, half: 0.03, z: side * 0.09 },
        { x: front, bottom: wheelY - 0.02, top: wheelY + 0.1, half: 0.025, z: side * 0.09 },
      ], METAL, 0.5),
    );
    parts.push(
      loft([
        { x: -0.12, bottom: -0.36, top: -0.24, half: 0.03, z: side * 0.11 },
        { x: rear, bottom: wheelY - 0.04, top: wheelY + 0.04, half: 0.025, z: side * 0.11 },
      ], spec.trim, 0.5),
    );
    parts.push(box(0.08, 0.04, 0.12, METAL, seat.pegX, seat.pegY, side * seat.pegZ));
    parts.push(box(0.09, 0.07, 0.14, SEAT, seat.gripX, seat.gripY, side * seat.gripZ));
    parts.push(box(0.03, 0.12, 0.03, METAL, seat.gripX, seat.gripY + 0.08, side * (seat.gripZ + 0.04)));
    parts.push(box(0.03, 0.06, 0.12, METAL, seat.gripX, seat.gripY + 0.16, side * (seat.gripZ + 0.1)));
  }
  return parts;
}
