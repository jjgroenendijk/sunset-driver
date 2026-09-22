/**
 * The page half of `scripts/icon-sheet.ts`: draw every map icon on one sheet,
 * at the size the full map draws it and at the size the minimap does, so an
 * icon is judged by looking at it rather than by reading its code.
 *
 * It needs no world and no WebGPU device: a 2D canvas, the icon table and the
 * glyphs. It draws through `map-icons.ts`, so the sheet shows what the game
 * shows and cannot drift from it.
 */
import { drawMark, drawPlayer } from './map-icons.ts';
import { POI_STYLES, type PoiType } from './map.ts';

/** What the driver asks for. */
export interface IconSheetRequest {
  width: number;
  /** The icon sizes to draw each place at. The map uses 18 and the minimap 11. */
  sizes: readonly number[];
}

/** What comes back: the picture. */
export interface IconSheetResult {
  width: number;
  height: number;
  /** RGB rows, base64. The driver turns them into a PNG. */
  rgb: string;
}

/** Draw the sheet and hand the pixels back. */
export function renderIconSheet(request: IconSheetRequest): IconSheetResult {
  const types = Object.keys(POI_STYLES) as PoiType[];
  const rowHeight = 46;
  const top = 58;
  const width = request.width;
  const height = top + types.length * rowHeight + 20;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#12070f';
  ctx.fillRect(0, 0, width, height);
  ctx.font = '12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  // One column per size, and the size written over it. The sizes grow to the
  // right, so a column is compared with the one beside it.
  const first = 300;
  const step = Math.max(70, (width - first - 40) / Math.max(1, request.sizes.length));
  request.sizes.forEach((size, i) => {
    ctx.fillStyle = '#c8b3c4';
    ctx.textAlign = 'center';
    ctx.fillText(`${size} px`, first + i * step, 30);
  });
  ctx.textAlign = 'left';
  ctx.fillStyle = '#c8b3c4';
  ctx.fillText('The map icons of spec section 12', 20, 30);

  types.forEach((type, row) => {
    const style = POI_STYLES[type];
    const y = top + row * rowHeight + rowHeight / 2;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e8dbe6';
    ctx.fillText(style.label, 20, y);
    ctx.fillStyle = '#8f7d8c';
    ctx.fillText(style.glyph, 150, y);
    request.sizes.forEach((size, i) => {
      const x = first + i * step;
      // The player is an arrow the map turns, so it is drawn the way the map
      // draws it rather than as a mark.
      if (type === 'player') drawPlayer(ctx, x, y, 0, size * 1.15);
      else drawMark(ctx, style, x, y, size);
    });
  });

  const image = ctx.getImageData(0, 0, width, height);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, o = 0; i < image.data.length; i += 4, o += 3) {
    rgb[o] = image.data[i]!;
    rgb[o + 1] = image.data[i + 1]!;
    rgb[o + 2] = image.data[i + 2]!;
  }
  let binary = '';
  for (const byte of rgb) binary += String.fromCharCode(byte);
  return { width, height, rgb: btoa(binary) };
}
