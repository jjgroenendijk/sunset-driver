/**
 * The shell of a shop's room: the floor, the four walls, the ceiling, the
 * lamps and the shopfront, in the finish its {@link RoomStyle} deals.
 *
 * The room is seen from the player's own eyes (spec section 10.7), so what
 * matters is what a person standing in it sees: boards or tiles underfoot,
 * brick or panelling on the walls, beams or ducts overhead, and the street
 * through the shopfront's glass. The shopfront has a door and windows cut into
 * it, and the building the room stands in is cut away while the player is
 * inside, so the street outside is the street they walked in from.
 *
 * Everything goes into the room's {@link RoomKit}, in the room's own frame:
 * `x` across the front, `z` out towards the door, the floor at 0.
 */
import type { Rng } from '../../core/rng.ts';
import { SHOP_ROOM_HEIGHT, SHOP_WALL } from '../../world/city/shops.ts';
import type { RoomKit } from './room-kit.ts';
import { shade, type RoomStyle } from './room-style.ts';

/** Metres of the floor slab and the ceiling slab. */
const SLAB = 0.12;

/**
 * Metres the floor stands over the carved ground the room is set on. The room
 * is placed at the same height the ground mesh is built from, so a floor laid
 * at exactly 0 is a floor the ground shows through wherever the two
 * tessellations round a pixel differently. The metro well is lifted the same
 * way (`metro-mesh.ts`).
 */
export const FLOOR_RISE = 0.04;

/** How far a finish stands off the wall it covers, so the two never fight for a pixel. */
const SKIN = 0.012;

/** The door: how wide and how high. The window heads stand at {@link HEAD}. */
const DOOR_WIDTH = 1.1;
const DOOR_HEIGHT = 2.3;
const HEAD = 2.65;
/** The width of a pier of wall at each end of the shopfront and beside the door. */
const PIER = 0.3;
/** Metres between the mullions of a window. */
const PANE = 1.3;

/** The room's inside, as the shell was built: the fittings are laid inside it. */
export interface Shell {
  halfWidth: number;
  halfDepth: number;
  /** Where the door stands across the front, and how wide it is. */
  door: { x: number; width: number };
}

/** Build the floor, the walls, the ceiling, the lamps and the shopfront of one room. */
export function buildShell(kit: RoomKit, rng: Rng, style: RoomStyle, halfWidth: number, halfDepth: number): Shell {
  // The door is in the middle of the front, where the player walks in (`entryOf`).
  const door = { x: 0, width: DOOR_WIDTH };
  floor(kit, rng, style, halfWidth, halfDepth);
  walls(kit, style, halfWidth, halfDepth);
  shopfront(kit, style, halfWidth, halfDepth, door);
  ceiling(kit, style, halfWidth, halfDepth);
  lamps(kit, rng, style, halfWidth, halfDepth);
  return { halfWidth, halfDepth, door };
}

/** The floor: a slab under the room and the walls, and the pattern the style lays on it. */
function floor(kit: RoomKit, rng: Rng, style: RoomStyle, w: number, d: number): void {
  const { pattern, a, b } = style.floor;
  // The slab covers the walls as well as the room, so no corner shows daylight.
  kit.box(2 * (w + SHOP_WALL), SLAB, 2 * (d + SHOP_WALL), 0, FLOOR_RISE - SLAB / 2, 0, pattern === 'tiles' ? b : a);
  FLOORS[pattern](kit, rng, a, b, w, d);
}

/** Lay one strip of floor finish, `sx` by `sz`, its middle at `(x, z)`. */
function lay(kit: RoomKit, sx: number, sz: number, x: number, z: number, colour: number, lift = 1): void {
  kit.box(sx, SKIN * lift, sz, x, FLOOR_RISE + (SKIN * lift) / 2, z, colour);
}

type FloorLayer = (kit: RoomKit, rng: Rng, a: number, b: number, w: number, d: number) => void;

const FLOORS: Readonly<Record<RoomStyle['floor']['pattern'], FloorLayer>> = {
  planks: (kit, rng, a, b, w, d) => {
    const plank = 0.16 + rng.float() * 0.08;
    const along = rng.float() < 0.5;
    const span = along ? w : d;
    const count = Math.floor((2 * span) / plank);
    for (let i = 0; i < count; i++) {
      const at = -span + (i + 0.5) * plank;
      // Mostly the one wood, a board of the other now and then, each a shade off the last.
      const colour = (i * 7) % 5 === 0 ? b : shade(a, (((i * 13) % 5) - 2) * 0.012);
      if (along) lay(kit, plank - 0.01, 2 * d, at, 0, colour);
      else lay(kit, 2 * w, plank - 0.01, 0, at, colour);
    }
  },
  checker: (kit, rng, _a, b, w, d) => grid(kit, 0.4 + rng.float() * 0.2, w, d, 0, (i, j) => ((i + j) % 2 === 0 ? undefined : b)),
  tiles: (kit, rng, a, _b, w, d) => grid(kit, 0.5 + rng.float() * 0.3, w, d, 0.02, () => a),
  concrete: (kit, rng, a, b, w, d) => {
    // Saw cuts in a grid, and a stain or two.
    const bay = 1.8;
    for (let x = -w + bay; x < w; x += bay) lay(kit, 0.02, 2 * d, x, 0, b);
    for (let z = -d + bay; z < d; z += bay) lay(kit, 2 * w, 0.02, 0, z, b);
    for (let i = 0; i < 3; i++) {
      const size = 0.4 + rng.float() * 0.8;
      lay(kit, size, size * 0.7, (rng.float() * 2 - 1) * (w - size), (rng.float() * 2 - 1) * (d - size), shade(a, -0.03), 0.5);
    }
  },
  carpet: (kit, _rng, a, b, w, d) => {
    // A border and a field.
    lay(kit, 2 * w - 0.5, 2 * d - 0.5, 0, 0, b);
    lay(kit, 2 * w - 0.8, 2 * d - 0.8, 0, 0, a, 1.5);
  },
};

/** Square tiles `tile` across over the floor, `grout` apart, in the colour `colour` deals each, or none. */
function grid(kit: RoomKit, tile: number, w: number, d: number, grout: number, colour: (i: number, j: number) => number | undefined): void {
  const nx = Math.ceil((2 * w) / tile);
  const nz = Math.ceil((2 * d) / tile);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const c = colour(i, j);
      const x0 = -w + i * tile;
      const z0 = -d + j * tile;
      // The last row and column are cut to the wall.
      const sx = Math.min(tile, w - x0) - grout;
      const sz = Math.min(tile, d - z0) - grout;
      if (c === undefined || sx <= 0.02 || sz <= 0.02) continue;
      lay(kit, sx, sz, x0 + sx / 2 + grout / 2, z0 + sz / 2 + grout / 2, c);
    }
  }
}

/** The back wall and the two side walls, and the finish on their inside faces. */
function walls(kit: RoomKit, style: RoomStyle, w: number, d: number): void {
  const high = SHOP_ROOM_HEIGHT;
  const { base } = style.wall;
  kit.box(2 * (w + SHOP_WALL), high, SHOP_WALL, 0, high / 2, -d - SHOP_WALL / 2, base);
  for (const side of [-1, 1]) kit.box(SHOP_WALL, high, 2 * d, side * (w + SHOP_WALL / 2), high / 2, 0, base);
  // Each inside face as a strip `length` long, its middle at `(x, z)`, facing
  // into the room along `turn`: the back wall faces +z, the sides face in.
  const faces = [
    { x: 0, z: -d, turn: 0, length: 2 * w, back: true },
    { x: -w, z: 0, turn: Math.PI / 2, length: 2 * d, back: false },
    { x: w, z: 0, turn: -Math.PI / 2, length: 2 * d, back: false },
  ];
  for (const face of faces) finish(kit, style, face.x, face.z, face.turn, face.length, face.back);
}

/** One inside face of a wall: its middle at the floor, the way it faces, and how long it is. */
interface Face {
  x: number;
  z: number;
  turn: number;
  length: number;
  /** The paint of its plain parts: the feature colour on the back wall. */
  paint: number;
}

/** Lay a panel on a face: `w` along it, `h` high, its middle `u` along, its bottom at `y`, standing `depth` off the wall. */
function onFace(kit: RoomKit, face: Face, w: number, h: number, u: number, y: number, depth: number, colour: number): void {
  const along = { x: Math.cos(face.turn), z: -Math.sin(face.turn) };
  const out = { x: Math.sin(face.turn), z: Math.cos(face.turn) };
  const x = face.x + along.x * u + out.x * (depth / 2);
  const z = face.z + along.z * u + out.z * (depth / 2);
  kit.box(w, h, depth, x, y + h / 2, z, colour, 'matte', { y: face.turn });
}

/**
 * The finish on one inside face of a wall. The back wall is the feature wall,
 * painted in the style's feature colour where it is painted at all.
 */
function finish(kit: RoomKit, style: RoomStyle, x: number, z: number, turn: number, length: number, back: boolean): void {
  const face: Face = { x, z, turn, length, paint: back ? style.wall.feature : style.wall.base };
  onFace(kit, face, length, SHOP_ROOM_HEIGHT, 0, 0, SKIN, face.paint);
  WALLS[style.wall.pattern](kit, style, face, back);
  // A skirting board, whatever the finish.
  onFace(kit, face, length, 0.1, 0, 0, SKIN * 5, shade(style.wood, -0.1));
}

type WallLayer = (kit: RoomKit, style: RoomStyle, face: Face, back: boolean) => void;

const WALLS: Readonly<Record<RoomStyle['wall']['pattern'], WallLayer>> = {
  paint: () => undefined,
  wainscot: (kit, style, face) => {
    // Boarding to the height of a chair back, a rail on it, battens down it.
    const { trim } = style.wall;
    dado(kit, face, 1.05, trim);
    for (let u = -face.length / 2 + 0.8; u < face.length / 2; u += 0.8) onFace(kit, face, 0.05, 1.05, u, 0, SKIN * 3, shade(trim, -0.1));
  },
  panels: (kit, style, face) => {
    // Wood panelling most of the way up, and the paint over it.
    const { base } = style.wall;
    dado(kit, face, 2.2, base);
    for (let u = -face.length / 2 + 0.6; u < face.length / 2; u += 0.6) onFace(kit, face, 0.05, 2.2, u, 0, SKIN * 3, shade(base, -0.1));
    onFace(kit, face, face.length, SHOP_ROOM_HEIGHT - 2.2, 0, 2.2, SKIN * 2, face.paint === base ? shade(base, 0.25) : face.paint);
  },
  tiles: (kit, style, face) => {
    // Tiles to head height, their grout in the trim colour.
    const { base, trim } = style.wall;
    dado(kit, face, 1.5, base);
    for (let y = 0.15; y < 1.5; y += 0.15) onFace(kit, face, face.length, 0.012, 0, y, SKIN * 3, trim);
    for (let u = -face.length / 2 + 0.3; u < face.length / 2; u += 0.3) onFace(kit, face, 0.012, 1.5, u, 0, SKIN * 3, trim);
  },
  stripes: (kit, style, face, back) => {
    const { trim } = style.wall;
    const stripe = 0.12 + (Math.abs(trim) % 7) * 0.02;
    const colour = back ? shade(face.paint, -0.1) : trim;
    for (let u = -face.length / 2; u < face.length / 2 - stripe; u += stripe * 2) onFace(kit, face, stripe, SHOP_ROOM_HEIGHT, u + stripe / 2, 0, SKIN * 2, colour);
  },
  brick: (kit, style, face) => {
    // The mortar in the trim colour, and the courses laid over it, each brick a shade off the next.
    onFace(kit, face, face.length, SHOP_ROOM_HEIGHT, 0, 0, SKIN * 2, style.wall.trim);
    const course = 0.1;
    for (let row = 0; 0.01 + row * course < SHOP_ROOM_HEIGHT - course; row++) courseOf(kit, face, style.wall.base, row, course);
  },
};

/** A lower part of a wall up to `height`, with a rail along its top. */
function dado(kit: RoomKit, face: Face, height: number, colour: number): void {
  onFace(kit, face, face.length, height, 0, 0, SKIN * 2, colour);
  onFace(kit, face, face.length, 0.06, 0, height, SKIN * 4, shade(colour, -0.08));
}

/** One course of bricks along a face, every other one set half a brick along. */
function courseOf(kit: RoomKit, face: Face, base: number, row: number, course: number): void {
  const brick = 0.3;
  const y = 0.01 + row * course;
  const offset = row % 2 === 0 ? 0 : brick / 2;
  for (let u = -face.length / 2 - offset; u < face.length / 2; u += brick) {
    const from = Math.max(u, -face.length / 2);
    const to = Math.min(u + brick - 0.015, face.length / 2);
    if (to - from < 0.04) continue;
    const tone = (row * 7 + Math.round(u * 10)) % 5;
    onFace(kit, face, to - from, course - 0.015, (from + to) / 2, y, SKIN * 3, shade(base, (tone - 2) * 0.02));
  }
}

/**
 * The shopfront: a wall with a door and windows cut into it, the frames round
 * them and the glass in them. The door stands open into the room.
 */
function shopfront(kit: RoomKit, style: RoomStyle, w: number, d: number, door: Shell['door']): void {
  const high = SHOP_ROOM_HEIGHT;
  const z = d + SHOP_WALL / 2;
  const outer = w + SHOP_WALL;
  const sill = style.sill;
  const colour = style.wall.base;
  const frame = style.frame;
  // Over the windows, the whole width.
  kit.box(2 * outer, high - HEAD, SHOP_WALL, 0, (HEAD + high) / 2, z, colour);
  // The piers at each end.
  for (const side of [-1, 1]) kit.box(PIER + SHOP_WALL, HEAD, SHOP_WALL, side * (outer - (PIER + SHOP_WALL) / 2), HEAD / 2, z, colour);
  const left = door.x - door.width / 2;
  const right = door.x + door.width / 2;
  // Beside the door, a pier each side; over it, a transom of glass.
  for (const edge of [left - PIER / 2, right + PIER / 2]) kit.box(PIER, HEAD, SHOP_WALL, edge, HEAD / 2, z, colour);
  kit.box(door.width, 0.06, SHOP_WALL + 0.02, door.x, DOOR_HEIGHT, z, frame);
  kit.box(door.width, HEAD - DOOR_HEIGHT - 0.06, 0.02, door.x, (DOOR_HEIGHT + HEAD) / 2, z, 0xcfe4ec, 'glass');
  for (const edge of [left, right]) kit.box(0.06, HEAD, SHOP_WALL + 0.02, edge, HEAD / 2, z, frame);
  // The door itself, open into the room against the pier: a frame and its glass.
  const hinge = { x: right - 0.03, z: d - 0.03 };
  const swing = -1.35;
  const mid = { x: hinge.x - Math.cos(swing) * (door.width / 2), z: hinge.z + Math.sin(swing) * (door.width / 2) };
  kit.box(door.width - 0.04, DOOR_HEIGHT - 0.04, 0.05, mid.x, DOOR_HEIGHT / 2, mid.z, frame, 'matte', { y: swing });
  // The windows either side of the door: a sill wall under each, then glass up to the head.
  const spans: [number, number][] = [
    [-w + PIER, left - PIER],
    [right + PIER, w - PIER],
  ];
  for (const [from, to] of spans) {
    if (to - from < 0.2) {
      if (to > from) kit.box(to - from, HEAD, SHOP_WALL, (from + to) / 2, HEAD / 2, z, colour);
      continue;
    }
    const middle = (from + to) / 2;
    kit.box(to - from, sill, SHOP_WALL, middle, sill / 2, z, colour);
    kit.box(to - from + 0.1, 0.05, SHOP_WALL + 0.12, middle, sill, z - 0.04, shade(frame, 0.05));
    kit.box(to - from, HEAD - sill, 0.02, middle, (sill + HEAD) / 2, z, 0xcfe4ec, 'glass');
    kit.box(to - from, 0.06, SHOP_WALL + 0.02, middle, HEAD - 0.03, z, frame);
    const panes = Math.max(1, Math.round((to - from) / PANE));
    for (let i = 0; i <= panes; i++) {
      const at = from + ((to - from) * i) / panes;
      kit.box(0.06, HEAD - sill, SHOP_WALL + 0.02, at, (sill + HEAD) / 2, z, frame);
    }
  }
  // The inside face of the shopfront, over the head: the same finish as the sides.
  kit.box(2 * w, 0.08, 0.04, 0, HEAD + 0.04, d - 0.02, shade(style.wood, -0.1));
}

function ceiling(kit: RoomKit, style: RoomStyle, w: number, d: number): void {
  const high = SHOP_ROOM_HEIGHT;
  const { pattern, colour, trim } = style.ceiling;
  kit.box(2 * (w + SHOP_WALL), SLAB, 2 * (d + SHOP_WALL), 0, high + SLAB / 2, 0, colour);
  // A cornice round the top of the walls.
  for (const side of [-1, 1]) {
    kit.box(2 * w, 0.08, 0.08, 0, high - 0.04, side * (d - 0.04), trim);
    kit.box(0.08, 0.08, 2 * d, side * (w - 0.04), high - 0.04, 0, trim);
  }
  if (pattern === 'beams') {
    for (let z = -d + 0.6; z < d; z += 1.2) kit.box(2 * w, 0.2, 0.16, 0, high - 0.1, z, trim);
  } else if (pattern === 'grid') {
    for (let z = -d + 0.6; z < d; z += 0.6) kit.box(2 * w, 0.02, 0.03, 0, high - 0.01, z, trim);
    for (let x = -w + 0.6; x < w; x += 0.6) kit.box(0.03, 0.02, 2 * d, x, high - 0.01, 0, trim);
  } else if (pattern === 'ducts') {
    for (const side of [-0.45, 0.4]) {
      kit.rod(0.18, 2 * d, side * w, high - 0.35, 0, trim, { x: Math.PI / 2 });
      for (let z = -d + 1; z < d; z += 2) kit.box(0.02, 0.2, 0.02, side * w, high - 0.1, z, 0x3a3a3a);
    }
  }
}

/** The lamps, spread over the ceiling in the kind the style hangs. */
function lamps(kit: RoomKit, rng: Rng, style: RoomStyle, w: number, d: number): void {
  const across = w > 2.6 ? [-0.5, 0.5] : [0];
  const along = Math.max(2, Math.round((2 * d) / 2.2));
  const hang = LAMPS[style.lamps.kind];
  for (const share of across) {
    for (let j = 0; j < along; j++) hang(kit, rng, style, share * w, -d + ((j + 0.5) * 2 * d) / along);
  }
  // Wall lights on the side walls, a pair to a wall, in the warmer themes.
  if (style.lamps.kind !== 'lanterns' && style.lamps.kind !== 'fans' && style.lamps.kind !== 'bulbs') return;
  for (const side of [-1, 1]) {
    for (const z of [-d * 0.45, d * 0.35]) {
      kit.box(0.08, 0.2, 0.12, side * (w - 0.06), 1.95, z, style.lamps.shade);
      kit.ball(0.06, side * (w - 0.15), 2.1, z, style.lamps.bulb, 'lamp', 1.4);
    }
  }
}

type LampHanger = (kit: RoomKit, rng: Rng, style: RoomStyle, x: number, z: number) => void;

const HIGH = SHOP_ROOM_HEIGHT;

const LAMPS: Readonly<Record<RoomStyle['lamps']['kind'], LampHanger>> = {
  pendant: (kit, rng, style, x, z) => {
    const drop = 0.7 + rng.float() * 0.2;
    kit.rod(0.006, drop, x, HIGH - drop / 2, z, 0x1a1a1a, {});
    kit.cylinder(0.05, 0.24, 0.22, x, HIGH - drop - 0.2, z, style.lamps.shade, 'matte', 16);
    kit.ball(0.07, x, HIGH - drop - 0.2, z, style.lamps.bulb, 'lamp');
  },
  globes: (kit, _rng, style, x, z) => {
    kit.rod(0.006, 0.6, x, HIGH - 0.3, z, 0x1a1a1a, {});
    kit.cylinder(0.05, 0.05, 0.05, x, HIGH - 0.62, z, style.lamps.shade);
    kit.ball(0.17, x, HIGH - 0.78, z, style.lamps.bulb, 'lamp');
  },
  bulbs: (kit, rng, style, x, z) => {
    // Three bare bulbs at different heights.
    for (let k = 0; k < 3; k++) {
      const bx = x + (k - 1) * 0.35;
      const drop = 0.5 + rng.float() * 0.6;
      kit.rod(0.005, drop, bx, HIGH - drop / 2, z + (rng.float() - 0.5) * 0.3, 0x1a1a1a, {});
      kit.ball(0.045, bx, HIGH - drop - 0.04, z, style.lamps.bulb, 'lamp', 1.3);
    }
  },
  strips: (kit, _rng, style, x, z) => {
    kit.box(0.14, 0.05, 1.4, x, HIGH - 0.03, z, style.lamps.shade);
    kit.box(0.1, 0.02, 1.34, x, HIGH - 0.065, z, style.lamps.bulb, 'lamp');
  },
  lanterns: (kit, _rng, style, x, z) => {
    // A glowing box in a cage of four posts, under a little roof.
    kit.rod(0.008, 0.5, x, HIGH - 0.25, z, 0x1a1a1a, {});
    kit.box(0.24, 0.32, 0.24, x, HIGH - 0.7, z, style.lamps.bulb, 'lamp');
    for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      kit.box(0.03, 0.36, 0.03, x + cx * 0.12, HIGH - 0.7, z + cz * 0.12, style.lamps.shade);
    }
    kit.cylinder(0.02, 0.2, 0.1, x, HIGH - 0.52, z, style.lamps.shade, 'matte', 4);
  },
  fans: (kit, _rng, style, x, z) => {
    // A ceiling fan with a globe under its hub.
    kit.rod(0.02, 0.4, x, HIGH - 0.2, z, style.lamps.shade, {});
    kit.cylinder(0.1, 0.1, 0.1, x, HIGH - 0.5, z, style.lamps.shade);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      kit.box(0.6, 0.015, 0.14, x + Math.cos(a) * 0.38, HIGH - 0.44, z - Math.sin(a) * 0.38, style.wood, 'matte', { y: a });
    }
    kit.ball(0.11, x, HIGH - 0.58, z, style.lamps.bulb, 'lamp');
  },
};
