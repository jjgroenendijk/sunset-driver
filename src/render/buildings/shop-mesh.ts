/**
 * A shop row, in all its variants (spec section 10.3).
 *
 * The inner ring is built of these. A row is one volume with flats over the
 * shops, so what varies is the front: how tall the glazing is, whether an
 * awning hangs over it, where the doors are recessed, and how the upper floors
 * are glazed. The roof is flat, and it is dressed like every other flat roof.
 */
import type { BuildingMassing } from './building-mesh.ts';
import {
  ALL_SIDES,
  BLOCK_GLASS,
  BLOCK_TRIM,
  BLOCK_WALL,
  EAVES,
  band,
  box,
  flatRoof,
  shrink,
  slab,
  unit,
  windowBands,
  type BlockStyle,
  type Shell,
  type Side,
} from './block-shell.ts';
import { deckPartOf, type RoofDeck } from './roof-dress.ts';

/** The shopfront: how tall the glazing may stand, and how far an awning reaches. */
const SHOPFRONT_RISE = 3.4;
const AWNING_REACH = 1.3;
const AWNING_THICK = 0.18;

/** Metres of frontage one shop of a row takes, at its narrowest and its widest. */
const SHOP_WIDE = 7;

/** The salts a shop row draws its variants from. */
const SALT_AWNING = 41;
const SALT_RISE = 42;
const SALT_UPPER = 43;
const SALT_DOORS = 44;

/**
 * Build one shop row, and answer the deck of its flat roof so the caller can
 * dress it.
 */
export function shopRow(shell: Shell, massing: BuildingMassing, style: BlockStyle): RoofDeck {
  const seed = style.seed;
  const awning = unit(seed, SALT_AWNING) < 0.55;
  const walls = shrink(massing, awning ? AWNING_REACH : EAVES);
  const top = massing.height;
  box(shell, walls, 0, top, BLOCK_WALL);

  // A tall shopfront reads as a showroom and a short one as a corner shop.
  const shopfront = Math.min(SHOPFRONT_RISE * (0.75 + 0.45 * unit(seed, SALT_RISE)), top - 0.6);
  band(shell, walls, 0.4, shopfront, ['front']);
  if (awning) slab(shell, walls, shopfront, AWNING_THICK, AWNING_REACH);
  // The flats over the shops are glazed on the street alone, on the street and
  // the sides, or all round where the row stands free.
  const upper = unit(seed, SALT_UPPER);
  let sides: readonly Side[] = ALL_SIDES;
  if (upper < 0.35) sides = ['front'];
  else if (upper < 0.8) sides = ['front', 'left', 'right'];
  windowBands(shell, walls, shopfront + 0.8, top, sides);
  if (style.detail === 'near') doors(shell, walls, shopfront, seed);

  const deck = deckPartOf(style);
  flatRoof(shell, walls, top, deck);
  return { x: 0, z: 0, hw: walls.width / 2, hd: walls.depth / 2, top: top + 0.12 };
}

/**
 * The doors of the shops, one per shop of the row, each set back into the
 * glazing under its own frame.
 */
function doors(shell: Shell, walls: BuildingMassing, shopfront: number, seed: number): void {
  const shops = Math.max(1, Math.round(walls.width / SHOP_WIDE));
  const pitch = walls.width / shops;
  const hd = walls.depth / 2;
  const rise = Math.min(2.4, shopfront - 0.4);
  if (rise < 1.8) return;
  for (let i = 0; i < shops; i++) {
    // The door stands to one side of its own shopfront, as a real one does.
    const middle = -walls.width / 2 + (i + 0.5) * pitch;
    const at = middle + (unit(seed, SALT_DOORS + i) < 0.5 ? -1 : 1) * pitch * 0.28;
    // The reveal: a dark recess with a frame of trim standing round it.
    shell.box(at - 0.7, at + 0.7, 0, rise, hd - 0.5, hd - 0.4, BLOCK_GLASS);
    shell.box(at - 0.85, at - 0.7, 0, rise + 0.15, hd - 0.5, hd + 0.1, BLOCK_TRIM);
    shell.box(at + 0.7, at + 0.85, 0, rise + 0.15, hd - 0.5, hd + 0.1, BLOCK_TRIM);
    shell.box(at - 0.85, at + 0.85, rise, rise + 0.15, hd - 0.5, hd + 0.1, BLOCK_TRIM);
  }
}
