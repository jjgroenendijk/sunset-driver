/**
 * A house, in all its variants (spec section 10.3).
 *
 * The suburbs are built of these, so one shape repeated is a field of identical
 * boxes seen from above. Every choice therefore comes off the building's own
 * seed: one storey or two, a hipped, gabled or flat roof in tile, slate or
 * metal, a porch over the door, a garage beside the body, a fence along the
 * front. The camera sees the roof first, which is why the roof is the choice
 * with the most weight.
 */
import type { BuildingMassing } from './building-mesh.ts';
import {
  ALL_SIDES,
  BLOCK_METAL,
  BLOCK_SLATE,
  BLOCK_TILE,
  BLOCK_TRIM,
  BLOCK_WALL,
  EAVES,
  STOREY,
  box,
  door,
  flatRoof,
  gable,
  hipped,
  shrink,
  pick,
  unit,
  windowBands,
  type BlockStyle,
  type Shell,
} from './block-shell.ts';
import type { RoofDeck } from './roof-dress.ts';

/** The door on the front of a house, in metres. */
const DOOR_WIDTH = 1.1;
const DOOR_RISE = 2.1;

/** The porch over the door: how far it reaches and how thick its roof is. */
const PORCH_REACH = 1.4;
const PORCH_THICK = 0.16;

/** The garage beside the body: the widest it is built, and its share of a lot. */
const GARAGE_WIDE = 6;
const GARAGE_SHARE = 0.34;

/** The fence along the front of the lot: how tall it stands and how thick it is. */
const FENCE_RISE = 1;
const FENCE_THICK = 0.14;

/** Metres of lot a house needs before it is built with a garage. */
const GARAGE_ROOM = 13;

/** The salts a house draws its variants from. */
const SALT_STOREYS = 31;
const SALT_SHAPE = 32;
const SALT_COVER = 33;
const SALT_GARAGE = 34;
const SALT_SIDE = 35;
const SALT_PORCH = 36;
const SALT_FENCE = 37;

/** The roofs a house is built under. A gable is the common one. */
const SHAPES = ['hipped', 'gabled', 'gabled', 'flat'] as const;

/** What the roof is covered in. */
const COVERS = [BLOCK_TILE, BLOCK_TILE, BLOCK_SLATE, BLOCK_METAL] as const;

/**
 * Build one house. It answers the deck of its roof where that roof is flat, so
 * the caller can dress it as it dresses every other flat roof.
 */
export function house(shell: Shell, massing: BuildingMassing, style: BlockStyle): RoofDeck | undefined {
  const seed = style.seed;
  const near = style.detail === 'near';
  // A porch reaches out over the front of the house, so a house that has one
  // is built that much further inside its lot.
  const porched = near && unit(seed, SALT_PORCH) < 0.4;
  const outer = shrink(massing, porched ? PORCH_REACH : EAVES);
  // A garage takes one end of the lot, and the body of the house the rest.
  const garage = near && outer.width > GARAGE_ROOM && unit(seed, SALT_GARAGE) < 0.45;
  const wing = garage ? Math.min(GARAGE_WIDE, outer.width * GARAGE_SHARE) : 0;
  const side = unit(seed, SALT_SIDE) < 0.5 ? -1 : 1;
  const walls = { ...outer, width: outer.width - wing };

  const storeys = unit(seed, SALT_STOREYS) < 0.45 ? 1 : 2;
  const shape = pick(SHAPES, seed, SALT_SHAPE);
  const cover = pick(COVERS, seed, SALT_COVER);
  const rise = shape === 'flat' ? 0 : Math.min(3, walls.depth * 0.3);
  const eaves = Math.max(STOREY, Math.min(massing.height - rise, storeys * STOREY + 0.4));

  shell.offset = (-side * wing) / 2;
  box(shell, walls, 0, eaves, BLOCK_WALL);
  windowBands(shell, walls, 0, eaves, ALL_SIDES);
  door(shell, walls, DOOR_WIDTH, DOOR_RISE);
  if (porched) porch(shell, walls, cover);
  let deck: RoofDeck | undefined;
  if (shape === 'hipped') hipped(shell, walls, eaves, rise, cover);
  else if (shape === 'gabled') gable(shell, walls, eaves, rise, 'x', cover);
  else {
    flatRoof(shell, walls, eaves, cover);
    deck = { x: shell.offset, z: 0, hw: walls.width / 2, hd: walls.depth / 2, top: eaves + 0.12 };
  }

  shell.offset = 0;
  if (wing > 0) garageWing(shell, outer, side, wing, cover);
  if (near && unit(seed, SALT_FENCE) < 0.45) fence(shell, massing);
  return deck;
}

/** A porch: a slab over the door, on two posts. */
function porch(shell: Shell, walls: BuildingMassing, cover: number): void {
  const hd = walls.depth / 2;
  const half = DOOR_WIDTH + 0.7;
  const rise = DOOR_RISE + 0.5;
  shell.box(-half, half, rise, rise + PORCH_THICK, hd, hd + PORCH_REACH, cover);
  for (const at of [-half + 0.1, half - 0.2]) {
    shell.box(at, at + 0.14, 0, rise, hd + PORCH_REACH - 0.2, hd + PORCH_REACH - 0.06, BLOCK_TRIM);
  }
}

/** A garage at one end of the house: a low box with a door on the street. */
function garageWing(shell: Shell, outer: BuildingMassing, side: number, wide: number, cover: number): void {
  const hw = outer.width / 2;
  const x0 = side < 0 ? -hw : hw - wide;
  const x1 = x0 + wide;
  // The garage is shallower than the house, so the two roofs read apart.
  const hd = Math.min(outer.depth / 2, wide * 0.8);
  const top = STOREY;
  shell.box(x0, x1, 0, top, -hd, hd, BLOCK_WALL);
  shell.box(x0 - 0.2, x1 + 0.2, top, top + 0.2, -hd - 0.2, hd + 0.2, cover);
  shell.box(x0 + 0.4, x1 - 0.4, 0, top - 0.5, hd, hd + 0.08, BLOCK_METAL);
}

/** A fence along the front of the lot, with the path left open in the middle. */
function fence(shell: Shell, massing: BuildingMassing): void {
  const hw = massing.width / 2 - 0.1;
  const z = massing.depth / 2 - 0.2;
  const gap = 1.2;
  shell.box(-hw, -gap, 0, FENCE_RISE, z - FENCE_THICK, z, BLOCK_TRIM);
  shell.box(gap, hw, 0, FENCE_RISE, z - FENCE_THICK, z, BLOCK_TRIM);
}
