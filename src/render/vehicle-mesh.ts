/**
 * The shape of every vehicle class (spec sections 10.1, 11.3).
 *
 * The camera looks down from 60 m, so what a vehicle needs is a silhouette that
 * reads at a glance: how long it is, how wide, what stands on its roof and
 * which end is the nose. That is boxes, as the character model and the smaller
 * buildings are, and this file is the one place that says which boxes.
 *
 * It is a plain function of the roster row, with no three.js in it, so the
 * silhouettes can be measured headless. `vehicle.ts` turns the boxes into a
 * model.
 *
 * Every box is in the vehicle's own frame: `length` runs along local `+x`,
 * which is forward, `height` along `+y` and `width` along `+z`, the axle.
 */
import type { Panel } from '../sim/damage.ts';
import { doorAlong } from '../sim/boarding.ts';
import { isAircraft, type VehicleSpec } from '../sim/vehicle.ts';
import { aircraftBoxes } from './aircraft-mesh.ts';

/** Glass, lamps and the bare metal of a cage: the colours no row picks. */
export const GLASS = 0x2e3a6a;
export const LAMP = 0xffe7b0;
export const TAIL = 0x6e1210;
export const METAL = 0xb8b3cc;
export const TYRE = 0x2f2838;
/** The dark of a seat, which is plum leather on every bike in the city. */
export const SEAT = 0x3a2a3e;
/** The blue-white of the arc at a tram's pantograph (`tram.ts`). */
export const SPARK = 0xbcd6ff;
/** The blue and red of a patrol car's light bar. */
export const BEACON_BLUE = 0x2f6fe0;
export const BEACON_RED = 0xd32c2c;

/** One box of a vehicle's model. */
export interface VehicleBox {
  length: number;
  height: number;
  width: number;
  /** The middle of the box, in the vehicle's own frame. */
  x: number;
  y: number;
  z: number;
  colour: number;
  /**
   * The panel this box belongs to (spec section 11.3), and undefined on the
   * shell in the middle of the body. A dent pushes in the boxes of the panel
   * it lands on, and a panel torn off takes its boxes with it; the shell stays,
   * because a vehicle with no middle is not a vehicle.
   */
  panel: Panel | undefined;
  /**
   * True on a front door, which swings open about its front edge while the
   * player gets in or out (`boarding.ts`). Nothing else on a vehicle moves.
   */
  hinged?: boolean;
  /**
   * Set on a rotor blade, which turns about the vehicle's up axis, and on a
   * propeller blade, which turns about its forward axis (`aircraft-mesh.ts`).
   */
  spin?: 'rotor' | 'prop';
}

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
  for (const part of boxes) part.panel = panelAt(spec, part);
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
    case 'compact':
      return car(spec, { cabin: 0.5, cabinAt: 0, waist: 0.5 });
    case 'sports':
      return car(spec, { cabin: 0.34, cabinAt: -0.2, waist: 0.62 });
    case 'emergency':
      return patrolCar(spec);
    case 'van':
      return van(spec);
    case 'truck':
      return truck(spec);
    case 'bus':
      return bus(spec);
    case 'motorcycle':
      return motorcycle(spec);
    case 'offroad':
      return offroad(spec);
    case 'buggy':
      return buggy(spec);
    case 'boat':
      return boat(spec);
    default:
      if (isAircraft(spec.cls)) return aircraftBoxes(spec);
      return car(spec, { cabin: 0.44, cabinAt: -0.05, waist: 0.55 });
  }
}

/** Where a car's cabin sits, as fractions of the body it stands on. */
interface CarShape {
  /** The cabin's length, as a fraction of the whole. */
  cabin: number;
  /** Where its middle stands, as a fraction of the whole from the middle of the body. */
  cabinAt: number;
  /** How much of the height the lower body takes; the cabin takes the rest. */
  waist: number;
}

function box(
  length: number,
  height: number,
  width: number,
  colour: number,
  x: number,
  y: number,
  z: number,
): VehicleBox {
  return { length, height, width, x, y, z, colour, panel: undefined };
}

/**
 * A door skin down each side of a body, half sunk into it so nothing z-fights.
 * It is what a shunt from the side pushes in and what a hard one tears off:
 * without it a flank is one face of the shell, and a shell never goes.
 *
 * A `hinged` skin is two doors, front and rear, and the front one opens: it is
 * the door the player gets in and out through. A van's skin is its sliding
 * door, which does not swing, so it stays one piece.
 */
function doors(spec: VehicleSpec, length: number, height: number, y: number, at: number, hinged = false): VehicleBox[] {
  const out: VehicleBox[] = [];
  for (const side of [1, -1]) {
    const z = side * spec.halfWidth * at;
    if (!hinged) {
      out.push(box(length, height, 0.06, spec.paint, 0, y, z));
      continue;
    }
    out.push({ ...box(length / 2, height, 0.06, spec.paint, length / 4, y, z), hinged: true });
    out.push(box(length / 2, height, 0.06, spec.paint, -length / 4, y, z));
  }
  return out;
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
  const part = vehicleBoxes(spec).find((b) => b.hinged === true && Math.sign(b.z) === Math.sign(side));
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

/**
 * A car: a lower body, a cabin set back from the nose, glass at each end of the
 * cabin and along it, and a lamp at each corner. A bonnet at one end and a boot
 * at the other is what tells a player which way the car is facing from 60 m up.
 */
function car(spec: VehicleSpec, shape: CarShape): VehicleBox[] {
  const length = spec.halfLength * 2;
  const width = spec.halfWidth * 2;
  const height = spec.halfHeight * 2;
  const bodyHeight = height * shape.waist;
  const bodyY = -spec.halfHeight + bodyHeight / 2;
  const cabinHeight = height - bodyHeight;
  const cabinY = bodyY + bodyHeight / 2 + cabinHeight / 2;
  const cabinLength = length * shape.cabin;
  const cabinX = length * shape.cabinAt;
  const boxes = [
    // The body is narrower than the track, so the wheels show from above.
    box(length, bodyHeight, width * 0.9, spec.paint, 0, bodyY, 0),
    box(cabinLength, cabinHeight, width * 0.8, spec.paint, cabinX, cabinY, 0),
    // Glass a little proud of the cabin, so the windows read as windows.
    box(length * 0.06, cabinHeight * 0.82, width * 0.82, GLASS, cabinX + cabinLength / 2, cabinY, 0),
    box(length * 0.05, cabinHeight * 0.82, width * 0.82, GLASS, cabinX - cabinLength / 2, cabinY, 0),
    box(cabinLength * 0.7, cabinHeight * 0.5, width * 0.83, GLASS, cabinX, cabinY + cabinHeight * 0.08, 0),
    ...doors(spec, length * 0.46, bodyHeight * 0.6, bodyY, 0.9, true),
    // A bonnet at the nose and a boot at the tail, sitting on the body: they
    // are the panels a shunt at either end pushes in, and a hard enough one
    // takes them off and leaves the shell.
    box(length * 0.22, bodyHeight * 0.3, width * 0.86, spec.paint, spec.halfLength - length * 0.13, bodyY + bodyHeight * 0.36, 0),
    box(length * 0.2, bodyHeight * 0.3, width * 0.86, spec.paint, -spec.halfLength + length * 0.12, bodyY + bodyHeight * 0.36, 0),
  ];
  return [...boxes, ...lamps(spec, bodyY + bodyHeight * 0.2)];
}

/** A lamp at each front corner and a tail light at each rear one. */
function lamps(spec: VehicleSpec, y: number): VehicleBox[] {
  const width = spec.halfWidth * 2;
  const out: VehicleBox[] = [];
  for (const side of [1, -1]) {
    out.push(box(0.1, 0.14, width * 0.22, LAMP, spec.halfLength - 0.04, y, side * width * 0.28));
    out.push(box(0.09, 0.14, width * 0.22, TAIL, -spec.halfLength + 0.04, y, side * width * 0.28));
  }
  return out;
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
 * A patrol car: a saloon in black and white — a dark body, bonnet and boot
 * with a white cabin and white doors — a light bar across the roof and a push
 * bar on the nose. From above that is a white box between two black ends with a
 * red and blue bar across it, which no other car in the city is.
 */
function patrolCar(spec: VehicleSpec): VehicleBox[] {
  const boxes = car(spec, { cabin: 0.42, cabinAt: -0.04, waist: 0.55 });
  const width = spec.halfWidth * 2;
  const length = spec.halfLength * 2;
  // The body is a car's first box, and the bonnet and the boot are the painted
  // boxes out at either end; the doors and the cabin keep the paint.
  for (const part of boxes) {
    if (part.colour !== spec.paint) continue;
    if (part === boxes[0] || Math.abs(part.x) > spec.halfLength * 0.4) part.colour = spec.trim;
  }
  // The bar: a dark base across the roof, and the two halves over it.
  boxes.push(box(0.3, 0.06, width * 0.8, BAR_BASE, -spec.halfLength * 0.1, spec.halfHeight + 0.04, 0));
  for (const beacon of patrolBeacons(spec)) {
    const b = beacon.box;
    boxes.push(box(b.length, b.height, b.width, b.colour, b.x, b.y, b.z));
  }
  // The push bar on the nose, which is the one part of it wider than a saloon's front.
  boxes.push(box(0.12, spec.halfHeight * 0.6, width * 0.7, BAR_BASE, spec.halfLength + 0.08, -spec.halfHeight * 0.5, 0));
  // A spotlight on the driver's pillar.
  boxes.push(box(0.16, 0.1, 0.1, METAL, length * 0.12, spec.halfHeight * 0.3, width * 0.43));
  return boxes;
}

/** A panel van: a cab at the nose and a tall blind box behind it. */
function van(spec: VehicleSpec): VehicleBox[] {
  const length = spec.halfLength * 2;
  const width = spec.halfWidth * 2;
  const height = spec.halfHeight * 2;
  const noseLength = length * 0.24;
  const noseHeight = height * 0.42;
  const noseY = -spec.halfHeight + noseHeight / 2;
  return [
    box(length - noseLength, height, width * 0.94, spec.paint, -noseLength / 2, 0, 0),
    box(noseLength, noseHeight, width * 0.9, spec.paint, spec.halfLength - noseLength / 2, noseY, 0),
    // The windscreen stands where the nose meets the box, which is what says
    // which end the driver sits at.
    box(length * 0.05, height * 0.4, width * 0.86, GLASS, spec.halfLength - noseLength, height * 0.06, 0),
    // A vent on the roof, which is the panel a van loses off the top of it and
    // the one thing that breaks up a flat white roof from above.
    box(length * 0.18, 0.09, width * 0.5, spec.trim, -length * 0.1, spec.halfHeight + 0.05, 0),
    // The sliding door down each side, which is the panel a van loses.
    ...doors(spec, length * 0.4, height * 0.34, -spec.halfHeight + height * 0.3, 0.94),
    ...lamps(spec, noseY),
  ];
}

/** A flatbed truck: a tall cab, a gap, then a deck with a headboard behind it. */
function truck(spec: VehicleSpec): VehicleBox[] {
  const length = spec.halfLength * 2;
  const width = spec.halfWidth * 2;
  const height = spec.halfHeight * 2;
  const cabLength = length * 0.26;
  const deckLength = length * 0.6;
  const deckHeight = height * 0.22;
  const deckY = -spec.halfHeight + height * 0.5;
  const deckX = -spec.halfLength + deckLength / 2;
  return [
    box(cabLength, height, width, spec.paint, spec.halfLength - cabLength / 2, 0, 0),
    box(length * 0.05, height * 0.36, width * 0.9, GLASS, spec.halfLength - cabLength, height * 0.2, 0),
    box(deckLength, deckHeight, width, spec.trim, deckX, deckY, 0),
    // The headboard behind the cab, which is what stops the load at 60 m up.
    box(length * 0.04, height * 0.4, width, spec.trim, deckX + deckLength / 2, deckY + height * 0.3, 0),
    ...lamps(spec, -spec.halfHeight + height * 0.22),
  ];
}

/** A city bus: one long box with a band of glass down each side. */
function bus(spec: VehicleSpec): VehicleBox[] {
  const length = spec.halfLength * 2;
  const width = spec.halfWidth * 2;
  const height = spec.halfHeight * 2;
  const bandY = height * 0.12;
  const boxes = [
    box(length, height, width, spec.paint, 0, 0, 0),
    box(length * 0.94, height * 0.3, width * 1.01, GLASS, -length * 0.02, bandY, 0),
    // The windscreen, a little taller than the band, at the driver's end.
    box(length * 0.03, height * 0.42, width * 0.94, GLASS, spec.halfLength, bandY, 0),
    // A roof hatch, so the roof is not one flat colour from above.
    box(length * 0.12, 0.08, width * 0.4, spec.trim, length * 0.2, spec.halfHeight + 0.04, 0),
  ];
  return [...boxes, ...lamps(spec, -spec.halfHeight + height * 0.12)];
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
  const length = spec.halfLength * 2;
  const width = spec.halfWidth * 2;
  const height = spec.halfHeight * 2;
  const seat = saddle(spec);
  const boxes = [
    // The frame, and the engine hung under it: the mass in the middle, which
    // everything else is bolted to and which a bike never loses.
    box(length * 0.52, height * 0.27, width * 0.44, spec.trim, -length * 0.01, -height * 0.27, 0),
    box(length * 0.24, height * 0.57, width * 0.44, METAL, length * 0.02, -height * 0.5, 0),
    // The tank in two, a wide lower half under a narrower top, so it rounds
    // off rather than standing there as a brick. It carries the bike's paint.
    box(length * 0.24, height * 0.33, width * 0.54, spec.paint, length * 0.2, height * 0.1, 0),
    box(length * 0.2, height * 0.2, width * 0.41, spec.paint, length * 0.19, height * 0.33, 0),
    // The seat, with its top at the saddle, and the tail rising behind it.
    box(length * 0.29, height * 0.17, width * 0.47, SEAT, seat.x, seat.y - height * 0.085, 0),
    box(length * 0.17, height * 0.37, width * 0.38, spec.paint, -length * 0.35, height * 0.27, 0),
    // The front: a mudguard over the wheel, and the lamp housing over that.
    box(length * 0.24, height * 0.13, width * 0.32, spec.paint, length * 0.38, height * 0.23, 0),
    box(length * 0.07, height * 0.5, width * 0.44, BAR_BASE, length * 0.41, height * 0.5, 0),
    box(0.06, height * 0.37, width * 0.32, LAMP, spec.halfLength - 0.09, height * 0.5, 0),
    // The back: a mudguard, the tail light on it, and the exhaust down the
    // right side with its silencer at the end of it.
    box(length * 0.24, height * 0.13, width * 0.35, spec.paint, -length * 0.38, height * 0.17, 0),
    box(0.08, height * 0.17, width * 0.32, TAIL, -spec.halfLength + 0.05, height * 0.3, 0),
    box(length * 0.38, height * 0.17, width * 0.15, METAL, -length * 0.17, -height * 0.5, -width * 0.32),
    box(length * 0.2, height * 0.23, width * 0.21, METAL, -length * 0.31, -height * 0.43, -width * 0.32),
    // The bars, on a stem up from the forks: the one part of a bike wider than
    // the bike, and the T it reads as from straight above.
    box(length * 0.18, height * 0.13, width * 0.15, BAR_BASE, length * 0.32, seat.gripY - height * 0.07, 0),
    box(0.07, 0.07, seat.gripZ * 2 + 0.14, METAL, seat.gripX, seat.gripY, 0),
  ];
  for (const side of [1, -1]) {
    // A fork leg and a swingarm each side, a peg for each boot, a grip at each
    // end of the bars and a mirror on a stalk out past it.
    boxes.push(box(length * 0.05, height * 1.1, width * 0.13, METAL, length * 0.36, height * 0.12, side * width * 0.19));
    boxes.push(box(length * 0.24, height * 0.15, width * 0.15, METAL, -length * 0.24, -height * 0.37, side * width * 0.18));
    boxes.push(box(length * 0.08, 0.04, width * 0.18, METAL, seat.pegX, seat.pegY, side * seat.pegZ));
    boxes.push(box(0.09, 0.09, 0.14, SEAT, seat.gripX, seat.gripY, side * seat.gripZ));
    boxes.push(box(0.04, height * 0.17, width * 0.2, METAL, seat.gripX, seat.gripY + height * 0.15, side * (seat.gripZ + 0.08)));
  }
  return boxes;
}

/** An off-roader: a tall body, glass all round and a rack on the roof. */
function offroad(spec: VehicleSpec): VehicleBox[] {
  const length = spec.halfLength * 2;
  const width = spec.halfWidth * 2;
  const height = spec.halfHeight * 2;
  const bodyHeight = height * 0.56;
  const bodyY = -spec.halfHeight + bodyHeight / 2;
  const cabinHeight = height - bodyHeight;
  const cabinY = bodyY + bodyHeight / 2 + cabinHeight / 2;
  return [
    box(length, bodyHeight, width * 0.92, spec.paint, 0, bodyY, 0),
    box(length * 0.66, cabinHeight, width * 0.88, spec.paint, -length * 0.06, cabinY, 0),
    box(length * 0.6, cabinHeight * 0.56, width * 0.9, GLASS, -length * 0.06, cabinY + cabinHeight * 0.12, 0),
    // The rack, which is the one thing that tells this from a tall van above.
    box(length * 0.42, 0.08, width * 0.74, spec.trim, -length * 0.1, spec.halfHeight + 0.05, 0),
    // A spare wheel on the back door.
    box(0.14, spec.wheelRadius * 1.6, spec.wheelRadius * 1.6, TYRE, -spec.halfLength - 0.07, bodyY + bodyHeight * 0.3, 0),
    ...doors(spec, length * 0.44, bodyHeight * 0.56, bodyY, 0.92, true),
    ...lamps(spec, bodyY + bodyHeight * 0.24),
  ];
}

/** A beach buggy: a floor pan, two seat backs and a roll cage over them. */
function buggy(spec: VehicleSpec): VehicleBox[] {
  const length = spec.halfLength * 2;
  const width = spec.halfWidth * 2;
  const height = spec.halfHeight * 2;
  const panHeight = height * 0.4;
  const panY = -spec.halfHeight + panHeight / 2;
  const boxes = [
    box(length * 0.92, panHeight, width * 0.78, spec.paint, 0, panY, 0),
    // The engine hangs out behind, as it does on the real thing.
    box(length * 0.2, height * 0.36, width * 0.55, spec.trim, -spec.halfLength + length * 0.06, panY + panHeight * 0.5, 0),
  ];
  for (const side of [1, -1]) {
    boxes.push(box(0.14, height * 0.46, width * 0.24, spec.trim, -length * 0.06, panY + panHeight * 0.7, side * width * 0.18));
    // The cage: an upright each side and a bar across the top of them.
    boxes.push(box(0.07, height * 0.7, 0.07, METAL, -length * 0.08, panY + panHeight * 0.9, side * width * 0.34));
    boxes.push(box(0.07, 0.07, width * 0.75, METAL, -length * 0.08, panY + panHeight * 0.5 + height * 0.6, 0));
  }
  return [...boxes, ...lamps(spec, panY + panHeight * 0.2)];
}

/** A speedboat: a hull that narrows to the bow, a screen and a console. */
function boat(spec: VehicleSpec): VehicleBox[] {
  const length = spec.halfLength * 2;
  const width = spec.halfWidth * 2;
  const height = spec.halfHeight * 2;
  const hullHeight = height * 0.7;
  const hullY = -spec.halfHeight + hullHeight / 2;
  return [
    // Three lengths of hull, each narrower than the one behind it: a bow that
    // comes to a point is what says which way a boat is pointing from above.
    box(length * 0.52, hullHeight, width, spec.paint, -spec.halfLength + length * 0.26, hullY, 0),
    box(length * 0.28, hullHeight * 0.94, width * 0.72, spec.paint, length * 0.12, hullY + hullHeight * 0.03, 0),
    box(length * 0.2, hullHeight * 0.88, width * 0.36, spec.paint, spec.halfLength - length * 0.1, hullY + hullHeight * 0.06, 0),
    // The deck, in the trim, so the open cockpit reads as a hole in it.
    box(length * 0.34, 0.06, width * 0.9, spec.trim, -spec.halfLength + length * 0.17, hullY + hullHeight / 2, 0),
    box(length * 0.05, height * 0.22, width * 0.62, GLASS, -length * 0.02, hullY + hullHeight / 2 + height * 0.11, 0),
    box(length * 0.14, height * 0.18, width * 0.3, spec.trim, -length * 0.14, hullY + hullHeight / 2 + height * 0.09, 0),
  ];
}
