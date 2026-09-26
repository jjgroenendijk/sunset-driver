/**
 * The harm-reduction posters of spec section 19, as pictures drawn in code.
 *
 * Spec section 19 asks for the information in the world's own texture: factual,
 * non-judgemental, never a modal and never a lecture. A poster is the quietest
 * form of that. It says one thing, it says it in the plain words a public
 * health service uses, and a player who never looks at a wall never reads one.
 * The radio's share of the same content is `src/audio/psa.ts`; this is the
 * wall's.
 *
 * Every poster is one cell of one texture (`posterAtlas`), so the whole city's
 * posters cost one upload and a batch draws them together whichever of them it
 * holds. The cell is {@link POSTER_CELL_WIDTH} by {@link POSTER_CELL_HEIGHT},
 * which is the 5:7 of a printed sheet, and `poster-mesh.ts` hangs boards of
 * that shape.
 *
 * Nothing here touches three.js or the DOM: it answers a byte array, and
 * `poster-material.ts` is what makes a texture of it.
 */
import {
  createCanvas,
  drawCentred,
  drawSprite,
  drawText,
  fillRect,
  GLYPH_HEIGHT,
  type PixelCanvas,
} from './pixel-canvas.ts';

/** One poster: what it says, what it is set in, and the mark it carries. */
export interface PosterArt {
  /** The word across the top, in the band. Twelve letters is what fits. */
  headline: string;
  /** The body, a line at a time. Twenty-four letters is what fits. */
  lines: readonly string[];
  /** Who the poster is from, along the bottom. */
  from: string;
  /** The paper it is printed on, the colour of the words, and the mark's colour. */
  paper: number;
  ink: number;
  accent: number;
  /** The mark above the body: nine rows of nine pixels, as `drawSprite` reads them. */
  mark: readonly string[];
}

const CROSS = [
  '000111000',
  '000111000',
  '000111000',
  '111111111',
  '111111111',
  '111111111',
  '000111000',
  '000111000',
  '000111000',
];

const STRIP = [
  '001111100',
  '001000100',
  '001111100',
  '001000100',
  '001000100',
  '001111100',
  '001000100',
  '001111100',
  '001000100',
];

const DOOR = [
  '111111111',
  '110000011',
  '100000001',
  '100000001',
  '100000011',
  '100000011',
  '100000001',
  '100000001',
  '111111111',
];

const PHONE = [
  '011111110',
  '110000011',
  '100000001',
  '101111101',
  '101111101',
  '100000001',
  '110000011',
  '011111110',
  '000111000',
];

const STEPS = [
  '111000000',
  '111000000',
  '111110000',
  '111110000',
  '111111100',
  '111111100',
  '111111111',
  '111111111',
  '111111111',
];

const ARROWS = [
  '000000000',
  '010000000',
  '111111111',
  '010000000',
  '000000000',
  '000000010',
  '111111111',
  '000000010',
  '000000000',
];

/**
 * The posters, in the order the atlas holds them. Each one carries a single
 * piece of information and stops: a wall is read in the second a car goes past
 * it, so a poster that argues is a poster nobody finishes.
 */
export const POSTER_ART: readonly PosterArt[] = [
  {
    headline: 'NALOXONE',
    lines: ['NALOXONE REVERSES AN', 'OPIOID OVERDOSE. IT IS', 'FREE, IT NEEDS NO', 'PRESCRIPTION.'],
    from: 'CITY HEALTH',
    paper: 0xf2efe4,
    ink: 0x2b2f36,
    accent: 0xc8402f,
    mark: CROSS,
  },
  {
    headline: 'TEST STRIPS',
    lines: ['FENTANYL TURNS UP IN', 'MORE THAN DOPE NOW.', 'TEST STRIPS ARE FREE', 'AT THE CLINIC.'],
    from: 'CITY HEALTH',
    paper: 0xe8eef0,
    ink: 0x24333c,
    accent: 0x2f8f9d,
    mark: STRIP,
  },
  {
    headline: 'NOT ALONE',
    lines: ['NEVER USE ALONE. LEAVE', 'THE DOOR UNLOCKED AND', 'ASK SOMEONE TO CHECK', 'ON YOU.'],
    from: 'CITY HEALTH',
    paper: 0xf4ead8,
    ink: 0x33291f,
    accent: 0xd08a2c,
    mark: DOOR,
  },
  {
    headline: 'CALL IT IN',
    lines: ['CALLING FOR HELP AT AN', 'OVERDOSE BRINGS NO', 'CHARGE IN THIS CITY.'],
    from: 'CITY ORDINANCE 14-2',
    paper: 0x1f242c,
    ink: 0xeae6dc,
    accent: 0x7fb069,
    mark: PHONE,
  },
  {
    headline: 'GO SLOW',
    lines: ['A WEEK CLEAN TAKES YOUR', 'TOLERANCE WITH IT. THE', 'OLD DOSE IS WHAT', 'CATCHES PEOPLE.'],
    from: 'CITY HEALTH',
    paper: 0xf0e9df,
    ink: 0x2e2a33,
    accent: 0x6b5bd2,
    mark: STEPS,
  },
  {
    headline: 'EXCHANGE',
    lines: ['THE NEEDLE EXCHANGE ON', 'THE BOARDWALK ASKS NO', 'NAMES AND KEEPS NO', 'NUMBERS. CLEAN WORKS.'],
    from: 'HARBOUR CLINIC',
    paper: 0xe4ecdf,
    ink: 0x27332a,
    accent: 0x3f7d5a,
    mark: ARROWS,
  },
];

/** The pixels of one poster. The shape is 5:7, which is the shape of a printed sheet. */
export const POSTER_CELL_WIDTH = 160;
export const POSTER_CELL_HEIGHT = 224;

/** The white edge left round the print, the band across the top, and the mark under it. */
const MARGIN = 6;
const BAND_HEIGHT = 38;
const HEADLINE_SCALE = 2;
const MARK_SCALE = 5;
const MARK_TOP = 56;

/** Where the body starts, how far apart its lines sit, and where the credit sits. */
const BODY_TOP = 122;
const BODY_LEADING = 13;
const FROM_TOP = 196;

/**
 * Draw every poster into one picture, side by side in the order of
 * {@link POSTER_ART}. `poster-mesh.ts` cuts the cells up again with the texture
 * coordinates of its boards.
 */
export function posterAtlas(): PixelCanvas {
  const canvas = createCanvas(POSTER_CELL_WIDTH * POSTER_ART.length, POSTER_CELL_HEIGHT, 0x000000);
  for (let i = 0; i < POSTER_ART.length; i++) {
    drawPoster(canvas, POSTER_ART[i] as PosterArt, i * POSTER_CELL_WIDTH);
  }
  return canvas;
}

/** One poster, with its left edge at `left`. */
function drawPoster(canvas: PixelCanvas, art: PosterArt, left: number): void {
  const middle = left + POSTER_CELL_WIDTH / 2;
  const inner = POSTER_CELL_WIDTH - MARGIN * 2;
  fillRect(canvas, left, 0, POSTER_CELL_WIDTH, POSTER_CELL_HEIGHT, art.paper);
  // The band is the one heavy shape on the sheet, so the headline reads from
  // across the street even where the body is a grey texture.
  fillRect(canvas, left + MARGIN, MARGIN, inner, BAND_HEIGHT, art.ink);
  drawCentred(canvas, art.headline, middle, MARGIN + (BAND_HEIGHT - GLYPH_HEIGHT * HEADLINE_SCALE) / 2, HEADLINE_SCALE, art.paper);
  const mark = art.mark;
  const markWidth = (mark[0] as string).length * MARK_SCALE;
  drawSprite(canvas, mark, Math.round(middle - markWidth / 2), MARK_TOP, MARK_SCALE, art.accent);
  for (let line = 0; line < art.lines.length; line++) {
    drawText(canvas, art.lines[line] as string, left + MARGIN + 2, BODY_TOP + line * BODY_LEADING, 1, art.ink);
  }
  drawText(canvas, art.from, left + MARGIN + 2, FROM_TOP, 1, art.accent);
}

