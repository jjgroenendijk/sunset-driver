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
 * model and rims the masses among them with the outline of spec section 10.1.
 *
 * Every box is in the vehicle's own frame: `length` runs along local `+x`,
 * which is forward, `height` along `+y` and `width` along `+z`, the axle.
 */
import type { Panel } from '../sim/damage.ts';
import type { VehicleSpec } from '../sim/vehicle.ts';

/** Glass, lamps and the bare metal of a cage: the colours no row picks. */
export const GLASS = 0x243040;
export const LAMP = 0xffe7b0;
export const TAIL = 0x6e1210;
export const METAL = 0x9aa0a6;
export const TYRE = 0x161616;
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
   * True on the masses that make the silhouette. Those are what the outline of
   * spec section 10.1 follows; glass, lamps, beacons and cage bars are detail
   * inside it and rimming each of them would draw a scribble, not an outline.
   */
  outlined: boolean;
  /**
   * The panel this box belongs to (spec section 11.3), and undefined on the
   * shell in the middle of the body. A dent pushes in the boxes of the panel
   * it lands on, and a panel torn off takes its boxes with it; the shell stays,
   * because a vehicle with no middle is not a vehicle.
   */
  panel: Panel | undefined;
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
  if (part.y > spec.halfHeight * 0.2) return 'roof';
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
  outlined = true,
): VehicleBox {
  return { length, height, width, x, y, z, colour, outlined, panel: undefined };
}

/**
 * A door skin down each side of a body, half sunk into it so nothing z-fights.
 * It is what a shunt from the side pushes in and what a hard one tears off:
 * without it a flank is one face of the shell, and a shell never goes.
 */
function doors(spec: VehicleSpec, length: number, height: number, y: number, at: number): VehicleBox[] {
  const out: VehicleBox[] = [];
  for (const side of [1, -1]) {
    out.push(box(length, height, 0.06, spec.paint, 0, y, side * spec.halfWidth * at, false));
  }
  return out;
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
    box(length * 0.06, cabinHeight * 0.82, width * 0.82, GLASS, cabinX + cabinLength / 2, cabinY, 0, false),
    box(length * 0.05, cabinHeight * 0.82, width * 0.82, GLASS, cabinX - cabinLength / 2, cabinY, 0, false),
    box(cabinLength * 0.7, cabinHeight * 0.5, width * 0.83, GLASS, cabinX, cabinY + cabinHeight * 0.08, 0, false),
    ...doors(spec, length * 0.46, bodyHeight * 0.6, bodyY, 0.9),
    // A bonnet at the nose and a boot at the tail, sitting on the body: they
    // are the panels a shunt at either end pushes in, and a hard enough one
    // takes them off and leaves the shell.
    box(length * 0.22, bodyHeight * 0.3, width * 0.86, spec.paint, spec.halfLength - length * 0.13, bodyY + bodyHeight * 0.36, 0, false),
    box(length * 0.2, bodyHeight * 0.3, width * 0.86, spec.paint, -spec.halfLength + length * 0.12, bodyY + bodyHeight * 0.36, 0, false),
  ];
  return [...boxes, ...lamps(spec, bodyY + bodyHeight * 0.2)];
}

/** A lamp at each front corner and a tail light at each rear one. */
function lamps(spec: VehicleSpec, y: number): VehicleBox[] {
  const width = spec.halfWidth * 2;
  const out: VehicleBox[] = [];
  for (const side of [1, -1]) {
    out.push(box(0.1, 0.14, width * 0.22, LAMP, spec.halfLength - 0.04, y, side * width * 0.28, false));
    out.push(box(0.09, 0.14, width * 0.22, TAIL, -spec.halfLength + 0.04, y, side * width * 0.28, false));
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
    box: { length: 0.26, height: 0.13, width: width * 0.36, x, y: spec.halfHeight + 0.13, z, colour, outlined: false },
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
  boxes.push(box(0.3, 0.06, width * 0.8, BAR_BASE, -spec.halfLength * 0.1, spec.halfHeight + 0.04, 0, false));
  for (const beacon of patrolBeacons(spec)) {
    const b = beacon.box;
    boxes.push(box(b.length, b.height, b.width, b.colour, b.x, b.y, b.z, false));
  }
  // The push bar on the nose, which is the one part of it wider than a saloon's front.
  boxes.push(box(0.12, spec.halfHeight * 0.6, width * 0.7, BAR_BASE, spec.halfLength + 0.08, -spec.halfHeight * 0.5, 0, false));
  // A spotlight on the driver's pillar.
  boxes.push(box(0.16, 0.1, 0.1, METAL, length * 0.12, spec.halfHeight * 0.3, width * 0.43, false));
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
    box(length * 0.05, height * 0.4, width * 0.86, GLASS, spec.halfLength - noseLength, height * 0.06, 0, false),
    // A vent on the roof, which is the panel a van loses off the top of it and
    // the one thing that breaks up a flat white roof from above.
    box(length * 0.18, 0.09, width * 0.5, spec.trim, -length * 0.1, spec.halfHeight + 0.05, 0, false),
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
    box(length * 0.05, height * 0.36, width * 0.9, GLASS, spec.halfLength - cabLength, height * 0.2, 0, false),
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
    box(length * 0.94, height * 0.3, width * 1.01, GLASS, -length * 0.02, bandY, 0, false),
    // The windscreen, a little taller than the band, at the driver's end.
    box(length * 0.03, height * 0.42, width * 0.94, GLASS, spec.halfLength, bandY, 0, false),
    // A roof hatch, so the roof is not one flat colour from above.
    box(length * 0.12, 0.08, width * 0.4, spec.trim, length * 0.2, spec.halfHeight + 0.04, 0, false),
  ];
  return [...boxes, ...lamps(spec, -spec.halfHeight + height * 0.12)];
}

/** A motorcycle: a tank, a seat, a fairing and the bars across the front. */
function motorcycle(spec: VehicleSpec): VehicleBox[] {
  const length = spec.halfLength * 2;
  const width = spec.halfWidth * 2;
  const height = spec.halfHeight * 2;
  return [
    // The spine of it, low and narrow: what reads from above is its length.
    box(length * 0.8, height * 0.5, width * 0.5, spec.trim, 0, -spec.halfHeight + height * 0.25, 0),
    box(length * 0.3, height * 0.45, width * 0.78, spec.paint, length * 0.1, height * 0.1, 0),
    box(length * 0.24, height * 0.3, width * 0.6, spec.trim, -length * 0.22, height * 0.08, 0),
    // The bars, the one part of a bike that is wider than the bike.
    box(0.07, 0.07, width * 1.5, METAL, length * 0.3, height * 0.3, 0, false),
    box(0.08, 0.12, width * 0.45, LAMP, spec.halfLength - 0.05, height * 0.16, 0, false),
    box(0.07, 0.1, width * 0.4, TAIL, -spec.halfLength + 0.05, height * 0.14, 0, false),
  ];
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
    box(length * 0.6, cabinHeight * 0.56, width * 0.9, GLASS, -length * 0.06, cabinY + cabinHeight * 0.12, 0, false),
    // The rack, which is the one thing that tells this from a tall van above.
    box(length * 0.42, 0.08, width * 0.74, spec.trim, -length * 0.1, spec.halfHeight + 0.05, 0, false),
    // A spare wheel on the back door.
    box(0.14, spec.wheelRadius * 1.6, spec.wheelRadius * 1.6, TYRE, -spec.halfLength - 0.07, bodyY + bodyHeight * 0.3, 0, false),
    ...doors(spec, length * 0.44, bodyHeight * 0.56, bodyY, 0.92),
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
    boxes.push(box(0.14, height * 0.46, width * 0.24, spec.trim, -length * 0.06, panY + panHeight * 0.7, side * width * 0.18, false));
    // The cage: an upright each side and a bar across the top of them.
    boxes.push(box(0.07, height * 0.7, 0.07, METAL, -length * 0.08, panY + panHeight * 0.9, side * width * 0.34, false));
    boxes.push(box(0.07, 0.07, width * 0.75, METAL, -length * 0.08, panY + panHeight * 0.5 + height * 0.6, 0, false));
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
    box(length * 0.34, 0.06, width * 0.9, spec.trim, -spec.halfLength + length * 0.17, hullY + hullHeight / 2, 0, false),
    box(length * 0.05, height * 0.22, width * 0.62, GLASS, -length * 0.02, hullY + hullHeight / 2 + height * 0.11, 0, false),
    box(length * 0.14, height * 0.18, width * 0.3, spec.trim, -length * 0.14, hullY + hullHeight / 2 + height * 0.09, 0, false),
  ];
}
