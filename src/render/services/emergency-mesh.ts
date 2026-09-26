/**
 * The shape of a fire engine and an ambulance (spec sections 10.1, 20.3).
 *
 * `vehicle-mesh.ts` says which boxes each row of the roster is. Neither
 * service is a row, since nobody drives one, so this is their file: the same
 * boxes in the same frame, sized off `UNIT_BODY` of `sim/city/emergency.ts`, which
 * is also the box the player's car hits.
 *
 * The camera looks down from 60 m, so each is built on what reads from there.
 * An engine is a long red body with a white cab roof, grey lockers down its
 * flanks and a ladder that runs the length of the roof. An ambulance is a white
 * box on a short cab, with a red band round it and a red cross on the roof.
 *
 * The lamps that flash are kept apart as {@link Beacon}s, in two phases, so
 * `emergency.ts` can light one half of a bar while the other is dark. Like
 * `vehicle-mesh.ts` this holds no three.js, so the shapes are measured
 * headless.
 */
import { UNIT_BODY, type EmergencyKind } from '../../sim/city/emergency.ts';
import { doorAlong, OUTLET_ALONG, OUTLET_UP } from '../../sim/city/emergency-crew.ts';
import { GLASS, LAMP, METAL, TAIL, type Beacon, type VehicleBox } from '../vehicles/vehicle-mesh.ts';

export type { Beacon };

/** The colours of an engine. */
const ENGINE_RED = 0xc01b1f;
const CAB_WHITE = 0xeeeeea;
const LOCKER = 0xa9afb5;
const DECK = 0x2c2f34;
const LADDER = 0xd9dde0;
const REFLECTOR = 0xf2c230;
const GRILLE = 0x1d1f22;

/** The colours of an ambulance. */
const AMBULANCE_WHITE = 0xf4f5f1;
export const AMBULANCE_RED = 0xd02a2a;
const AMBULANCE_ORANGE = 0xf08a1c;
const STAR_BLUE = 0x1f55c0;

/** The colours a beacon burns. */
const FLASH_RED = 0xff2a22;
const FLASH_BLUE = 0x2a64ff;
const FLASH_WHITE = 0xfff4e0;

/** How big a cab door of an engine is, how high it rides, and how far it opens. */
const CAB_DOOR = 1.3;
const CAB_DOOR_HIGH = 1.45;
const CAB_DOOR_UP = 1.55;
const CAB_SWING = 1.25;

/** The same for the doors across the tail of an ambulance, which open wider. */
const REAR_DOOR_HIGH = 1.55;
const REAR_DOOR_UP = 1.0;
const REAR_SWING = 2.0;

/** A box as `emergency.ts` draws it: no panel, since a unit takes no damage. */
type UnitBox = Omit<VehicleBox, 'panel'>;

/** A wheel of a unit: where its hub is, and how big it is. */
interface UnitWheel {
  x: number;
  y: number;
  z: number;
  radius: number;
  width: number;
}

/**
 * A door the crew climb down through: the panel where it sits shut, the hinge
 * it turns on in the unit's own frame, and the angle it stands open at. The
 * view draws it turned by that angle times how far the record has it open, so
 * a door swings rather than appearing open.
 */
export interface UnitDoor {
  box: UnitBox;
  hinge: { x: number; y: number; z: number };
  /** Radians, signed: which way round the hinge the panel swings. */
  swing: number;
}

/** Everything one unit is drawn as. */
export interface UnitShape {
  boxes: UnitBox[];
  beacons: Beacon[];
  wheels: UnitWheel[];
  /** The doors that open, each drawn apart from the body so it can turn. */
  doors: UnitDoor[];
  /**
   * Where a hose is coupled to the engine, in its own frame, and none on an
   * ambulance, which carries no hose. The water leaves the nozzle at the other
   * end, in a firefighter's hands (`emergency-crew.ts`).
   */
  couplings: { x: number; y: number; z: number }[];
}

function box(length: number, height: number, width: number, colour: number, x: number, y: number, z: number): UnitBox {
  return { length, height, width, x, y, z, colour };
}

function beacon(length: number, height: number, width: number, colour: number, x: number, y: number, z: number, phase: 0 | 1): Beacon {
  return { box: box(length, height, width, colour, x, y, z), phase };
}

/** The shape of a kind of unit. */
export function unitShape(kind: EmergencyKind): UnitShape {
  return kind === 'engine' ? engine() : ambulance();
}

/** A wheel on each side at every axle, standing on the road under the body. */
function axles(kind: EmergencyKind, at: readonly number[], radius: number, width: number): UnitWheel[] {
  const body = UNIT_BODY[kind];
  const out: UnitWheel[] = [];
  for (const x of at) {
    for (const side of [1, -1]) out.push({ x, y: -body.ride + radius, z: side * (body.halfWidth - width / 2), radius, width });
  }
  return out;
}

/**
 * A fire engine: a cab at the nose with a white roof, a long body behind it
 * with lockers down each flank, and a ladder along the roof from a turntable at
 * the tail to a rest over the cab. The ladder is what says "engine" from above:
 * nothing else in the city has rungs.
 */
function engine(): UnitShape {
  const { halfLength: hl, halfWidth: hw, halfHeight: hh } = UNIT_BODY.engine;
  const width = hw * 2;
  const cabBack = hl - 2.4;
  const cabTop = hh - 0.45;
  const bodyTop = hh - 0.25;
  const cabX = (hl + cabBack) / 2;
  const bodyX = (cabBack - 0.05 - hl) / 2;
  const bodyLength = hl + cabBack - 0.05;
  const boxes: UnitBox[] = [
    // The two masses: the cab and the body behind it, the body a little taller.
    box(hl - cabBack, cabTop + hh, width * 0.96, ENGINE_RED, cabX, (cabTop - hh) / 2, 0),
    box(bodyLength, bodyTop + hh, width, ENGINE_RED, bodyX, (bodyTop - hh) / 2, 0),
    // The cab roof in white, which is how the crew tell their own engine in a yard.
    box(hl - cabBack - 0.2, 0.08, width * 0.92, CAB_WHITE, cabX, cabTop + 0.04, 0),
    // The windscreen across the nose and a window down each side of the cab.
    box(0.08, 0.9, width * 0.88, GLASS, hl + 0.01, cabTop - 0.55, 0),
    box(1.5, 0.75, width * 0.97, GLASS, cabX + 0.1, cabTop - 0.55, 0),
    // The grille and the chrome bumper under it.
    box(0.06, 0.7, width * 0.52, GRILLE, hl + 0.02, -hh + 0.6, 0),
    box(0.22, 0.26, width * 1.0, METAL, hl + 0.06, -hh + 0.15, 0),
    // The roof of the body: a dark walkway the ladder lies on.
    box(bodyLength - 0.3, 0.08, width * 0.92, DECK, bodyX, bodyTop + 0.04, 0),
    // A reflective band the length of the engine, low down each side.
    box(hl * 2 - 0.1, 0.16, width + 0.04, REFLECTOR, -0.05, -hh + 0.28, 0),
    // The rear step, in chrome.
    box(0.3, 0.14, width * 0.9, METAL, -hl - 0.1, -hh + 0.1, 0),
  ];
  // Three lockers down each flank, shut behind grey roller doors.
  for (const x of [cabBack - 1.05, cabBack - 3.05, cabBack - 5.05]) {
    boxes.push(box(1.75, 1.7, width + 0.04, LOCKER, x, -hh + 1.45, 0));
  }
  // The pump panel between the lockers on each flank, with the coupling a hose is run from.
  const couplingY = OUTLET_UP - UNIT_BODY.engine.ride;
  const couplings = [1, -1].map((side) => ({ x: OUTLET_ALONG, y: couplingY, z: side * (hw + 0.08) }));
  for (const coupling of couplings) {
    boxes.push(box(0.3, 0.3, 0.16, METAL, coupling.x, coupling.y, coupling.z));
  }
  // The ladder: a turntable at the tail, two rails and a rung every 40 cm.
  const ladderY = bodyTop + 0.5;
  const ladderTail = -hl + 0.6;
  // The ladder stops short of the bar on the cab, so the bar is seen from above.
  const ladderNose = hl - 0.8;
  boxes.push(box(1.5, 0.36, 1.5, DECK, -hl + 1.1, bodyTop + 0.26, 0));
  boxes.push(box(0.5, 0.3, 0.9, METAL, -hl + 1.1, bodyTop + 0.55, 0));
  boxes.push(box(0.2, ladderY - cabTop, 0.9, DECK, cabBack + 0.6, (ladderY + cabTop) / 2, 0));
  for (const side of [1, -1]) {
    boxes.push(box(ladderNose - ladderTail, 0.18, 0.1, LADDER, (ladderNose + ladderTail) / 2, ladderY, side * 0.46));
  }
  for (let x = ladderTail + 0.2; x < ladderNose; x += 0.4) boxes.push(box(0.06, 0.06, 0.86, LADDER, x, ladderY, 0));
  // A lamp at each front corner and a tail light at each rear one.
  for (const side of [1, -1]) {
    boxes.push(box(0.1, 0.22, 0.36, LAMP, hl + 0.02, -hh + 0.62, side * hw * 0.72));
    boxes.push(box(0.1, 0.4, 0.22, TAIL, -hl - 0.01, -hh + 0.75, side * hw * 0.8));
  }
  // The bar across the front of the cab roof, red one side and red the other,
  // with a white strobe in the middle; and a beacon at each top corner of the tail.
  boxes.push(box(0.36, 0.1, width * 0.86, GRILLE, hl - 0.45, cabTop + 0.12, 0));
  const beacons: Beacon[] = [
    beacon(0.3, 0.16, width * 0.34, FLASH_RED, hl - 0.45, cabTop + 0.23, hw * 0.46, 0),
    beacon(0.3, 0.16, width * 0.34, FLASH_RED, hl - 0.45, cabTop + 0.23, -hw * 0.46, 1),
    beacon(0.3, 0.16, width * 0.14, FLASH_WHITE, hl - 0.45, cabTop + 0.23, 0, 1),
    beacon(0.22, 0.22, 0.3, FLASH_RED, -hl + 0.1, bodyTop - 0.05, hw * 0.82, 1),
    beacon(0.22, 0.22, 0.3, FLASH_RED, -hl + 0.1, bodyTop - 0.05, -hw * 0.82, 0),
  ];
  // A cab door on each flank, hinged at its front edge and swinging forward.
  // The doorway behind it is dark, so an open door reads as a way in.
  const doorAt = doorAlong('engine');
  const doors: UnitDoor[] = [];
  for (const side of [1, -1]) {
    const z = side * (hw + 0.03);
    boxes.push(box(CAB_DOOR, CAB_DOOR_HIGH, 0.06, GRILLE, doorAt, -hh + CAB_DOOR_UP, side * hw));
    doors.push({
      box: box(CAB_DOOR, CAB_DOOR_HIGH, 0.08, ENGINE_RED, doorAt, -hh + CAB_DOOR_UP, z),
      hinge: { x: doorAt + CAB_DOOR / 2, y: -hh + CAB_DOOR_UP, z },
      swing: side * CAB_SWING,
    });
  }
  return {
    boxes,
    beacons,
    wheels: axles('engine', [hl - 1.4, -hl + 2.8, -hl + 1.65], 0.52, 0.42),
    doors,
    couplings,
  };
}

/**
 * An ambulance: a short cab under a tall white box, a red band round the box
 * and a red cross on its roof, which is the one mark that reads from above.
 */
function ambulance(): UnitShape {
  const { halfLength: hl, halfWidth: hw, halfHeight: hh } = UNIT_BODY.ambulance;
  const width = hw * 2;
  const boxFront = hl - 1.8;
  const boxX = (boxFront - hl) / 2;
  const boxLength = hl + boxFront;
  const cabTop = hh - 0.85;
  const boxes: UnitBox[] = [
    // The bonnet, the cab behind it and the box behind that.
    box(0.85, 0.95, width * 0.9, AMBULANCE_WHITE, hl - 0.425, -hh + 0.475, 0),
    box(1.0, cabTop + hh, width * 0.93, AMBULANCE_WHITE, boxFront + 0.45, (cabTop - hh) / 2, 0),
    box(boxLength, hh * 2, width, AMBULANCE_WHITE, boxX, 0, 0),
    // The windscreen and the cab's side windows.
    box(0.08, 0.66, width * 0.86, GLASS, boxFront + 0.96, cabTop - 0.42, 0),
    box(0.75, 0.55, width * 0.95, GLASS, boxFront + 0.45, cabTop - 0.42, 0),
    // The red band round the box and along the cab, with an orange line over it.
    box(boxLength + 0.04, 0.34, width + 0.04, AMBULANCE_RED, boxX, -hh + 0.95, 0),
    box(boxLength + 0.04, 0.1, width + 0.04, AMBULANCE_ORANGE, boxX, -hh + 1.22, 0),
    box(1.85, 0.2, width * 0.94, AMBULANCE_RED, hl - 0.93, -hh + 0.7, 0),
    // A window high in each side of the box, and one in each rear door.
    box(0.6, 0.42, width + 0.02, GLASS, boxFront - 0.5, hh - 0.62, 0),
    box(0.04, 0.5, 0.62, GLASS, -hl - 0.01, hh - 0.7, 0.45),
    box(0.04, 0.5, 0.62, GLASS, -hl - 0.01, hh - 0.7, -0.45),
    // The blue star on each flank, behind the side window.
    box(0.5, 0.5, width + 0.03, STAR_BLUE, boxFront - 1.5, hh - 0.62, 0),
    // The red cross on the roof, and the air conditioning at the back of it.
    box(1.9, 0.04, 0.55, AMBULANCE_RED, boxX + 0.2, hh + 0.02, 0),
    box(0.55, 0.04, 1.9, AMBULANCE_RED, boxX + 0.2, hh + 0.02, 0),
    box(0.7, 0.22, 1.0, METAL, -hl + 0.55, hh + 0.11, 0),
    // Mirrors on stalks, which stand out past the box from above.
    box(0.1, 0.3, 0.14, GRILLE, boxFront + 0.8, cabTop - 0.3, hw + 0.12),
    box(0.1, 0.3, 0.14, GRILLE, boxFront + 0.8, cabTop - 0.3, -hw - 0.12),
    // The bumper.
    box(0.18, 0.2, width * 0.94, METAL, hl + 0.04, -hh + 0.12, 0),
  ];
  for (const side of [1, -1]) {
    boxes.push(box(0.1, 0.2, 0.38, LAMP, hl + 0.02, -hh + 0.55, side * hw * 0.64));
    boxes.push(box(0.1, 0.5, 0.2, TAIL, -hl - 0.01, -hh + 0.9, side * hw * 0.84));
  }
  // The bar along the top of the box over the cab, red and blue, and a red
  // beacon at each top corner of the tail.
  boxes.push(box(0.34, 0.08, width * 0.84, GRILLE, boxFront - 0.2, hh + 0.04, 0));
  const beacons: Beacon[] = [
    beacon(0.3, 0.15, width * 0.38, FLASH_RED, boxFront - 0.2, hh + 0.15, hw * 0.44, 0),
    beacon(0.3, 0.15, width * 0.38, FLASH_BLUE, boxFront - 0.2, hh + 0.15, -hw * 0.44, 1),
    beacon(0.18, 0.2, 0.26, FLASH_RED, -hl + 0.08, hh - 0.12, hw * 0.84, 1),
    beacon(0.18, 0.2, 0.26, FLASH_RED, -hl + 0.08, hh - 0.12, -hw * 0.84, 0),
  ];
  // The two doors across the tail, each hinged at its outer edge and swinging
  // back, with the dark of the bay behind them.
  const leaf = hw - 0.04;
  boxes.push(box(0.06, REAR_DOOR_HIGH, width * 0.92, DECK, -hl + 0.05, -hh + REAR_DOOR_UP, 0));
  const doors: UnitDoor[] = [1, -1].map((side) => ({
    box: box(0.07, REAR_DOOR_HIGH, leaf, AMBULANCE_WHITE, -hl - 0.02, -hh + REAR_DOOR_UP, (side * leaf) / 2),
    hinge: { x: -hl - 0.02, y: -hh + REAR_DOOR_UP, z: side * leaf },
    swing: side * REAR_SWING,
  }));
  return { boxes, beacons, wheels: axles('ambulance', [hl - 0.75, -hl + 1.05], 0.4, 0.3), doors, couplings: [] };
}
