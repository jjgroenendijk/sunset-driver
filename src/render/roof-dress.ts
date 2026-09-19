/**
 * What stands on a flat roof (spec section 10.3).
 *
 * The camera looks down from 60 m, so a roof is the part of a building it sees
 * most. Every flat roof is therefore dressed: a deck material, the plant a real
 * roof carries — air-conditioning units, water tanks, vents, stair huts, masts —
 * and at most one use: a helipad, a pool, a garden, a sports court, a billboard
 * or a terrace. A rich district has more uses. Plant keeps clear of a use.
 *
 * One dresser serves every flat roof: the blocks of `block-mesh.ts`, whose deck
 * is known, and the generated towers of `building-mesh.ts`, whose deck is
 * measured off the shell by {@link roofDeckOf}.
 *
 * The dressing is built as its own geometry and joins the block batch, so it
 * costs no draw call. It is kept out of the shell the outline hull is drawn
 * around on purpose: a mast six metres tall would otherwise raise the box that
 * `roofs.ts` writes, and the camera would climb the mast rather than the roof.
 */
import type { BufferAttribute, BufferGeometry } from 'three';
import {
  BLOCK_METAL,
  BLOCK_PAINT,
  BLOCK_PLANTED,
  BLOCK_ROOF,
  BLOCK_SOLAR,
  BLOCK_TRIM,
  BLOCK_WALL,
  BLOCK_WATER,
  BLOCK_MEMBRANE,
  pick,
  unit,
  type BlockStyle,
  type Shell,
} from './block-shell.ts';

/** A flat roof to dress: where its deck lies, and how far out it reaches. */
export interface RoofDeck {
  /** The middle of the deck in the building's own frame. */
  x: number;
  z: number;
  /** Half the deck along each axis, inside the parapet. */
  hw: number;
  hd: number;
  /** The height of the deck surface. */
  top: number;
}

/** The materials a flat deck is finished in. Gravel and tar share a part. */
const DECKS: readonly number[] = [BLOCK_ROOF, BLOCK_ROOF, BLOCK_MEMBRANE, BLOCK_PLANTED, BLOCK_SOLAR];

/** Metres of deck the plant and the uses keep clear of the parapet. */
const MARGIN = 1.2;

/**
 * The scatter the plant is laid on: metres of deck one cell covers, the most
 * cells across the deck either way, and the most pieces one roof carries. The
 * cap is what keeps the vertices of a chunk of towers inside `CHUNK_VERTEX_CAP`.
 */
const CELL = 3.6;
const CELLS = 5;
const PLANT_CAP = 8;

/** Metres a roof stands before a helipad may go on it. */
const HELIPAD_HEIGHT = 40;

/**
 * What makes a flat face a deck: the least square metres it covers, and the
 * share of the box it spreads over that it must fill. A cornice and a parapet
 * are rings a third of a metre wide, and a ring fills almost none of its box.
 */
const MIN_DECK = 9;
const DECK_SHARE = 0.6;

/** Metres below the top of a shell that its deck is looked for. */
const DECK_REACH = 20;

/** How often a roof carries a use, in a thousand, at no wealth and at all of it. */
const USE_RATE = 220;
const USE_WEALTH = 520;

/** The salts the dressing draws on. Each one is its own stream off the seed. */
const SALT_DECK = 21;
const SALT_USE = 22;
const SALT_WHICH = 23;
const SALT_PLANT = 24;

/** The uses a roof may carry. A helipad needs height, the rest need only room. */
type Use = 'helipad' | 'pool' | 'garden' | 'court' | 'billboard' | 'terrace';
const USES: readonly Use[] = ['pool', 'garden', 'court', 'billboard', 'terrace'];

/**
 * The part a flat deck is surfaced in, drawn from the building's seed. A solar
 * roof is surfaced like a gravel one; the panels stand on it (see
 * {@link dressRoof}).
 */
export function deckPartOf(style: BlockStyle): number {
  const deck = pick(DECKS, style.seed, SALT_DECK);
  return deck === BLOCK_SOLAR ? BLOCK_ROOF : deck;
}

/**
 * Dress one flat roof: its solar array if it has one, its use if it has one,
 * and the plant scattered around whatever stands there.
 *
 * Nothing is laid at mid detail, where the camera is 200 m away and a vent is
 * 60 cm across. The caller builds the deck itself, which carries the material
 * at every detail.
 */
export function dressRoof(shell: Shell, deck: RoofDeck, style: BlockStyle): void {
  if (style.detail !== 'near') return;
  const room = { ...deck, hw: deck.hw - MARGIN, hd: deck.hd - MARGIN };
  if (room.hw < 1 || room.hd < 1) return;
  const taken = useOf(shell, room, style);
  if (pick(DECKS, style.seed, SALT_DECK) === BLOCK_SOLAR) solar(shell, room, taken);
  plant(shell, room, taken, style);
}

/** A rectangle of deck something stands on, in the building's own frame. */
interface Patch {
  x: number;
  z: number;
  hw: number;
  hd: number;
}

/** Whether a place on the deck stands inside a patch, with a metre to spare. */
function inside(patch: Patch | undefined, x: number, z: number): boolean {
  if (patch === undefined) return false;
  return Math.abs(x - patch.x) < patch.hw + 1 && Math.abs(z - patch.z) < patch.hd + 1;
}

/**
 * The one use this roof carries, if it carries one, and the deck it takes. A
 * rich district carries more of them, and a helipad only goes up high.
 */
function useOf(shell: Shell, room: RoofDeck, style: BlockStyle): Patch | undefined {
  const rate = USE_RATE + USE_WEALTH * style.wealth;
  if (unit(style.seed, SALT_USE) * 1000 >= rate) return undefined;
  const high = room.top >= HELIPAD_HEIGHT;
  const use: Use = high && unit(style.seed, SALT_WHICH + 1) < 0.45 ? 'helipad' : pick(USES, style.seed, SALT_WHICH);
  // A use sits on the half of the deck away from the street, and takes half of
  // it at most, so the plant has room left whatever the roof carries.
  const size = Math.min(room.hw * 0.55, room.hd * 0.55, 6);
  if (size < 2) return undefined;
  const patch: Patch = { x: room.x, z: room.z - Math.max(0, room.hd - size), hw: size, hd: size };
  switch (use) {
    case 'helipad':
      helipad(shell, patch, room.top);
      break;
    case 'pool':
      pool(shell, patch, room.top);
      break;
    case 'garden':
      garden(shell, patch, room.top, style);
      break;
    case 'court':
      court(shell, patch, room.top);
      break;
    case 'billboard':
      billboard(shell, patch, room.top);
      break;
    default:
      terrace(shell, patch, room.top, style);
      break;
  }
  return patch;
}

/** A raised pad with a painted H on it. */
function helipad(shell: Shell, patch: Patch, top: number): void {
  shell.box(patch.x - patch.hw, patch.x + patch.hw, top, top + 0.2, patch.z - patch.hd, patch.z + patch.hd, BLOCK_TRIM);
  const arm = patch.hw * 0.4;
  const bar = 0.4;
  const at = top + 0.21;
  shell.panel(patch.x - arm - bar, patch.x - arm + bar, at, patch.z - arm, patch.z + arm, BLOCK_PAINT);
  shell.panel(patch.x + arm - bar, patch.x + arm + bar, at, patch.z - arm, patch.z + arm, BLOCK_PAINT);
  shell.panel(patch.x - arm, patch.x + arm, at, patch.z - bar, patch.z + bar, BLOCK_PAINT);
}

/** A pool: water inside a curb of tile. */
function pool(shell: Shell, patch: Patch, top: number): void {
  shell.box(patch.x - patch.hw, patch.x + patch.hw, top, top + 0.35, patch.z - patch.hd, patch.z + patch.hd, BLOCK_TRIM);
  const in0 = 0.6;
  shell.panel(
    patch.x - patch.hw + in0,
    patch.x + patch.hw - in0,
    top + 0.3,
    patch.z - patch.hd + in0,
    patch.z + patch.hd - in0,
    BLOCK_WATER,
  );
}

/** A garden: grass with a few planters standing in it. */
function garden(shell: Shell, patch: Patch, top: number, style: BlockStyle): void {
  shell.panel(patch.x - patch.hw, patch.x + patch.hw, top + 0.06, patch.z - patch.hd, patch.z + patch.hd, BLOCK_PLANTED);
  for (let i = 0; i < 3; i++) {
    const x = patch.x + (unit(style.seed, SALT_WHICH + 10 + i) * 2 - 1) * (patch.hw - 0.8);
    const z = patch.z + (unit(style.seed, SALT_WHICH + 20 + i) * 2 - 1) * (patch.hd - 0.8);
    shell.box(x - 0.6, x + 0.6, top, top + 0.9, z - 0.6, z + 0.6, BLOCK_PLANTED);
  }
}

/** A sports court: a painted rim around a green deck. */
function court(shell: Shell, patch: Patch, top: number): void {
  shell.panel(patch.x - patch.hw, patch.x + patch.hw, top + 0.06, patch.z - patch.hd, patch.z + patch.hd, BLOCK_PLANTED);
  const line = 0.2;
  const at = top + 0.07;
  shell.panel(patch.x - patch.hw, patch.x + patch.hw, at, patch.z - line, patch.z + line, BLOCK_PAINT);
  shell.panel(patch.x - patch.hw, patch.x - patch.hw + line * 2, at, patch.z - patch.hd, patch.z + patch.hd, BLOCK_PAINT);
  shell.panel(patch.x + patch.hw - line * 2, patch.x + patch.hw, at, patch.z - patch.hd, patch.z + patch.hd, BLOCK_PAINT);
}

/** A billboard: a board on two legs, facing the street. */
function billboard(shell: Shell, patch: Patch, top: number): void {
  const half = Math.min(patch.hw, 5);
  const rise = 4;
  for (const side of [-1, 1]) {
    const x = patch.x + side * (half - 0.3);
    shell.box(x - 0.2, x + 0.2, top, top + rise, patch.z - 0.2, patch.z + 0.2, BLOCK_METAL);
  }
  shell.box(patch.x - half, patch.x + half, top + rise * 0.45, top + rise, patch.z - 0.15, patch.z + 0.15, BLOCK_PAINT);
}

/** A terrace: decking under a few parasols. */
function terrace(shell: Shell, patch: Patch, top: number, style: BlockStyle): void {
  shell.panel(patch.x - patch.hw, patch.x + patch.hw, top + 0.08, patch.z - patch.hd, patch.z + patch.hd, BLOCK_TRIM);
  for (let i = 0; i < 2; i++) {
    const x = patch.x + (unit(style.seed, SALT_WHICH + 30 + i) * 2 - 1) * (patch.hw - 1.2);
    const z = patch.z + (unit(style.seed, SALT_WHICH + 40 + i) * 2 - 1) * (patch.hd - 1.2);
    shell.box(x - 0.08, x + 0.08, top, top + 2.4, z - 0.08, z + 0.08, BLOCK_METAL);
    shell.panel(x - 1.1, x + 1.1, top + 2.4, z - 1.1, z + 1.1, BLOCK_PAINT);
  }
}

/** Rows of solar panels, laid across the deck the use leaves free. */
function solar(shell: Shell, room: RoofDeck, taken: Patch | undefined): void {
  const rows = Math.min(3, Math.max(1, Math.floor(room.hd / 2.2)));
  for (let r = 0; r < rows; r++) {
    const z = room.z - room.hd + 1.4 + r * 2.2;
    if (inside(taken, room.x, z)) continue;
    const half = Math.min(room.hw, 5);
    shell.box(room.x - half, room.x + half, room.top + 0.2, room.top + 0.45, z - 0.8, z + 0.8, BLOCK_SOLAR);
  }
}

/** The plant a roof carries, scattered over the deck and clear of its use. */
function plant(shell: Shell, room: RoofDeck, taken: Patch | undefined, style: BlockStyle): void {
  const acrossX = Math.min(CELLS, Math.max(1, Math.floor((room.hw * 2) / CELL)));
  const acrossZ = Math.min(CELLS, Math.max(1, Math.floor((room.hd * 2) / CELL)));
  let laid = 0;
  for (let iz = 0; iz < acrossZ; iz++) {
    for (let ix = 0; ix < acrossX; ix++) {
      if (laid >= PLANT_CAP) return;
      const salt = SALT_PLANT + iz * CELLS + ix;
      if (unit(style.seed, salt * 7) > 0.55) continue;
      const x = room.x - room.hw + ((ix + 0.5) * room.hw * 2) / acrossX + (unit(style.seed, salt * 11) - 0.5) * 1.4;
      const z = room.z - room.hd + ((iz + 0.5) * room.hd * 2) / acrossZ + (unit(style.seed, salt * 13) - 0.5) * 1.4;
      if (Math.abs(x - room.x) > room.hw || Math.abs(z - room.z) > room.hd) continue;
      if (inside(taken, x, z)) continue;
      item(shell, x, z, room.top, style.seed, salt);
      laid++;
    }
  }
}

/** One piece of rooftop plant, drawn from the seed of the cell it stands in. */
function item(shell: Shell, x: number, z: number, top: number, seed: number, salt: number): void {
  const kind = unit(seed, salt * 17);
  if (kind < 0.34) {
    // An air-conditioning unit on its own low frame.
    shell.box(x - 0.9, x + 0.9, top, top + 0.15, z - 0.7, z + 0.7, BLOCK_TRIM);
    shell.box(x - 0.8, x + 0.8, top + 0.15, top + 1, z - 0.6, z + 0.6, BLOCK_METAL);
  } else if (kind < 0.54) {
    // A water tank standing on short legs.
    shell.box(x - 0.8, x + 0.8, top + 0.5, top + 2.4, z - 0.8, z + 0.8, BLOCK_METAL);
    shell.box(x - 0.7, x + 0.7, top, top + 0.5, z - 0.7, z + 0.7, BLOCK_TRIM);
  } else if (kind < 0.72) {
    // A vent, with a cap over it.
    shell.box(x - 0.3, x + 0.3, top, top + 0.9, z - 0.3, z + 0.3, BLOCK_METAL);
    shell.panel(x - 0.5, x + 0.5, top + 1, z - 0.5, z + 0.5, BLOCK_METAL);
  } else if (kind < 0.87) {
    // The hut over the stair or the lift.
    shell.box(x - 1.6, x + 1.6, top, top + 2.6, z - 1.3, z + 1.3, BLOCK_WALL);
    shell.box(x - 1.7, x + 1.7, top + 2.6, top + 2.75, z - 1.4, z + 1.4, BLOCK_ROOF);
  } else {
    // A mast. It stands well over the roof, which is why the dressing is kept
    // out of the hull the camera reads.
    shell.box(x - 0.12, x + 0.12, top, top + 6, z - 0.12, z + 0.12, BLOCK_METAL);
    shell.box(x - 0.5, x + 0.5, top + 4.4, top + 4.6, z - 0.5, z + 0.5, BLOCK_METAL);
  }
}

/**
 * The deck of a generated tower, measured off its shell: the flat surface near
 * the top that the most triangles look up from. The generator caps the crown
 * with a slab, and stands a parapet and its finials around it, so the slab is
 * by far the widest upward face up there and the dressing goes on it.
 *
 * The geometry is not indexed, so three vertices in a row are one triangle.
 * Undefined where nothing flat stands near the top, and the roof is left bare.
 */
export function roofDeckOf(geometry: BufferGeometry): RoofDeck | undefined {
  const position = (geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
  const normal = (geometry.getAttribute('normal') as BufferAttribute | undefined)?.array as Float32Array | undefined;
  if (normal === undefined) return undefined;
  let highest = -Infinity;
  for (let i = 1; i < position.length; i += 3) highest = Math.max(highest, position[i] as number);
  // A plane is taken to the nearest tenth of a metre, so one slab is one plane.
  // Every upward face near the top, gathered by the plane it lies in, to the
  // nearest tenth of a metre: its area, and the box it spreads over.
  const planes = new Map<number, Plane>();
  for (let t = 0; t + 8 < position.length; t += 9) {
    if ((normal[t + 1] as number) < 0.99) continue;
    const y = position[t + 1] as number;
    if (y < highest - DECK_REACH || y > highest) continue;
    const key = Math.round(y * 10);
    const plane = planes.get(key) ?? { area: 0, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    plane.area += triangleArea(position, t);
    for (let v = 0; v < 3; v++) {
      const x = position[t + v * 3] as number;
      const z = position[t + v * 3 + 2] as number;
      plane.x0 = Math.min(plane.x0, x);
      plane.x1 = Math.max(plane.x1, x);
      plane.z0 = Math.min(plane.z0, z);
      plane.z1 = Math.max(plane.z1, z);
    }
    planes.set(key, plane);
  }
  // The deck is the highest plane that is a slab rather than a ring: a cornice
  // and a parapet stand over the roof and both are rings a third of a metre
  // wide, which cover almost none of the box they spread over. The keys are
  // read in the order they were first met, which is the order of the
  // triangles, so the same geometry always gives the same deck.
  let best: Plane | undefined;
  let bestKey = -Infinity;
  for (const [key, plane] of planes) {
    if (key <= bestKey || plane.area < MIN_DECK) continue;
    if (plane.area < (plane.x1 - plane.x0) * (plane.z1 - plane.z0) * DECK_SHARE) continue;
    best = plane;
    bestKey = key;
  }
  if (best === undefined) return undefined;
  return {
    x: (best.x0 + best.x1) / 2,
    z: (best.z0 + best.z1) / 2,
    hw: (best.x1 - best.x0) / 2,
    hd: (best.z1 - best.z0) / 2,
    top: bestKey / 10,
  };
}

/** One flat plane of a shell: how much of it is solid, and where it spreads. */
interface Plane {
  area: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** The area of one triangle of a flat deck, which is its area on the ground. */
function triangleArea(position: Float32Array, t: number): number {
  const ax = position[t] as number;
  const az = position[t + 2] as number;
  const bx = (position[t + 3] as number) - ax;
  const bz = (position[t + 5] as number) - az;
  const cx = (position[t + 6] as number) - ax;
  const cz = (position[t + 8] as number) - az;
  return Math.abs(bx * cz - bz * cx) / 2;
}
