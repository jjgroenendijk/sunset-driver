/**
 * The lettering of the tram: the destination boards on the cars and the names
 * and countdowns on the stop panels (spec section 13.2).
 *
 * One atlas for a world, drawn in code with the 5x7 font of `pixel-canvas.ts`
 * the same way `sign-art.ts` draws the advertising. A cell is one line of text
 * and the whole atlas is one column of them, so a quad picks its line by
 * sliding its texture coordinates down (`tram-signs.ts`). The world's stop
 * names are known when a session opens and never change, so the atlas is drawn
 * once and uploaded once.
 *
 * The cells come in three groups, in this order:
 *
 * - a destination for every stop and every fleet, `<route> <STOP>`, in the
 *   amber of a dot matrix on a dark board;
 * - the name of every stop on its own, for the panel on its shelter;
 * - a countdown for every whole minute up to {@link COUNTDOWN_CAP}, with 0
 *   drawn as `DUE`.
 *
 * Nothing here touches the renderer, so it runs headless and is tested as data.
 */
import { COUNTDOWN_CAP, ROUTE_OF, type TramDesign } from '../sim/tram.ts';
import { createCanvas, drawCentred, drawText, fillRect, textWidth, type PixelCanvas } from './pixel-canvas.ts';

/** Pixels of one cell. A cell is one line, so it is wide and short. */
export const CELL_WIDTH = 128;
export const CELL_HEIGHT = 26;

/** The dark of a board and the amber the dots burn in. */
const BOARD_BACK = 0x14120e;
const BOARD_INK = 0xffb62e;
/** The dark of the panel on a shelter, and the cool white it is printed in. */
const PANEL_BACK = 0x101418;
const PANEL_INK = 0xeef0f2;
/** The route number sits in a block of its own colour at the left of a destination. */
const ROUTE_BACK = 0x3a2a08;

/** The fleets a destination is drawn for, in the order their cells are laid down. */
const DESIGNS: TramDesign[] = ['heritage', 'modern'];

/** A drawn atlas, ready to be uploaded as a texture. */
export interface TramSignAtlas {
  width: number;
  height: number;
  data: Uint8Array;
  /** How many cells it holds, which is how the texture coordinates are worked out. */
  cells: number;
}

/**
 * The cell holding the destination a tram of one fleet shows for a stop. The
 * stop is the call's index round the loop.
 */
export function destinationCell(stop: number, design: TramDesign): number {
  return stop * DESIGNS.length + DESIGNS.indexOf(design);
}

/** The cell holding a stop's own name, for the panel on its shelter. */
export function stopNameCell(stops: number, stop: number): number {
  return stops * DESIGNS.length + stop;
}

/** The cell holding the countdown for a whole number of minutes. */
export function countdownCell(stops: number, minutes: number): number {
  const at = Math.max(0, Math.min(COUNTDOWN_CAP, Math.round(minutes)));
  return stops * (DESIGNS.length + 1) + at;
}

/** Draw the atlas for a world whose stops are named, in call order. */
export function tramSignAtlas(names: readonly string[]): TramSignAtlas {
  const cells = names.length * (DESIGNS.length + 1) + COUNTDOWN_CAP + 1;
  const canvas = createCanvas(CELL_WIDTH, CELL_HEIGHT * cells, BOARD_BACK);
  for (let stop = 0; stop < names.length; stop++) {
    for (const design of DESIGNS) {
      destination(canvas, destinationCell(stop, design), ROUTE_OF[design], names[stop] as string);
    }
  }
  for (let stop = 0; stop < names.length; stop++) {
    panel(canvas, stopNameCell(names.length, stop), names[stop] as string);
  }
  for (let minutes = 0; minutes <= COUNTDOWN_CAP; minutes++) {
    const text = minutes === 0 ? 'due' : minutes >= COUNTDOWN_CAP ? `${COUNTDOWN_CAP} min or more` : `${minutes} min`;
    panel(canvas, countdownCell(names.length, minutes), text);
  }
  return { width: canvas.width, height: canvas.height, data: canvas.data, cells };
}

/** A destination board: the route number in a block, and the stop it is bound for beside it. */
function destination(canvas: PixelCanvas, cell: number, route: number, name: string): void {
  const top = cell * CELL_HEIGHT;
  fillRect(canvas, 0, top, CELL_WIDTH, CELL_HEIGHT, BOARD_BACK);
  const block = 26;
  fillRect(canvas, 2, top + 2, block, CELL_HEIGHT - 4, ROUTE_BACK);
  drawCentred(canvas, `${route}`, 2 + block / 2, top + (CELL_HEIGHT - 14) / 2, 2, BOARD_INK);
  write(canvas, name, block + 4, CELL_WIDTH - block - 8, top, BOARD_INK);
}

/** A line on the panel of a shelter: a stop's name, or how long until the next tram. */
function panel(canvas: PixelCanvas, cell: number, text: string): void {
  const top = cell * CELL_HEIGHT;
  fillRect(canvas, 0, top, CELL_WIDTH, CELL_HEIGHT, PANEL_BACK);
  write(canvas, text, 3, CELL_WIDTH - 6, top, PANEL_INK);
}

/**
 * What a blind writes instead of a word too long for it. A real one abbreviates
 * rather than letting a name run off the end, and so does this.
 */
const SHORT: readonly (readonly [string, string])[] = [
  ['DISTRICT', 'DIST'],
  ['BOARDWALK', 'B/WALK'],
  ['INTERNATIONAL', 'INTL'],
];

function shorten(text: string): string {
  let out = text;
  for (const [long, short] of SHORT) out = out.replace(long, short);
  return out;
}

/**
 * Write one line centred in a cell, as large as it fits. A name too long for
 * the cell even at the smallest size loses its tail rather than running over
 * the edge into the next cell.
 */
function write(canvas: PixelCanvas, text: string, left: number, room: number, top: number, ink: number): void {
  let line = shorten(text.toUpperCase());
  let scale = 2;
  while (scale > 1 && textWidth(line, scale) > room) scale--;
  while (line.length > 1 && textWidth(line, scale) > room) line = line.slice(0, -1);
  const x = left + Math.round((room - textWidth(line, scale)) / 2);
  drawText(canvas, line, x, top + Math.round((CELL_HEIGHT - 7 * scale) / 2), scale, ink);
}
