/**
 * The map model of spec section 12: what the minimap and the full map draw,
 * and where on screen each thing lands.
 *
 * Everything here is pure, so the projection, the icon table and the culling
 * are tested headless. `map-draw.ts` is the canvas half, and `minimap.ts` and
 * `map-screen.ts` are the two widgets that read both.
 *
 * The map keeps the world's own axes: a point at world `(x, y)` is drawn at
 * pixel `(x, y)`, so north is up the screen and the map reads the way
 * `scripts/world-preview.ts` draws the same world. The player walks toward
 * `-y`, which is up the screen, so a fixed-north map already has their usual
 * heading pointing up.
 */
import type { ShopKind } from '../world/shops.ts';
import type { Point, RoadCurve, RoadTier, WorldDescription } from '../world/types.ts';

/**
 * Every kind of place the map marks (spec section 12). The world description
 * carries the transport and the seafront ones today, so `collectPois` places
 * those; the rest are the slots the systems that own them fill in through
 * {@link MapPois.extra} as they land — the shops of spec section 16.1, the
 * safehouses of 16.3, the factions of 17 and the missions of 18.
 */
export type PoiType =
  | 'player'
  | 'waypoint'
  | 'objective'
  | 'tram-stop'
  | 'metro-station'
  | 'pier'
  | 'car-park'
  | 'harbour'
  | 'safehouse'
  | 'garage'
  | 'clinic'
  | 'police'
  | 'mission-giver'
  | 'dealer'
  | 'gun-shop'
  | 'clothes-shop'
  | 'food-shop'
  | 'broker';

/** The shapes an icon is drawn as. No two POI types share one (see `POI_STYLES`). */
export type IconShape =
  | 'arrow'
  | 'pin'
  | 'star'
  | 'disc'
  | 'square'
  | 'diamond'
  | 'triangle'
  | 'chevron'
  | 'house'
  | 'cross'
  | 'shield'
  | 'flag'
  | 'ring'
  | 'bars'
  | 'hexagon'
  | 'cup'
  | 'roundel'
  | 'key';

/** How one kind of place is drawn, and what the full map calls it. */
export interface PoiStyle {
  shape: IconShape;
  colour: string;
  label: string;
  /**
   * Below this many metres to the pixel the icon is drawn, and above it the
   * place is too small to matter. A landmark carries `Infinity`, so it is on
   * the map at every zoom: the player, their waypoint and objective, the
   * harbour and the safehouses they respawn at.
   */
  maxScale: number;
}

/**
 * The icon table. Each type has its own shape, so the map is readable without
 * colour, and its own colour, so it is readable at the size a minimap draws.
 * `test/map.test.ts` pins that no two types share either.
 */
export const POI_STYLES: Readonly<Record<PoiType, PoiStyle>> = Object.freeze({
  player: { shape: 'arrow', colour: '#ffffff', label: 'You', maxScale: Infinity },
  waypoint: { shape: 'pin', colour: '#ff8a5c', label: 'Waypoint', maxScale: Infinity },
  objective: { shape: 'star', colour: '#ffd166', label: 'Objective', maxScale: Infinity },
  'tram-stop': { shape: 'disc', colour: '#e05ad0', label: 'Tram stop', maxScale: 6 },
  // A station is a landmark: a player who has visited one travels to it from
  // across the map (spec section 13.3), so it is on the map at every zoom.
  'metro-station': { shape: 'roundel', colour: '#5ad08a', label: 'Metro', maxScale: Infinity },
  pier: { shape: 'bars', colour: '#c08a5a', label: 'Pier', maxScale: 8 },
  'car-park': { shape: 'square', colour: '#9a8ad0', label: 'Car park', maxScale: 4 },
  harbour: { shape: 'hexagon', colour: '#5ab0d0', label: 'Harbour', maxScale: Infinity },
  safehouse: { shape: 'house', colour: '#7ad07a', label: 'Safehouse', maxScale: Infinity },
  garage: { shape: 'chevron', colour: '#8ac0a0', label: 'Garage', maxScale: 6 },
  clinic: { shape: 'cross', colour: '#ff7a8a', label: 'Clinic', maxScale: 8 },
  police: { shape: 'shield', colour: '#5a7ad0', label: 'Police', maxScale: 8 },
  'mission-giver': { shape: 'flag', colour: '#ffb03a', label: 'Contact', maxScale: 8 },
  dealer: { shape: 'diamond', colour: '#b06ad0', label: 'Dealer', maxScale: 4 },
  'gun-shop': { shape: 'triangle', colour: '#d05a5a', label: 'Gun shop', maxScale: 4 },
  'clothes-shop': { shape: 'ring', colour: '#d0c05a', label: 'Clothes', maxScale: 4 },
  'food-shop': { shape: 'cup', colour: '#7ad0c0', label: 'Food', maxScale: 4 },
  broker: { shape: 'key', colour: '#c0a0e0', label: 'Property broker', maxScale: 6 },
});

/**
 * The icon each trade of spec section 16.1 is marked with. A workshop is the
 * garage mark and a clinic the clinic mark, because that is what they are; the
 * broker has its own. Whoever owns the shops writes these into
 * {@link MapPois.extra}.
 */
export const SHOP_POIS: Readonly<Record<ShopKind, PoiType>> = Object.freeze({
  weapons: 'gun-shop',
  workshop: 'garage',
  convenience: 'food-shop',
  clothing: 'clothes-shop',
  clinic: 'clinic',
  broker: 'broker',
});

/** One marked place on the map. */
export interface MapPoi {
  type: PoiType;
  x: number;
  y: number;
  /** What the full map writes beside the icon; the style's label when empty. */
  name?: string;
}

/**
 * Where the map is looking: the world point at the middle of the canvas, how
 * many metres one pixel covers, and how far the world is turned on screen.
 *
 * `rotation` is 0 for a fixed-north map. A rotating map takes
 * {@link rotationForHeading}, which turns the player's facing up the screen.
 */
export interface MapView {
  x: number;
  y: number;
  metresPerPixel: number;
  rotation: number;
}

/** A point in canvas pixels. */
export interface Pixel {
  x: number;
  y: number;
}

/**
 * The rotation that puts a heading up the screen. The player's forward is
 * `(cos h, sin h)` in the world, and up the screen is `(0, -1)`, so the world
 * is turned by `-pi/2 - h`.
 */
export function rotationForHeading(heading: number): number {
  return -Math.PI / 2 - heading;
}

/** Where a world point lands on a canvas of `width` by `height` pixels. */
export function project(view: MapView, width: number, height: number, x: number, y: number): Pixel {
  const dx = x - view.x;
  const dy = y - view.y;
  const c = Math.cos(view.rotation);
  const s = Math.sin(view.rotation);
  return {
    x: width / 2 + (dx * c - dy * s) / view.metresPerPixel,
    y: height / 2 + (dx * s + dy * c) / view.metresPerPixel,
  };
}

/** The world point under a canvas pixel: the inverse of {@link project}. */
export function unproject(view: MapView, width: number, height: number, px: number, py: number): Pixel {
  const rx = (px - width / 2) * view.metresPerPixel;
  const ry = (py - height / 2) * view.metresPerPixel;
  const c = Math.cos(view.rotation);
  const s = Math.sin(view.rotation);
  return { x: view.x + rx * c + ry * s, y: view.y - rx * s + ry * c };
}

/**
 * Metres from the middle of the canvas to its furthest corner. Whatever the
 * rotation, nothing further away than this is on screen, so it is what culls
 * the roads and the icons.
 */
export function viewRadius(view: MapView, width: number, height: number): number {
  return (Math.hypot(width, height) / 2) * view.metresPerPixel;
}

/**
 * The view that holds a whole `size`-metre world on a canvas of `width` by
 * `height` pixels, north up and centred on the origin the world is built
 * around. The smaller side of the canvas decides the scale, so nothing of the
 * map is cut off.
 */
export function fitWorldView(size: number, width: number, height: number): MapView {
  return { x: 0, y: 0, metresPerPixel: size / Math.max(1, Math.min(width, height)), rotation: 0 };
}

/** The world box the canvas can show, however the view is turned. */
export interface MapBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function viewBounds(view: MapView, width: number, height: number): MapBounds {
  const r = viewRadius(view, width, height);
  return { minX: view.x - r, minY: view.y - r, maxX: view.x + r, maxY: view.y + r };
}

/**
 * The zoom steps of the full map, closest first. A step is metres to the pixel:
 * the closest shows a single junction and the furthest a whole 6 km world on a
 * 1000-pixel canvas.
 */
export const ZOOM_STEPS: readonly number[] = Object.freeze([0.5, 1, 2, 4, 8, 16]);

/** The step `steps` along from `metresPerPixel`, clamped to the ends of the table. */
export function zoomBy(metresPerPixel: number, steps: number): number {
  let nearest = 0;
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    const here = ZOOM_STEPS[i] as number;
    if (Math.abs(here - metresPerPixel) < Math.abs((ZOOM_STEPS[nearest] as number) - metresPerPixel)) nearest = i;
  }
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, nearest + steps));
  return ZOOM_STEPS[next] as number;
}

/**
 * How wide a tier is drawn, in pixels, and whether it is drawn at all. A road
 * is stroked at its real width so the core reads as the dense place it is, but
 * never thinner than a hairline, or a street disappears as soon as the map is
 * pulled back. A tier drops out entirely once its real width is well under a
 * pixel, which is what keeps a whole-world view from being a grey smear.
 */
export function tierPen(tier: RoadTier, metresPerPixel: number): number {
  const width = TIER_MAP_WIDTH[tier];
  if (width / metresPerPixel < TIER_MIN_VISIBLE) return 0;
  return Math.max(TIER_HAIRLINE, width / metresPerPixel);
}

/** Metres each tier is drawn at on the map: its carriageway, not its footprint. */
const TIER_MAP_WIDTH: Readonly<Record<RoadTier, number>> = Object.freeze({
  highway: 22,
  arterial: 14,
  street: 9,
  alley: 5,
  dirt: 5,
});

/** Thinnest a road is ever stroked, in pixels. */
const TIER_HAIRLINE = 0.9;

/** A tier narrower than this many pixels in truth is left off the map. */
const TIER_MIN_VISIBLE = 0.35;

/**
 * Every road segment of a world, filed by where it is, so a view asks only for
 * the ones it can show. A whole world holds tens of thousands of segments and a
 * minimap shows a few hundred, so the minimap walks a few hundred.
 *
 * A segment is filed in every cell the box around it touches. Roads are traced
 * in short steps, so a segment spans one or two cells and the index stays small.
 */
export class RoadSegmentIndex {
  private readonly cells: Int32Array[];
  private readonly cols: number;
  private readonly rows: number;
  private readonly minX: number;
  private readonly minY: number;
  private readonly cell: number;

  constructor(roads: readonly RoadCurve[], size: number, cell = 200) {
    this.cell = cell;
    this.minX = -size / 2;
    this.minY = -size / 2;
    this.cols = Math.max(1, Math.ceil(size / cell));
    this.rows = this.cols;
    const lists: number[][] = [];
    for (let i = 0; i < this.cols * this.rows; i++) lists.push([]);
    for (let r = 0; r < roads.length; r++) {
      const points = (roads[r] as RoadCurve).points;
      for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i] as Point;
        const b = points[i + 1] as Point;
        const c0 = this.col(Math.min(a.x, b.x));
        const c1 = this.col(Math.max(a.x, b.x));
        const r0 = this.row(Math.min(a.y, b.y));
        const r1 = this.row(Math.max(a.y, b.y));
        // Two numbers packed into one: the curve and the point it starts at.
        const key = r * SEGMENT_STRIDE + i;
        for (let row = r0; row <= r1; row++) {
          for (let col = c0; col <= c1; col++) (lists[row * this.cols + col] as number[]).push(key);
        }
      }
    }
    this.cells = lists.map((list) => Int32Array.from(list));
  }

  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
  }

  private row(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
  }

  /**
   * The segments whose cells meet `bounds`, each as a curve index and the point
   * it runs from. Ascending and without repeats, so the roads are drawn in the
   * order they were traced however the cells were walked.
   */
  segmentsIn(bounds: MapBounds): Int32Array {
    const c0 = this.col(bounds.minX);
    const c1 = this.col(bounds.maxX);
    const r0 = this.row(bounds.minY);
    const r1 = this.row(bounds.maxY);
    let total = 0;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) total += (this.cells[row * this.cols + col] as Int32Array).length;
    }
    const out = new Int32Array(total);
    let n = 0;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const list = this.cells[row * this.cols + col] as Int32Array;
        out.set(list, n);
        n += list.length;
      }
    }
    out.sort();
    let write = 0;
    for (let i = 0; i < out.length; i++) {
      if (i > 0 && out[i] === out[i - 1]) continue;
      out[write++] = out[i] as number;
    }
    return out.subarray(0, write);
  }
}

/** How a packed segment key splits back into a curve and a point index. */
export const SEGMENT_STRIDE = 1 << 16;

/**
 * The places the world description already knows about (spec section 12): the
 * tram stops of section 13.2, the piers and beach car parks of section 7.3 and
 * the harbour. Everything else the spec lists belongs to a system that has not
 * landed; those reach the map through {@link MapPois.extra}.
 *
 * The order is the order the world lists them, so two runs of one seed mark the
 * same places in the same order.
 */
export function collectPois(world: WorldDescription): MapPoi[] {
  const out: MapPoi[] = [];
  const named = (id: number): string | undefined => world.districts[id]?.name;
  out.push({ type: 'harbour', x: world.water.harbour.x, y: world.water.harbour.y });
  for (const stop of world.tram.stops) {
    // Named for the district it serves, with what it is in front, so the label
    // is not mistaken for the district name the map already writes across it.
    const district = named(stop.district);
    out.push({ type: 'tram-stop', x: stop.x, y: stop.y, ...(district ? { name: `Tram · ${district}` } : {}) });
  }
  for (const beach of world.beaches) {
    if (beach.pier) out.push({ type: 'pier', x: beach.pier.head.x, y: beach.pier.head.y });
    for (const park of beach.carParks) {
      const c = centroid(park);
      out.push({ type: 'car-park', x: c.x, y: c.y });
    }
  }
  return out;
}

/** The middle of a ring, as the average of its corners. Good enough to hang an icon on. */
function centroid(ring: readonly { x: number; y: number }[]): Pixel {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: x / ring.length, y: y / ring.length };
}

/**
 * The places a map draws: the ones the world carries, plus whatever a system
 * that owns places has added. This is the slot the shops, the safehouses and
 * the mission givers fill; nothing reads a second list.
 */
export class MapPois {
  /** Places the world description carries. Fixed for the life of a session. */
  readonly fixed: readonly MapPoi[];
  /** Places a later system adds. Replace the array to change what is marked. */
  extra: readonly MapPoi[] = [];

  constructor(world: WorldDescription) {
    this.fixed = collectPois(world);
  }

  /**
   * The places inside `bounds` whose type is worth drawing at this zoom, fixed
   * ones first. A type past its `maxScale` is left out, so a whole-world view
   * shows the harbour and not every car park.
   */
  visible(bounds: MapBounds, metresPerPixel: number): MapPoi[] {
    const out: MapPoi[] = [];
    for (const list of [this.fixed, this.extra]) {
      for (const poi of list) {
        if (metresPerPixel > POI_STYLES[poi.type].maxScale) continue;
        if (poi.x < bounds.minX || poi.x > bounds.maxX) continue;
        if (poi.y < bounds.minY || poi.y > bounds.maxY) continue;
        out.push(poi);
      }
    }
    return out;
  }
}
