/**
 * The advertising of spec section 13.1, as pictures drawn in code.
 *
 * A sign says two things at once: what is sold behind it, and whose
 * neighbourhood it stands in. So a cell of the atlas is a pair — one of the
 * {@link SIGN_DESIGNS} designs, which is a trade of spec section 16.1 or an
 * advertisement, printed in the look of one of the {@link SIGN_CULTURES}
 * cultures of spec section 8.3. The trade is the lower line, the culture is the
 * upper line and every colour on the board, so a player who cannot read the
 * words still reads the neighbourhood off the colour of its high street.
 *
 * The atlas is a grid: a column per design and a row per culture, every cell
 * {@link SIGN_CELL_WIDTH} by {@link SIGN_CELL_HEIGHT}. That is the 4:1 of a
 * shop fascia and of a roadside billboard alike, which is what lets one texture
 * and so one batch serve both (`sign-mesh.ts`).
 *
 * Nothing here touches three.js or the DOM: it answers a byte array, and
 * `sign-material.ts` is what makes a texture of it. There are no asset files
 * (spec section 1.2), so the letters are the pixel font of `pixel-canvas.ts`.
 */
import { SHOP_KINDS, type ShopKind } from '../../world/city/shops.ts';
import type { Culture } from '../../world/types.ts';
import { createCanvas, drawCentred, fillRect, textWidth, type PixelCanvas } from './pixel-canvas.ts';

/**
 * The cultures, in the order the atlas holds their rows. Every culture of spec
 * section 8.3 is here, `none` included: a district with no named neighbourhood
 * still has a high street, and it takes the plain city look of row 0.
 */
export const SIGN_CULTURES: readonly Culture[] = [
  'none',
  'italian',
  'chinese',
  'east-european',
  'latin',
  'african-american',
  'outlaw',
  'irish',
  'beach',
];

/** How one neighbourhood's signs are lettered and coloured. */
export interface CultureLook {
  /**
   * The names over the doors. One is picked by the design in the cell, so a
   * culture's own column of the atlas is not the same name six times.
   */
  names: readonly string[];
  /** The board behind the letters, the frame round it, and the tube that lights it after dark. */
  board: number;
  ink: number;
  neon: number;
}

/**
 * Each culture's look, by the order of {@link SIGN_CULTURES}. The names are the
 * flavour of spec section 8.3 and never the whole character of the place: a
 * shopfront, not a caricature.
 */
export const CULTURE_LOOKS: readonly CultureLook[] = [
  { names: ['CENTRAL', 'MAIN ST', 'THE CITY'], board: 0x2b3038, ink: 0xe8e2d4, neon: 0xf2d98c },
  { names: ['TRATTORIA', 'SALUMERIA', 'DE LUCA'], board: 0x1f3a24, ink: 0xf0ece0, neon: 0xe8533c },
  { names: ['GOLDEN', 'FU KEE', 'JADE'], board: 0x5a1216, ink: 0xf6e6c0, neon: 0xf2c230 },
  { names: ['STARY DOM', 'KOVAC', 'BALTIC'], board: 0x26313d, ink: 0xe6ecf2, neon: 0x8fb8e8 },
  { names: ['BODEGA', 'EL SOL', 'LA PALMA'], board: 0x243a52, ink: 0xfdf3d8, neon: 0xf2953f },
  { names: ['SOUTHSIDE', 'THE BLOCK', 'MAMA JOY'], board: 0x2d2438, ink: 0xf0e8f4, neon: 0xb478f0 },
  { names: ['IRON HOG', 'ROADSIDE', 'BAD LUCK'], board: 0x2a2220, ink: 0xece0d2, neon: 0xe8a23c },
  { names: ["O'HARA", 'SHAMROCK', 'DOCKSIDE'], board: 0x14331f, ink: 0xe8f0e4, neon: 0x6fd08a },
  { names: ['SURFSIDE', 'PIER NINE', 'SUN DECK'], board: 0x123c44, ink: 0xe4f6f4, neon: 0x3fd8d0 },
];

/**
 * What the lower line of an advertisement says. These are the designs a
 * billboard carries: nothing is sold behind a hoarding on a roof, so it
 * advertises rather than names a trade.
 */
export const AD_WORDS: readonly string[] = ['ROOMS TO LET', 'OPEN ALL NIGHT', 'COLD DRINKS'];

/** What the lower line of a shopfront says, by the trade behind it (spec section 16.1). */
const TRADE_WORDS: Record<ShopKind, string> = {
  weapons: 'GUN SHOP',
  workshop: 'GARAGE',
  convenience: 'GROCERY',
  clothing: 'CLOTHING',
  clinic: 'PHARMACY',
  broker: 'REALTY',
};

/**
 * The designs, in the order the atlas holds their columns: the trades of
 * {@link SHOP_KINDS} first, then the advertisements. {@link adDesign} and
 * {@link tradeDesign} are how a caller names one without counting.
 */
export const SIGN_DESIGNS: readonly string[] = [
  ...SHOP_KINDS.map((kind) => TRADE_WORDS[kind]),
  ...AD_WORDS,
];

/** The column a trade takes. */
export function tradeDesign(kind: ShopKind): number {
  return SHOP_KINDS.indexOf(kind);
}

/** The column the `i`th advertisement takes, counted round the list. */
export function adDesign(i: number): number {
  return SHOP_KINDS.length + (i % AD_WORDS.length);
}

/** The row a district's culture takes. A culture with no row of its own takes the plain city look. */
export function cultureRow(culture: Culture): number {
  const at = SIGN_CULTURES.indexOf(culture);
  return at < 0 ? 0 : at;
}

/** The pixels of one cell. The shape is 4:1, which is the shape of a fascia and of a billboard. */
export const SIGN_CELL_WIDTH = 128;
export const SIGN_CELL_HEIGHT = 32;

/** The frame round the board, and the clear pixels left inside it for the letters. */
const FRAME = 2;
const MARGIN = 4;

/** Where the two lines sit, and the largest the name is set. */
const NAME_TOP = 3;
const NAME_SCALE = 2;
const TRADE_TOP = 21;

/**
 * Draw every sign into one picture: a column per design of
 * {@link SIGN_DESIGNS}, a row per culture of {@link SIGN_CULTURES}.
 * `sign-mesh.ts` cuts the cells up again with the texture coordinates of its
 * boards.
 */
export function signAtlas(): PixelCanvas {
  const canvas = createCanvas(SIGN_CELL_WIDTH * SIGN_DESIGNS.length, SIGN_CELL_HEIGHT * SIGN_CULTURES.length, 0x000000);
  for (let row = 0; row < CULTURE_LOOKS.length; row++) {
    for (let design = 0; design < SIGN_DESIGNS.length; design++) {
      drawSign(canvas, CULTURE_LOOKS[row] as CultureLook, design, design * SIGN_CELL_WIDTH, row * SIGN_CELL_HEIGHT);
    }
  }
  return canvas;
}

/** One sign, with its top left corner at `left`, `top`. */
function drawSign(canvas: PixelCanvas, look: CultureLook, design: number, left: number, top: number): void {
  const middle = left + SIGN_CELL_WIDTH / 2;
  fillRect(canvas, left, top, SIGN_CELL_WIDTH, SIGN_CELL_HEIGHT, look.ink);
  // The frame is the ink showing round the board, which is what a painted
  // fascia looks like and what a neon tube is mounted on.
  fillRect(canvas, left + FRAME, top + FRAME, SIGN_CELL_WIDTH - FRAME * 2, SIGN_CELL_HEIGHT - FRAME * 2, look.board);
  // The name is the culture's, in the colour its tubes burn: it is the line
  // that lights after dark, so it is the line the neighbourhood is read by.
  const name = look.names[design % look.names.length] as string;
  const room = SIGN_CELL_WIDTH - MARGIN * 2;
  const scale = textWidth(name, NAME_SCALE) <= room ? NAME_SCALE : 1;
  drawCentred(canvas, name, middle, top + NAME_TOP, scale, look.neon);
  drawCentred(canvas, SIGN_DESIGNS[design] as string, middle, top + TRADE_TOP, 1, look.ink);
}
