/**
 * The icons of the map of spec section 12, in screen pixels. `map-draw.ts`
 * places them; this file says what each shape looks like. The shapes are the
 * ones `POI_STYLES` in `map.ts` names, one to a kind of place.
 */
import { POI_STYLES, type IconShape } from './map.ts';

/** The dark disc behind an icon, so it reads over a road or a bright shore. */
const BACKING = 'rgba(22,10,19,.78)';

/**
 * An icon on its backing disc. Every mark on the map is drawn this way except
 * the player's arrow, which is larger and outlined instead.
 */
export function drawMark(
  ctx: CanvasRenderingContext2D,
  shape: IconShape,
  colour: string,
  x: number,
  y: number,
  size: number,
): void {
  ctx.beginPath();
  ctx.arc(x, y, size * 0.72, 0, Math.PI * 2);
  ctx.fillStyle = BACKING;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = colour;
  ctx.globalAlpha = 0.55;
  ctx.stroke();
  ctx.globalAlpha = 1;
  drawIcon(ctx, shape, colour, x, y, size * 0.78);
}

/** The player, as an arrow pointing the way they face. Drawn last, over everything. */
export function drawPlayer(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  // A heading of 0 points along world `+x`, which the canvas draws to the right,
  // so the arrow is modelled pointing right and turned by the heading.
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.7, size * 0.7);
  ctx.lineTo(-size * 0.35, 0);
  ctx.lineTo(-size * 0.7, -size * 0.7);
  ctx.closePath();
  ctx.fillStyle = POI_STYLES.player.colour;
  ctx.strokeStyle = '#210d18';
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * One icon, in screen pixels. The shape is what tells two kinds of place apart
 * on a minimap the size of a postage stamp; the colour is what tells them apart
 * at a glance. Every shape is drawn inside a box `2 * r` across, so no icon
 * crowds its neighbour more than another.
 */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  shape: IconShape,
  colour: string,
  x: number,
  y: number,
  size: number,
): void {
  const r = size / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = colour;
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1.2, r * 0.35);
  ctx.lineCap = 'round';
  ctx.beginPath();
  switch (shape) {
    case 'disc':
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'ring':
      ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'square':
      ctx.rect(-r, -r, r * 2, r * 2);
      ctx.fill();
      break;
    case 'diamond':
      ctx.moveTo(0, -r);
      ctx.lineTo(r, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r, 0);
      ctx.closePath();
      ctx.fill();
      break;
    case 'triangle':
      ctx.moveTo(0, -r);
      ctx.lineTo(r, r * 0.8);
      ctx.lineTo(-r, r * 0.8);
      ctx.closePath();
      ctx.fill();
      break;
    case 'hexagon':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const rad = i % 2 === 0 ? r : r * 0.45;
        const px = Math.cos(a) * rad;
        const py = Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      break;
    case 'pin':
      // A teardrop with its point on the place it marks.
      ctx.arc(0, -r * 0.35, r * 0.7, Math.PI * 0.85, Math.PI * 0.15);
      ctx.lineTo(0, r);
      ctx.closePath();
      ctx.fill();
      break;
    case 'house':
      ctx.moveTo(0, -r);
      ctx.lineTo(r, 0);
      ctx.lineTo(r * 0.6, 0);
      ctx.lineTo(r * 0.6, r);
      ctx.lineTo(-r * 0.6, r);
      ctx.lineTo(-r * 0.6, 0);
      ctx.lineTo(-r, 0);
      ctx.closePath();
      ctx.fill();
      break;
    case 'shield':
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.85, -r * 0.5);
      ctx.lineTo(r * 0.85, r * 0.25);
      ctx.lineTo(0, r);
      ctx.lineTo(-r * 0.85, r * 0.25);
      ctx.lineTo(-r * 0.85, -r * 0.5);
      ctx.closePath();
      ctx.fill();
      break;
    case 'cross':
      ctx.rect(-r * 0.32, -r, r * 0.64, r * 2);
      ctx.rect(-r, -r * 0.32, r * 2, r * 0.64);
      ctx.fill();
      break;
    case 'flag':
      ctx.moveTo(-r * 0.5, r);
      ctx.lineTo(-r * 0.5, -r);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-r * 0.5, -r);
      ctx.lineTo(r, -r * 0.55);
      ctx.lineTo(-r * 0.5, -r * 0.1);
      ctx.closePath();
      ctx.fill();
      break;
    case 'chevron':
      ctx.moveTo(-r, r * 0.4);
      ctx.lineTo(0, -r * 0.6);
      ctx.lineTo(r, r * 0.4);
      ctx.stroke();
      break;
    case 'bars':
      // A pier: the deck, as planks.
      for (let i = -1; i <= 1; i++) {
        ctx.moveTo(-r, (i * r) / 1.5);
        ctx.lineTo(r, (i * r) / 1.5);
      }
      ctx.stroke();
      break;
    case 'cup':
      ctx.moveTo(-r * 0.7, -r * 0.6);
      ctx.lineTo(r * 0.5, -r * 0.6);
      ctx.lineTo(r * 0.2, r);
      ctx.lineTo(-r * 0.4, r);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(r * 0.6, -r * 0.05, r * 0.4, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      break;
    case 'roundel':
      // The underground's own mark: a ring with a bar across it.
      ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-r, 0);
      ctx.lineTo(r, 0);
      ctx.stroke();
      break;
    case 'arrow':
      ctx.moveTo(r, 0);
      ctx.lineTo(-r * 0.7, r * 0.7);
      ctx.lineTo(-r * 0.35, 0);
      ctx.lineTo(-r * 0.7, -r * 0.7);
      ctx.closePath();
      ctx.fill();
      break;
    case 'burst':
      // Somebody coming at the player: strokes out of one point, so it reads as
      // a threat rather than as another place on the map.
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.moveTo(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.stroke();
      break;
    case 'bunting':
      // Three pennants on a line: a street that has something on it.
      ctx.moveTo(-r, -r * 0.6);
      ctx.lineTo(r, -r * 0.6);
      ctx.stroke();
      for (let i = 0; i < 3; i++) {
        const cx = -r + ((i + 0.5) / 3) * 2 * r;
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.28, -r * 0.6);
        ctx.lineTo(cx + r * 0.28, -r * 0.6);
        ctx.lineTo(cx, r * 0.7);
        ctx.closePath();
        ctx.fill();
      }
      break;
    case 'bolt':
      // A zigzag: something happening rather than somewhere to go.
      ctx.moveTo(r * 0.35, -r);
      ctx.lineTo(-r * 0.25, r * 0.05);
      ctx.lineTo(r * 0.15, r * 0.05);
      ctx.lineTo(-r * 0.45, r);
      ctx.stroke();
      break;
    case 'key':
      // A key on its side: the bow at the left, the shank and one tooth.
      ctx.arc(-r * 0.5, 0, r * 0.45, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-r * 0.05, 0);
      ctx.lineTo(r, 0);
      ctx.moveTo(r * 0.55, 0);
      ctx.lineTo(r * 0.55, r * 0.5);
      ctx.stroke();
      break;
  }
  ctx.restore();
}
