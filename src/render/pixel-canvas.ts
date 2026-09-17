/**
 * A picture drawn in code, pixel by pixel, and the small font that writes on
 * it.
 *
 * Spec section 1.2 forbids asset files, so every texture in the game is built
 * at runtime. The posters of spec section 19 carry words, and words need
 * letters; a font file is an asset, so the letters are a table of rows here.
 * Each glyph is {@link GLYPH_WIDTH} by {@link GLYPH_HEIGHT} pixels, written as
 * one string of `0` and `1` per row, which is the one shape a reader can check
 * by looking at it.
 *
 * The buffer is RGBA bytes, the layout a `DataTexture` takes. Nothing here
 * touches three.js or the DOM, so a test can build a picture and read its
 * pixels back in Node.
 */

/** A picture being drawn: RGBA bytes, one row after another from the top. */
export interface PixelCanvas {
  width: number;
  height: number;
  data: Uint8Array;
}

/** The size of one glyph, and the pixels from the left of one to the left of the next. */
export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
export const GLYPH_ADVANCE = GLYPH_WIDTH + 1;

/**
 * The letters, as rows of pixels. Uppercase only: a poster is set in capitals,
 * and a second case would double a table that is already the largest thing in
 * this file. A character the table does not hold is drawn as a space.
 */
const FONT: Record<string, string> = {
  A: '01110 10001 10001 11111 10001 10001 10001',
  B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110',
  D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111',
  F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111',
  H: '10001 10001 10001 11111 10001 10001 10001',
  I: '11111 00100 00100 00100 00100 00100 11111',
  J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001',
  L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001',
  N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101',
  R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110',
  T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110',
  V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 11011 10001',
  X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100',
  Z: '11111 00001 00010 00100 01000 10000 11111',
  '0': '01110 10001 10011 10101 11001 10001 01110',
  '1': '00100 01100 00100 00100 00100 00100 01110',
  '2': '01110 10001 00001 00010 00100 01000 11111',
  '3': '11111 00010 00100 00010 00001 10001 01110',
  '4': '00010 00110 01010 10010 11111 00010 00010',
  '5': '11111 10000 11110 00001 00001 10001 01110',
  '6': '00110 01000 10000 11110 10001 10001 01110',
  '7': '11111 00001 00010 00100 01000 01000 01000',
  '8': '01110 10001 10001 01110 10001 10001 01110',
  '9': '01110 10001 10001 01111 00001 00010 01100',
  '.': '00000 00000 00000 00000 00000 01100 01100',
  ',': '00000 00000 00000 00000 01100 00100 01000',
  "'": '00100 00100 01000 00000 00000 00000 00000',
  '-': '00000 00000 00000 01110 00000 00000 00000',
  ':': '00000 01100 01100 00000 01100 01100 00000',
  '!': '00100 00100 00100 00100 00100 00000 00100',
  '?': '01110 10001 00001 00110 00100 00000 00100',
  '/': '00001 00010 00010 00100 01000 01000 10000',
  '(': '00010 00100 01000 01000 01000 00100 00010',
  ')': '01000 00100 00010 00010 00010 00100 01000',
};

/** A picture of one colour, ready to be drawn on. */
export function createCanvas(width: number, height: number, colour: number): PixelCanvas {
  const canvas: PixelCanvas = { width, height, data: new Uint8Array(width * height * 4) };
  fillRect(canvas, 0, 0, width, height, colour);
  return canvas;
}

/**
 * Paint a rectangle. Anything outside the picture is dropped rather than
 * wrapped, so a caller may draw over an edge without measuring first.
 */
export function fillRect(canvas: PixelCanvas, x: number, y: number, width: number, height: number, colour: number): void {
  const red = (colour >> 16) & 0xff;
  const green = (colour >> 8) & 0xff;
  const blue = colour & 0xff;
  const fromX = Math.max(0, Math.trunc(x));
  const fromY = Math.max(0, Math.trunc(y));
  const toX = Math.min(canvas.width, Math.trunc(x + width));
  const toY = Math.min(canvas.height, Math.trunc(y + height));
  for (let row = fromY; row < toY; row++) {
    for (let column = fromX; column < toX; column++) {
      const at = (row * canvas.width + column) * 4;
      canvas.data[at] = red;
      canvas.data[at + 1] = green;
      canvas.data[at + 2] = blue;
      canvas.data[at + 3] = 0xff;
    }
  }
}

/**
 * Paint a picture written as rows of `0` and `1`, each pixel `scale` across.
 * The font and the marks on a poster are both drawn this way, so a mark is
 * data rather than code.
 */
export function drawSprite(
  canvas: PixelCanvas,
  rows: readonly string[],
  x: number,
  y: number,
  scale: number,
  colour: number,
): void {
  for (let row = 0; row < rows.length; row++) {
    const bits = rows[row] as string;
    for (let column = 0; column < bits.length; column++) {
      if (bits[column] !== '1') continue;
      fillRect(canvas, x + column * scale, y + row * scale, scale, scale, colour);
    }
  }
}

/** Write a line of text with its top left corner at `x`, `y`. */
export function drawText(canvas: PixelCanvas, text: string, x: number, y: number, scale: number, colour: number): void {
  const line = text.toUpperCase();
  for (let i = 0; i < line.length; i++) {
    const glyph = FONT[line[i] as string];
    if (glyph !== undefined) drawSprite(canvas, glyph.split(' '), x + i * GLYPH_ADVANCE * scale, y, scale, colour);
  }
}

/** Pixels a line of text takes, without the space after its last letter. */
export function textWidth(text: string, scale: number): number {
  return text.length === 0 ? 0 : (text.length * GLYPH_ADVANCE - 1) * scale;
}

/** Write a line of text centred on `middle`. */
export function drawCentred(
  canvas: PixelCanvas,
  text: string,
  middle: number,
  y: number,
  scale: number,
  colour: number,
): void {
  drawText(canvas, text, Math.round(middle - textWidth(text, scale) / 2), y, scale, colour);
}
