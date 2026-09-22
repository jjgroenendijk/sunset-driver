/**
 * What a tram is built of (spec sections 9.2, 13.2): the boxes of each module
 * of each of the two designs the city runs.
 *
 * The **modern** tram is one articulated vehicle in three modules. The two end
 * modules carry a cab, a raked nose, a destination board and a bellows at their
 * inner end; the middle module carries the pantograph. The rear module is the
 * front one turned about, which is what a double-ended tram is, so the two cost
 * one geometry between them.
 *
 * The **heritage** tram is three separate cars coupled together, in the shape
 * the 1940s built: a rounded end at each end, a cream band over the livery,
 * vents along the roof and a trolley pole reaching up to the wire. Every car is
 * the same, so the design costs one geometry.
 *
 * Which design a tram is drawn in is the zone of the stop its lap starts at
 * (`tram.ts`): the core keeps its old cars, the inner districts got new ones.
 *
 * A box marked `outlined` is one of the masses the outline of spec section 10.1
 * follows, and every one of those stands inside the box the physics gives a car
 * (`tram-bodies.ts`). The bellows, the pantograph and the trolley pole reach
 * past it, so none of them is outlined.
 *
 * Nothing here touches the renderer, so a test reads the boxes directly.
 */
import { BoxGeometry, type BufferGeometry } from 'three';
import { CAR_GAP, CAR_HALF_HEIGHT, CAR_HALF_WIDTH, CAR_LENGTH } from '../sim/tram.ts';
import { GLASS, LAMP, METAL, TYRE } from './vehicle-mesh.ts';

/** The two fleets the city runs. */
export type TramDesign = 'modern' | 'heritage';

/** Which module of a tram a geometry is: an end module with a cab, or the one between them. */
export type TramModule = 'end' | 'middle';

/** The livery of each design, the band it carries, and the colours shared by both. */
export const MODERN_PAINT = 0xe2a52b;
export const HERITAGE_PAINT = 0x8e3b30;
const MODERN_STRIPE = 0xf3efe4;
const HERITAGE_CREAM = 0xe9e3d3;
/** The doors, the bellows between two modules, the roof and the underframe. */
const DOOR = 0x35383d;
const BELLOWS = 0x23262b;
const ROOF = 0x70757b;
const UNDERFRAME = 0x2b2f36;
/**
 * The destination board over the windscreen. It is painted in {@link LAMP}, so
 * it burns with the headlamps after dark (`vehicle-glow.ts`) and the line the
 * tram is running reads from across a junction.
 */
const BOARD = LAMP;

/** Metres of clearance under the body, between the rails and the floor. */
const FLOOR = 0.35;

/** Metres from the middle of a car to the top of its body, under the roof. */
const TOP = 2 * CAR_HALF_HEIGHT;

/**
 * Metres above the rail the pantograph's collector bar rides. The contact wire
 * hangs at {@link WIRE_HEIGHT} over the road bed (`catenary-mesh.ts`), and the
 * bar reaches just under it.
 */
const PANTOGRAPH_TOP = 5.52;

/** Metres of one doorway, and how tall its leaf is. */
export const DOOR_LONG = 1.3;
const DOOR_TALL = 2.3;

/** Where the doorways of a module stand along it, in the car's own frame. */
export function tramDoors(design: TramDesign, module: TramModule): number[] {
  if (design === 'heritage') return [-2.2, 2.2];
  return module === 'end' ? [-3.0, 1.2] : [-1.8, 1.8];
}

/**
 * The leaf that slides over one doorway, drawn at the origin of the car's frame
 * and moved to its doorway by the view. It stands on the right of travel, which
 * is the side the island platform is on, and is the only door that opens: the
 * other flank of the car faces the oncoming track.
 */
export function doorLeafBoxes(): TramBox[] {
  return [box(DOOR_LONG - 0.06, DOOR_TALL, 0.09, 0, FLOOR + DOOR_TALL / 2, DOOR, false, -(CAR_HALF_WIDTH + 0.04))];
}

/** One box of a car, in the car's own frame: forward along `+x`, up `+y` from the rail. */
export interface TramBox {
  length: number;
  height: number;
  width: number;
  x: number;
  y: number;
  z: number;
  colour: number;
  outlined: boolean;
  /** Radians the box is pitched nose-up about its own middle. Unset, it stands square. */
  pitch?: number;
}

function box(length: number, height: number, width: number, x: number, y: number, colour: number, outlined = false, z = 0): TramBox {
  return { length, height, width, x, y, z, colour, outlined };
}

/** The boxes of one module of one design. */
export function tramBoxes(design: TramDesign = 'modern', module: TramModule = 'end'): TramBox[] {
  return design === 'heritage' ? heritageCar() : module === 'end' ? modernEnd() : modernMiddle();
}

/**
 * How a tram of a design is put together: which module each car is drawn as,
 * and whether it is turned about. The rear module of a modern tram is the front
 * one reversed; a heritage car is the same either way round.
 */
export function tramCarPlan(design: TramDesign, car: number, cars: number): { module: TramModule; reversed: boolean } {
  if (design === 'heritage') return { module: 'middle', reversed: false };
  if (car === 0) return { module: 'end', reversed: false };
  if (car === cars - 1) return { module: 'end', reversed: true };
  return { module: 'middle', reversed: false };
}

// ------------------------------------------------------------------- modern

/** The body every modern module shares: underframe, skirt band, window band and roof. */
function modernShell(bodyFrom: number, bodyTo: number): TramBox[] {
  const length = bodyTo - bodyFrom;
  const middle = (bodyFrom + bodyTo) / 2;
  const width = 2 * CAR_HALF_WIDTH;
  const body = TOP - 0.3 - FLOOR;
  return [
    box(CAR_LENGTH - 0.5, 0.3, width - 0.3, 0, 0.2, UNDERFRAME),
    box(length, body, width, middle, FLOOR + body / 2, MODERN_PAINT, true),
    box(length - 0.2, 0.16, width + 0.02, middle, 1.62, MODERN_STRIPE),
    box(length - 1.4, 1.05, width + 0.04, middle, 2.25, GLASS),
    box(length - 0.4, 0.22, width - 0.25, middle, TOP - 0.19, ROOF, true),
    // The camera looks down on the roof, so it carries what a real one does:
    // the air conditioning, and the duct that runs the cables between modules.
    box(length - 2.4, 0.1, 0.5, middle, TOP - 0.03, UNDERFRAME),
    box(1.7, 0.12, 1.5, middle - 2.2, TOP - 0.02, ROOF),
    box(1.7, 0.12, 1.5, middle + 2.2, TOP - 0.02, ROOF),
    box(2.2, 0.35, width - 0.45, -3.5, 0.175, TYRE),
    box(2.2, 0.35, width - 0.45, 3.5, 0.175, TYRE),
  ];
}

/** The window pillars and the doors down one module's flanks. */
function modernFlank(at: readonly number[], doors: readonly number[]): TramBox[] {
  const width = 2 * CAR_HALF_WIDTH;
  return [
    ...at.map((x) => box(0.22, 1.05, width + 0.05, x, 2.25, MODERN_PAINT)),
    ...doors.map((x) => box(1.3, 2.3, width + 0.03, x, 1.55, DOOR)),
  ];
}

/** An end module: the shell, a cab raked to a nose, its lamps and board, and the bellows behind it. */
function modernEnd(): TramBox[] {
  const half = CAR_LENGTH / 2;
  const width = 2 * CAR_HALF_WIDTH;
  const body = TOP - 0.3 - FLOOR;
  return [
    ...modernShell(-half, 3.8),
    ...modernFlank([-4.2, -0.9, 2.4], [-3.0, 1.2]),
    // The nose is two steps in, not a curve: the camera looks down on it.
    box(0.7, body - 0.05, width - 0.1, 4.15, FLOOR + (body - 0.05) / 2, MODERN_PAINT, true),
    box(0.5, body - 0.25, width - 0.3, 4.75, FLOOR + (body - 0.25) / 2, MODERN_PAINT, true),
    box(0.55, 1.05, width - 0.45, 4.4, 2.2, GLASS),
    box(0.06, 0.34, 1.5, 4.99, 2.62, BOARD),
    box(0.08, 0.22, 0.5, 5.02, 1.2, LAMP, false, 0.75),
    box(0.08, 0.22, 0.5, 5.02, 1.2, LAMP, false, -0.75),
    // The bellows fills the gap to the next module and reaches into both.
    box(CAR_GAP + 0.4, 2.3, width - 0.45, -(half + CAR_GAP / 2), 1.65, BELLOWS),
  ];
}

/** The middle module: the shell end to end, and the pantograph on its roof. */
function modernMiddle(): TramBox[] {
  const half = CAR_LENGTH / 2;
  return [...modernShell(-half, half), ...modernFlank([-3.4, 0, 3.4], [-1.8, 1.8]), ...pantograph()];
}

/**
 * A single-arm pantograph: a base on the roof, a lower arm raked up, an upper
 * arm raked back down, and the collector bar across the top, under the wire.
 */
function pantograph(): TramBox[] {
  const base = TOP + 0.08;
  const knee = 4.5;
  return [
    box(1.8, 0.12, 1.5, 0, base, METAL),
    ...arm(-0.8, base, 0.4, knee, 0.5),
    ...arm(0.4, knee, -0.5, PANTOGRAPH_TOP - 0.06, 0.34),
    box(0.16, 0.08, 1.9, -0.5, PANTOGRAPH_TOP, METAL),
  ];
}

/** Two struts of a pantograph arm, one each side of the roof, between two places in the car's frame. */
function arm(fromX: number, fromY: number, toX: number, toY: number, spread: number): TramBox[] {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const part: TramBox = {
    length: Math.hypot(dx, dy),
    height: 0.09,
    width: 0.09,
    x: (fromX + toX) / 2,
    y: (fromY + toY) / 2,
    z: 0,
    colour: METAL,
    outlined: false,
    pitch: Math.atan2(dy, dx),
  };
  return [
    { ...part, z: spread },
    { ...part, z: -spread },
  ];
}

// ----------------------------------------------------------------- heritage

/**
 * One car of the heritage set: rounded at both ends, a cream band over the
 * livery, vents down the roof, a fender at each end and its own trolley pole.
 */
function heritageCar(): TramBox[] {
  const width = 2 * CAR_HALF_WIDTH - 0.05;
  const body = TOP - 0.55 - FLOOR;
  const out: TramBox[] = [
    box(CAR_LENGTH - 0.4, 0.4, width - 0.3, 0, 0.2, UNDERFRAME),
    box(CAR_LENGTH - 1, body, width, 0, FLOOR + body / 2, HERITAGE_PAINT, true),
    box(7.6, 0.8, width + 0.03, 0, 2.05, GLASS),
    box(CAR_LENGTH - 1, 0.45, width + 0.02, 0, 2.52, HERITAGE_CREAM),
    box(CAR_LENGTH - 1, 0.2, width + 0.02, 0, 0.62, HERITAGE_CREAM),
    // A cream roof over a cream band is what the 1940s painted, and from a
    // camera looking down the roof is most of the car.
    box(CAR_LENGTH - 1.2, 0.3, width - 0.25, 0, 2.9, HERITAGE_CREAM, true),
    box(CAR_LENGTH - 2, 0.18, width - 0.85, 0, 3.14, HERITAGE_CREAM, true),
    box(2.2, 0.4, width - 0.4, -3.5, 0.2, TYRE),
    box(2.2, 0.4, width - 0.4, 3.5, 0.2, TYRE),
    ...[-2.6, 0, 2.6].map((x) => box(0.22, 0.8, width + 0.05, x, 2.05, HERITAGE_PAINT)),
    ...[-2.2, 2.2].map((x) => box(1.2, 1.9, width + 0.03, x, 1.35, DOOR)),
    ...[-1.9, 1.9].map((x) => box(0.5, 0.1, width - 1.1, x, 3.24, ROOF)),
    box(CAR_LENGTH - 3, 0.09, 0.34, 0, 3.26, ROOF),
  ];
  for (const end of [1, -1]) {
    out.push(box(0.5, body - 0.4, width - 0.25, end * 4.75, FLOOR + (body - 0.4) / 2, HERITAGE_PAINT, true));
    out.push(box(0.08, 0.3, 0.44, end * 4.98, 1.95, LAMP));
    out.push(box(0.06, 0.28, 1.2, end * 4.94, 2.5, BOARD));
    out.push(box(0.35, 0.26, width - 0.5, end * 4.7, 0.42, METAL));
  }
  out.push(...trolleyPole());
  return out;
}

/** The trolley pole: a base on the roof at the tail, a long pole raked up, and the shoe on the wire. */
function trolleyPole(): TramBox[] {
  const base = TOP + 0.02;
  const fromX = -3.2;
  const toX = 2.2;
  const toY = PANTOGRAPH_TOP - 0.06;
  const dx = toX - fromX;
  const dy = toY - base;
  return [
    box(0.7, 0.16, 0.7, fromX, base, METAL),
    {
      length: Math.hypot(dx, dy),
      height: 0.1,
      width: 0.1,
      x: (fromX + toX) / 2,
      y: (base + toY) / 2,
      z: 0,
      colour: METAL,
      outlined: false,
      pitch: Math.atan2(dy, dx),
    },
    box(0.5, 0.09, 0.28, toX, PANTOGRAPH_TOP, METAL),
  ];
}

/** One box of a car as a geometry standing in the car's frame, grown by `reach`. */
export function tramBoxGeometry(part: TramBox, reach: number): BufferGeometry {
  const geometry = new BoxGeometry(part.length + 2 * reach, part.height + 2 * reach, part.width + 2 * reach).toNonIndexed();
  if (part.pitch !== undefined) geometry.rotateZ(part.pitch);
  geometry.translate(part.x, part.y, part.z);
  return geometry;
}
