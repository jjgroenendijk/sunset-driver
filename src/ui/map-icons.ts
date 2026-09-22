/**
 * The icons of the map of spec section 12, in screen pixels. `map-draw.ts`
 * places them; this file says how one is drawn. The picture inside an icon
 * comes from `map-glyphs.ts`, and `POI_STYLES` in `map.ts` says which picture
 * each kind of place gets.
 *
 * A place is a disc in its own colour with its picture knocked out of it in
 * dark. Knocking the picture out rather than filling it is what keeps the
 * picture readable at the 20 pixels the minimap draws an icon at: the eye is
 * given a solid colour the size of the whole icon, not a thin figure on it.
 *
 * The waypoint and the objective are pins instead — a teardrop with its point
 * on the place — because they are what the player is heading for, and a pin
 * says "here" where a disc says "there is one of these here".
 */
import { GLYPHS, type GlyphName } from './map-glyphs.ts';
import { POI_STYLES, type PoiStyle } from './map.ts';

/** The dark the picture is knocked out in, and the rim around a pin. */
const DARK = '#1a0c16';

/**
 * Pixels across an icon on the minimap. At 11 the pictures blurred into dots.
 * It is larger than the full map's 18: the minimap is read at a glance, while
 * driving, and holds only a few icons at a time.
 */
export const MINIMAP_ICON = 20;

/** How much of an icon's width the picture takes. */
const GLYPH_SHARE = 0.68;

/**
 * One marked place. Every mark on the map is drawn this way except the
 * player's arrow, which is larger and outlined instead.
 */
export function drawMark(
  ctx: CanvasRenderingContext2D,
  style: PoiStyle,
  x: number,
  y: number,
  size: number,
): void {
  if (style.pin === true) drawPin(ctx, style.glyph, style.colour, x, y, size);
  else drawIcon(ctx, style.glyph, style.colour, x, y, size);
}

/** The player, as an arrow pointing the way they face. Drawn last, over everything. */
export function drawPlayer(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  // A heading of 0 points along world `+x`, which the canvas draws to the right,
  // so the arrow is modelled pointing right and turned by the heading.
  ctx.rotate(angle);
  ctx.beginPath();
  GLYPHS.arrow(ctx, size);
  ctx.fillStyle = POI_STYLES.player.colour;
  ctx.strokeStyle = DARK;
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * One icon on its disc, in screen pixels, centred on the place it marks. The
 * picture is what tells two kinds of place apart on a minimap the size of a
 * postage stamp; the colour is what tells them apart at a glance. Every
 * picture is drawn inside a box `2 * r` across, so no icon crowds its
 * neighbour more than another.
 */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  glyph: GlyphName,
  colour: string,
  x: number,
  y: number,
  size: number,
): void {
  const r = size / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.92, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
  // A hairline of the map's own dark, so two icons that touch still read as two.
  ctx.strokeStyle = DARK;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = DARK;
  GLYPHS[glyph](ctx, r * GLYPH_SHARE);
  ctx.fill();
  ctx.restore();
}

/** An icon as a pin, its point on the place and its picture in the head. */
export function drawPin(
  ctx: CanvasRenderingContext2D,
  glyph: GlyphName,
  colour: string,
  x: number,
  y: number,
  size: number,
): void {
  const r = size / 2;
  ctx.save();
  // The point sits on the place, so the head stands above it the way a pin
  // pushed into a paper map does.
  ctx.translate(x, y + r * 0.9);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-0.7 * r, -0.95 * r, -0.95 * r, -1.2 * r, -0.95 * r, -1.75 * r);
  ctx.arc(0, -1.75 * r, 0.95 * r, Math.PI, 0);
  ctx.bezierCurveTo(0.95 * r, -1.2 * r, 0.7 * r, -0.95 * r, 0, 0);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.strokeStyle = DARK;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.translate(0, -1.75 * r);
  ctx.beginPath();
  ctx.fillStyle = DARK;
  GLYPHS[glyph](ctx, r * 0.62);
  ctx.fill();
  ctx.restore();
}
