/**
 * A roadhouse and a parking garage, in their variants (spec section 10.3).
 *
 * The two are put together because they are the same thing from above: a shape
 * and its trim, with no facade worth the name. A roadhouse is a single storey
 * under a wide roof, either a canopy over the pumps or a flat roof behind a
 * parapet, and it carries its board on the roof or on a pylon beside it. A
 * parking garage is a stack of open decks, and its top deck is painted out in
 * stalls rather than dressed.
 */
import type { BuildingMassing } from './building-mesh.ts';
import {
  ALL_SIDES,
  BLOCK_METAL,
  BLOCK_PAINT,
  BLOCK_ROOF,
  BLOCK_TRIM,
  BLOCK_WALL,
  EAVES,
  MIN_WALLS,
  PROUD,
  band,
  box,
  flatRoof,
  shrink,
  slab,
  unit,
  type BlockStyle,
  type Shell,
} from './block-shell.ts';
import { deckPartOf, type RoofDeck } from './roof-dress.ts';

/** The board a roadhouse carries, in metres. */
const SIGN_WIDTH = 2.6;
const SIGN_RISE = 1.4;
const SIGN_THICK = 0.2;

/** How far the canopy of a roadhouse reaches out over the pumps, in metres. */
const CANOPY_REACH = EAVES * 2;

/** The pylon beside a roadhouse: how tall its post stands, in metres. */
const PYLON_RISE = 7;

/**
 * The decks of a parking garage, in metres: the height of one deck, the edge of
 * concrete that rims it, how far the dark inside stands behind the open sides,
 * and the columns between the decks.
 */
const DECK = 3;
const DECK_EDGE = 1.1;
const DECK_INSET = 1.5;
const COLUMN = 0.6;
const COLUMN_PITCH = 8;

/** Metres of a parking stall painted on the top deck of a garage. */
const STALL = 2.6;

/** The salts a roadhouse and a garage draw their variants from. */
const SALT_CANOPY = 61;
const SALT_PYLON = 62;
const SALT_DECK = 63;
const SALT_CORE = 64;

/**
 * A roadhouse. A canopy roof carries no parapet and so is not dressed; a flat
 * roof is, and its deck is answered.
 */
export function roadhouse(shell: Shell, massing: BuildingMassing, style: BlockStyle): RoofDeck | undefined {
  const seed = style.seed;
  const canopy = unit(seed, SALT_CANOPY) < 0.55;
  const walls = shrink(massing, canopy ? CANOPY_REACH : EAVES);
  const top = massing.height;
  box(shell, walls, 0, top, BLOCK_WALL);
  band(shell, walls, 1, Math.min(2.6, top - 0.5), ALL_SIDES);

  let deck: RoofDeck | undefined;
  if (canopy) {
    // A deep flat roof over the pumps and the porch, rather than a parapet.
    slab(shell, walls, top, 0.35, CANOPY_REACH);
  } else {
    flatRoof(shell, walls, top, deckPartOf(style));
    deck = { x: 0, z: 0, hw: walls.width / 2, hd: walls.depth / 2, top: top + 0.12 };
  }

  const sign = Math.min(SIGN_WIDTH, walls.width * 0.6);
  if (canopy || unit(seed, SALT_PYLON) < 0.5) {
    // The board over the roof, on the street side of it.
    const board = walls.depth / 2;
    const at = canopy ? top + 0.35 : top + 0.7;
    shell.box(-sign / 2, sign / 2, at, at + SIGN_RISE, board - SIGN_THICK, board, BLOCK_TRIM);
  } else {
    pylon(shell, walls, sign);
  }
  return deck;
}

/** A pylon at one end of the forecourt, with the board on top of it. */
function pylon(shell: Shell, walls: BuildingMassing, sign: number): void {
  const at = walls.width / 2 - sign / 2;
  shell.box(at - 0.2, at + 0.2, 0, PYLON_RISE, walls.depth / 2 - 0.2, walls.depth / 2 + 0.2, BLOCK_METAL);
  shell.box(
    at - sign / 2,
    at + sign / 2,
    PYLON_RISE - SIGN_RISE,
    PYLON_RISE,
    walls.depth / 2 - SIGN_THICK,
    walls.depth / 2,
    BLOCK_PAINT,
  );
}

/**
 * A parking garage: a stack of open decks. Each deck is rimmed by an edge of
 * concrete, and the gap over the edge shows the dark floor inside, so the camera
 * reads the floors rather than a wall. Columns carry the decks, a parapet rims
 * the top one, and the stalls are painted on it.
 */
export function parkingGarage(shell: Shell, massing: BuildingMassing, style: BlockStyle): void {
  const seed = style.seed;
  const walls = shrink(massing, PROUD);
  const top = massing.height;
  const hw = walls.width / 2;
  const hd = walls.depth / 2;
  // The dark inside, set back behind the open sides.
  const inside = {
    ...walls,
    width: Math.max(MIN_WALLS, walls.width - 2 * DECK_INSET),
    depth: Math.max(MIN_WALLS, walls.depth - 2 * DECK_INSET),
  };
  box(shell, inside, 0, top, BLOCK_ROOF);
  // A garage of deep decks reads as a few heavy floors and one of shallow decks
  // as a stack of thin ones.
  const pitchWanted = DECK * (0.85 + 0.45 * unit(seed, SALT_DECK));
  const decks = Math.max(1, Math.round(top / pitchWanted));
  const pitch = top / decks;
  // The ground floor opens onto the street; every deck above it has its edge.
  const edge = Math.min(DECK_EDGE, pitch / 2);
  for (let i = 1; i < decks; i++) box(shell, walls, i * pitch, i * pitch + edge, BLOCK_WALL);
  columns(shell, walls, top);
  flatRoof(shell, walls, top, BLOCK_ROOF);
  if (style.detail === 'near') stalls(shell, hw, hd, top);
  if (style.detail === 'near' && unit(seed, SALT_CORE) < 0.7) core(shell, hw, hd, top, seed);
}

/** The columns that carry the decks, around the open sides. */
function columns(shell: Shell, walls: BuildingMassing, top: number): void {
  const cx = walls.width / 2 - COLUMN / 2;
  const cz = walls.depth / 2 - COLUMN / 2;
  const column = (x: number, z: number): void => {
    shell.box(x - COLUMN / 2, x + COLUMN / 2, 0, top, z - COLUMN / 2, z + COLUMN / 2, BLOCK_WALL);
  };
  const acrossX = Math.max(1, Math.round((walls.width - COLUMN) / COLUMN_PITCH));
  const acrossZ = Math.max(1, Math.round((walls.depth - COLUMN) / COLUMN_PITCH));
  for (let i = 0; i <= acrossX; i++) {
    const x = -cx + (2 * cx * i) / acrossX;
    column(x, cz);
    column(x, -cz);
  }
  for (let i = 1; i < acrossZ; i++) {
    const z = -cz + (2 * cz * i) / acrossZ;
    column(cx, z);
    column(-cx, z);
  }
}

/** The stalls painted on the top deck: two rows with an aisle between them. */
function stalls(shell: Shell, hw: number, hd: number, top: number): void {
  const count = Math.max(2, Math.floor((hw * 2 - 1) / STALL));
  const pitch = (hw * 2 - 1) / count;
  const at = top + 0.13;
  for (let i = 0; i <= count; i++) {
    const x = -hw + 0.5 + i * pitch;
    shell.panel(x - 0.08, x + 0.08, at, -hd + 0.6, -hd + 0.6 + Math.min(5, hd * 0.7), BLOCK_PAINT);
    shell.panel(x - 0.08, x + 0.08, at, hd - 0.6 - Math.min(5, hd * 0.7), hd - 0.6, BLOCK_PAINT);
  }
}

/** The stair and lift core, standing over one corner of the top deck. */
function core(shell: Shell, hw: number, hd: number, top: number, seed: number): void {
  const side = unit(seed, SALT_CORE + 1) < 0.5 ? -1 : 1;
  const x = side * (hw - 2.4);
  const z = -hd + 2.2;
  shell.box(x - 1.8, x + 1.8, top, top + 3, z - 1.6, z + 1.6, BLOCK_WALL);
  shell.box(x - 2, x + 2, top + 3, top + 3.2, z - 1.8, z + 1.8, BLOCK_ROOF);
}
