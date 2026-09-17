/**
 * The canvas half of the map of spec section 12: the one place that says what a
 * map looks like. `minimap.ts` and `map-screen.ts` both draw through it, so the
 * corner map and the full map cannot drift apart.
 *
 * `MapArt` is built once for a session and holds everything that does not
 * change: the land and sea as a bitmap the size of the terrain grid, the beach
 * sand, the tram loop and the road index of `map.ts`. Drawing a frame is then a
 * clipped blit and a few hundred stroked segments, whatever the world's size.
 *
 * The roads are strokes rather than pixels of that bitmap, so the map is sharp
 * at every zoom: a minimap at half a metre to the pixel and a whole-world view
 * at sixteen read off the same lines.
 */
import type { Point, RoadTier, WorldDescription } from '../world/types.ts';
import {
  POI_STYLES,
  RoadSegmentIndex,
  SEGMENT_STRIDE,
  tierPen,
  viewBounds,
  type IconShape,
  type MapPoi,
  type MapPois,
  type MapView,
} from './map.ts';

/** What each tier is drawn in. Widest first, and the order they are stroked in. */
const TIER_COLOURS: readonly (readonly [RoadTier, string])[] = Object.freeze([
  ['highway', '#3a2230'] as const,
  ['arterial', '#5a3444'] as const,
  ['street', '#6d4256'] as const,
  ['alley', '#573546'] as const,
  ['dirt', '#5e4a3a'] as const,
]);

/** The colours of everything that is not a road. */
const SEA = '#123048';
const SAND = '#9a8258';
const TRAM = '#e05ad0';
const WAYPOINT_LINE = '#ff8a5c';

/** A place is named beside its icon only at this many metres to the pixel or closer. */
const LABEL_SCALE = 2;

/** Metres of depth over which the sea darkens from the shore to its deepest. */
const DEPTH_RANGE = 20;

/** What one map frame is asked to draw over the land. */
export interface MapDrawOptions {
  /**
   * Where the player stands and which way they face, or null where there is no
   * player yet: the seed preview of the title screen draws the map alone.
   */
  player: { x: number; y: number; heading: number } | null;
  /** The place the player has marked, or null. A line is run to it from the player. */
  waypoint: { x: number; y: number } | null;
  /** Pixels across an icon. A minimap draws them smaller than the full map. */
  iconSize: number;
  /**
   * True on the full map: district names are written across the map, and a
   * place's own name beside its icon once the map is close enough that the
   * names do not run into one another (see {@link LABEL_SCALE}).
   */
  labels: boolean;
  /**
   * The territory overlay slot of spec section 12, for the factions of spec
   * section 17. It is called with the canvas already transformed into world
   * metres, so it draws in the world's own coordinates, over the land and under
   * the icons.
   */
  overlay?: (ctx: CanvasRenderingContext2D, view: MapView) => void;
}

export class MapArt {
  readonly world: WorldDescription;
  readonly pois: MapPois;
  private readonly segments: RoadSegmentIndex;
  /** The land and the sea, one pixel to a terrain cell. Drawn scaled at any zoom. */
  private readonly ground: HTMLCanvasElement;

  constructor(world: WorldDescription, pois: MapPois) {
    this.world = world;
    this.pois = pois;
    this.segments = new RoadSegmentIndex(world.roads, world.size);
    this.ground = renderGround(world);
  }

  /**
   * Draw one frame of the map onto `ctx`, which must already be cleared and
   * clipped to the shape the widget wants. `width` and `height` are the canvas
   * in CSS pixels, which is what `map.ts` projects into.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    view: MapView,
    width: number,
    height: number,
    opts: MapDrawOptions,
  ): void {
    const world = this.world;
    const half = world.size / 2;
    const bounds = viewBounds(view, width, height);

    ctx.save();
    // From here to the matching restore the canvas is in world metres, so
    // everything below is written in the same coordinates the world uses.
    ctx.translate(width / 2, height / 2);
    ctx.rotate(view.rotation);
    ctx.scale(1 / view.metresPerPixel, 1 / view.metresPerPixel);
    ctx.translate(-view.x, -view.y);

    ctx.fillStyle = SEA;
    ctx.fillRect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    ctx.drawImage(this.ground, -half, -half, world.size, world.size);

    // The sand of spec section 7.3. It is the one parcel type worth a colour of
    // its own at map scale: a resort is what a player steers toward.
    ctx.fillStyle = SAND;
    ctx.beginPath();
    for (const beach of world.beaches) {
      if (beach.sand.length < 3) continue;
      if (beach.sand[0]!.x < bounds.minX - 200 || beach.sand[0]!.x > bounds.maxX + 200) continue;
      if (beach.sand[0]!.y < bounds.minY - 200 || beach.sand[0]!.y > bounds.maxY + 200) continue;
      ring(ctx, beach.sand);
    }
    ctx.fill();

    this.strokeRoads(ctx, view, bounds);

    // The tram of spec section 13.2, drawn over the arterials it runs down.
    if (world.tram.route.length > 1) {
      ctx.strokeStyle = TRAM;
      ctx.lineWidth = Math.max(1.5, 3) * view.metresPerPixel;
      ctx.setLineDash([8 * view.metresPerPixel, 6 * view.metresPerPixel]);
      ctx.beginPath();
      polyline(ctx, world.tram.route);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    opts.overlay?.(ctx, view);

    if (opts.waypoint && opts.player) {
      ctx.strokeStyle = WAYPOINT_LINE;
      ctx.lineWidth = 1.5 * view.metresPerPixel;
      ctx.setLineDash([10 * view.metresPerPixel, 8 * view.metresPerPixel]);
      ctx.beginPath();
      ctx.moveTo(opts.player.x, opts.player.y);
      ctx.lineTo(opts.waypoint.x, opts.waypoint.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();

    // The icons are drawn in screen pixels, so they stay the same size however
    // far the map is pulled back and never turn with a rotating map.
    if (opts.labels) this.drawDistrictNames(ctx, view, width, height, bounds);
    const marks = this.pois.visible(bounds, view.metresPerPixel);
    // A name under every icon is unreadable on a map pulled back far enough to
    // hold a district: the names run into one another and into the district's
    // own. Past that the shape and the colour carry the icon on their own.
    const named = opts.labels && view.metresPerPixel <= LABEL_SCALE;
    if (opts.waypoint) marks.push({ type: 'waypoint', x: opts.waypoint.x, y: opts.waypoint.y });
    for (const poi of marks) {
      const p = projectInto(view, width, height, poi.x, poi.y);
      const style = POI_STYLES[poi.type];
      drawIcon(ctx, style.shape, style.colour, p.x, p.y, opts.iconSize);
      if (named) label(ctx, poi.name ?? style.label, p.x, p.y + opts.iconSize);
    }
    if (opts.player) {
      const me = projectInto(view, width, height, opts.player.x, opts.player.y);
      drawPlayer(ctx, me.x, me.y, opts.player.heading + view.rotation, opts.iconSize * 1.15);
    }
  }

  /** Every tier the zoom shows, widest first, so a street lies over the highway it joins. */
  private strokeRoads(ctx: CanvasRenderingContext2D, view: MapView, bounds: ReturnType<typeof viewBounds>): void {
    const roads = this.world.roads;
    const keys = this.segments.segmentsIn(bounds);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [tier, colour] of TIER_COLOURS) {
      const pen = tierPen(tier, view.metresPerPixel);
      if (pen === 0) continue;
      ctx.strokeStyle = colour;
      ctx.lineWidth = pen * view.metresPerPixel;
      ctx.beginPath();
      let drew = false;
      for (const key of keys) {
        const road = roads[Math.floor(key / SEGMENT_STRIDE)];
        if (road === undefined || road.tier !== tier) continue;
        const i = key % SEGMENT_STRIDE;
        const a = road.points[i];
        const b = road.points[i + 1];
        if (a === undefined || b === undefined) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        drew = true;
      }
      if (drew) ctx.stroke();
    }
  }

  /** District names, at the site of each cell. Only the full map writes them. */
  private drawDistrictNames(
    ctx: CanvasRenderingContext2D,
    view: MapView,
    width: number,
    height: number,
    bounds: ReturnType<typeof viewBounds>,
  ): void {
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(246,214,193,.75)';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 3;
    for (const district of this.world.districts) {
      if (district.x < bounds.minX || district.x > bounds.maxX) continue;
      if (district.y < bounds.minY || district.y > bounds.maxY) continue;
      const p = projectInto(view, width, height, district.x, district.y);
      ctx.fillText(district.name.toUpperCase(), p.x, p.y);
    }
    ctx.restore();
  }
}

/** `project` from `map.ts`, inlined here so a frame of icons allocates nothing. */
function projectInto(view: MapView, width: number, height: number, x: number, y: number): { x: number; y: number } {
  const dx = x - view.x;
  const dy = y - view.y;
  const c = Math.cos(view.rotation);
  const s = Math.sin(view.rotation);
  return {
    x: width / 2 + (dx * c - dy * s) / view.metresPerPixel,
    y: height / 2 + (dx * s + dy * c) / view.metresPerPixel,
  };
}

/** Add a closed ring to the current path. */
function ring(ctx: CanvasRenderingContext2D, points: readonly Point[]): void {
  polyline(ctx, points);
  ctx.closePath();
}

/** Add an open line to the current path. */
function polyline(ctx: CanvasRenderingContext2D, points: readonly Point[]): void {
  const first = points[0];
  if (first === undefined) return;
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
}

/**
 * The land and the sea, one pixel to a cell of the terrain grid. A world is a
 * few hundred cells a side, so this is under a megabyte and is drawn scaled up;
 * the coastline is the one thing on the map a soft edge suits.
 */
function renderGround(world: WorldDescription): HTMLCanvasElement {
  const hf = world.terrain;
  const n = hf.gridSize;
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(n, n);
  const data = image.data;
  const sea = world.water.seaLevel;
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const h = hf.heights[iy * n + ix]!;
      const o = (iy * n + ix) * 4;
      if (h < sea) {
        // Deep water is darker, so a channel reads as a channel and the
        // shallows a boat can be launched into read as shallows.
        const t = Math.min(1, (sea - h) / DEPTH_RANGE);
        data[o] = mixByte(SHALLOWS_RGB[0], SEA_RGB[0], t);
        data[o + 1] = mixByte(SHALLOWS_RGB[1], SEA_RGB[1], t);
        data[o + 2] = mixByte(SHALLOWS_RGB[2], SEA_RGB[2], t);
      } else {
        // Land pales as it rises, so a ridge reads against the flats below it.
        const t = Math.min(1, (h - sea) / 120);
        data[o] = 54 + t * 66;
        data[o + 1] = 47 + t * 57;
        data[o + 2] = 56 + t * 54;
      }
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

const SEA_RGB: readonly [number, number, number] = [0x12, 0x30, 0x48];
const SHALLOWS_RGB: readonly [number, number, number] = [0x1b, 0x4a, 0x66];

function mixByte(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** The player, as an arrow pointing the way they face. Drawn last, over everything. */
function drawPlayer(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number): void {
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

/** A name under an icon. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.save();
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(246,214,193,.9)';
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 3;
  ctx.fillText(text, x, y + 3);
  ctx.restore();
}

export { TIER_COLOURS };
