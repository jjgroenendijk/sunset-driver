/**
 * The canvas half of the map of spec section 12: the one place that says what a
 * map looks like. `minimap.ts` and `map-screen.ts` both draw through it, so the
 * corner map and the full map cannot drift apart.
 *
 * `MapArt` is built once for a session and holds everything that does not
 * change: the land and sea as a bitmap the size of the terrain grid
 * (`map-ground.ts`), the beach sand, the tram loop and the road index of
 * `map.ts`. Drawing a frame is then a clipped blit and a few hundred stroked
 * segments, whatever the world's size.
 *
 * The roads are strokes rather than pixels of that bitmap, so the map is sharp
 * at every zoom: a minimap at half a metre to the pixel and a whole-world view
 * at sixteen read off the same lines. A road is drawn as a dark casing with its
 * colour inside, the way a printed road map draws one, so it reads against any
 * ground. The icons are drawn by `map-icons.ts`.
 */
import { fromLocal } from '../world/airfield-frame.ts';
import type { Airfield, AirfieldPart, Point, RoadTier, WorldDescription } from '../world/types.ts';
import { renderGround, DEEP_SEA } from './map-ground.ts';
import { drawMark, drawPlayer } from './map-icons.ts';
import type { MapRoute } from './map-route.ts';
import {
  POI_STYLES,
  RoadSegmentIndex,
  SEGMENT_STRIDE,
  tierPen,
  viewBounds,
  type MapBounds,
  type MapPois,
  type MapView,
} from './map.ts';

export { drawIcon } from './map-icons.ts';

/**
 * What each tier is drawn in. Widest first. The casings are stroked in this
 * order and the colours in the reverse, so a highway runs over the street that
 * joins it, the way it does on a road map.
 */
const TIER_COLOURS: readonly (readonly [RoadTier, string])[] = Object.freeze([
  ['highway', '#f2a452'] as const,
  ['arterial', '#e6c48c'] as const,
  ['street', '#b5a0aa'] as const,
  ['alley', '#8b7883'] as const,
  ['dirt', '#9a7b58'] as const,
]);

/** The dark edge along every road. */
const CASING = '#1c0f18';

/** Pixels of casing on each side of a road. */
const CASING_PX = 1;

/** A road narrower than this many pixels is drawn without a casing: it would be all edge. */
const CASED_PEN = 1.6;

/** The colours of everything that is not a road. */
const SAND = '#b39a66';
/** The paved ground of an airfield, and an airstrip's dirt runway (spec section 8.4). */
const TARMAC = '#6a6470';
const STRIP = '#8a7454';
const TRAM = '#e05ad0';
// The route is the one cool colour on a warm map, so it is never read as a road.
const ROUTE = '#48dcff';
const ROUTE_CASING = '#06222e';

/** A place is named beside its icon only at this many metres to the pixel or closer. */
const LABEL_SCALE = 2.5;

/** The tram line is drawn only at this many metres to the pixel or closer. */
const TRAM_SCALE = 6;

/** Pixels between two names, so one never runs into the next. */
const LABEL_GAP = 4;

/** What one map frame is asked to draw over the land. */
export interface MapDrawOptions {
  /**
   * Where the player stands and which way they face, or null where there is no
   * player yet: the seed preview of the title screen draws the map alone.
   */
  player: { x: number; y: number; heading: number } | null;
  /** The place the player has marked, or null. */
  waypoint: { x: number; y: number } | null;
  /**
   * The roads from the player to the waypoint (`map-route.ts`). Without one, a
   * waypoint is joined to the player by a dashed straight line.
   */
  route?: MapRoute | null;
  /** Pixels across an icon. A minimap draws them smaller than the full map. */
  iconSize: number;
  /**
   * True on the full map: district names are written across the map, and a
   * place's own name beside its icon once the map is close enough that the
   * names do not run into one another (see {@link LABEL_SCALE}).
   */
  labels: boolean;
  /** False to leave the tram line off, as the legend of the full map can. */
  tram?: boolean;
  /** True to draw a scale bar in the bottom left corner. */
  scaleBar?: boolean;
  /**
   * The territory overlay slot of spec section 12, for the factions of spec
   * section 17. It is called with the canvas already transformed into world
   * metres, so it draws in the world's own coordinates, over the land and under
   * the icons. `bounds` is the world box the canvas can show, which is what an
   * overlay over the whole map needs in order to draw only the part on screen.
   */
  overlay?: (ctx: CanvasRenderingContext2D, view: MapView, bounds: MapBounds) => void;
}

/** A box on screen a name takes up, so the next name can stay out of it. */
interface Taken {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class MapArt {
  readonly world: WorldDescription;
  readonly pois: MapPois;
  private readonly segments: RoadSegmentIndex;
  /** The land and the sea, one pixel to a terrain cell. Drawn scaled at any zoom. */
  private readonly ground: HTMLCanvasElement;
  /** The districts in the order their names are placed: the city before the country. */
  private readonly namingOrder: readonly number[];

  constructor(world: WorldDescription, pois: MapPois) {
    this.world = world;
    this.pois = pois;
    this.segments = new RoadSegmentIndex(world.roads, world.size);
    this.ground = renderGround(world);
    const rank = { core: 0, inner: 1, industrial: 2, suburban: 3, outskirts: 4, wilderness: 5 } as const;
    this.namingOrder = world.districts
      .map((_, i) => i)
      .sort((a, b) => {
        const da = world.districts[a]!;
        const db = world.districts[b]!;
        return rank[da.zone] - rank[db.zone] || a - b;
      });
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
    const px = view.metresPerPixel;

    ctx.save();
    // From here to the matching restore the canvas is in world metres, so
    // everything below is written in the same coordinates the world uses.
    ctx.translate(width / 2, height / 2);
    ctx.rotate(view.rotation);
    ctx.scale(1 / px, 1 / px);
    ctx.translate(-view.x, -view.y);

    ctx.fillStyle = DEEP_SEA;
    ctx.fillRect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.ground, -half, -half, world.size, world.size);

    this.fillBeaches(ctx, bounds);
    this.fillAirfields(ctx, bounds);
    this.strokeRoads(ctx, view, bounds);
    if (opts.tram !== false) this.strokeTram(ctx, px);

    opts.overlay?.(ctx, view, bounds);

    if (opts.waypoint && opts.player) drawRoute(ctx, px, opts.player, opts.waypoint, opts.route ?? null);

    ctx.restore();

    const { taken, placed } = this.drawIcons(ctx, view, width, height, bounds, opts);
    if (opts.labels) {
      // Names are placed after every icon, so a name never covers an icon, and
      // each only where it runs into no name placed before it. The districts go
      // first, the city before the country, since they are what a player reads
      // a map by.
      this.drawDistrictNames(ctx, view, width, height, bounds, taken);
      // A name under every icon is unreadable on a map pulled back far enough to
      // hold a district. Past that the shape and the colour carry the icon.
      if (px <= LABEL_SCALE) {
        for (const at of placed) label(ctx, at.name, at.x, at.y + opts.iconSize * 0.75, taken);
      }
    }
    if (opts.scaleBar) drawScaleBar(ctx, px, height);
  }

  /**
   * The sand of spec section 7.3. It is the one parcel type worth a colour of
   * its own at map scale: a resort is what a player steers toward.
   */
  private fillBeaches(ctx: CanvasRenderingContext2D, bounds: MapBounds): void {
    ctx.fillStyle = SAND;
    ctx.beginPath();
    for (const beach of this.world.beaches) {
      if (beach.sand.length < 3) continue;
      if (beach.sand[0]!.x < bounds.minX - 200 || beach.sand[0]!.x > bounds.maxX + 200) continue;
      if (beach.sand[0]!.y < bounds.minY - 200 || beach.sand[0]!.y > bounds.maxY + 200) continue;
      ring(ctx, beach.sand);
    }
    ctx.fill();
  }

  /** The runways, the taxiways and the aprons, so an airfield reads as one. */
  private fillAirfields(ctx: CanvasRenderingContext2D, bounds: MapBounds): void {
    for (const field of this.world.airfields) {
      if (Math.abs(field.x - (bounds.minX + bounds.maxX) / 2) > (bounds.maxX - bounds.minX) / 2 + field.halfU) continue;
      if (Math.abs(field.y - (bounds.minY + bounds.maxY) / 2) > (bounds.maxY - bounds.minY) / 2 + field.halfU) continue;
      for (const part of field.parts) {
        if (!PAVED.includes(part.kind)) continue;
        ctx.fillStyle = field.kind === 'airstrip' && part.kind === 'runway' ? STRIP : TARMAC;
        ctx.beginPath();
        ring(ctx, partCorners(field, part));
        ctx.fill();
      }
    }
  }

  /**
   * The tram of spec section 13.2, a thin dashed line down the arterials it
   * runs along. Pulled back past a district it is only clutter.
   */
  private strokeTram(ctx: CanvasRenderingContext2D, px: number): void {
    const route = this.world.tram.route;
    if (px > TRAM_SCALE || route.length <= 1) return;
    ctx.strokeStyle = TRAM;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([6 * px, 5 * px]);
    ctx.beginPath();
    polyline(ctx, route);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /**
   * The icons and the player's arrow. They are drawn in screen pixels, so they
   * stay the same size however far the map is pulled back and never turn with
   * a rotating map. Answers the room each one takes and where each icon's
   * name would go.
   */
  private drawIcons(
    ctx: CanvasRenderingContext2D,
    view: MapView,
    width: number,
    height: number,
    bounds: MapBounds,
    opts: MapDrawOptions,
  ): { taken: Taken[]; placed: { x: number; y: number; name: string }[] } {
    const taken: Taken[] = [];
    const marks = this.pois.visible(bounds, view.metresPerPixel);
    if (opts.waypoint) marks.push({ type: 'waypoint', x: opts.waypoint.x, y: opts.waypoint.y });
    const placed: { x: number; y: number; name: string }[] = [];
    for (const poi of marks) {
      const p = projectInto(view, width, height, poi.x, poi.y);
      const style = POI_STYLES[poi.type];
      drawMark(ctx, style, p.x, p.y, opts.iconSize);
      const r = opts.iconSize * 0.72;
      taken.push({ x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r });
      placed.push({ x: p.x, y: p.y, name: poi.name ?? style.label });
    }
    if (opts.player) {
      const me = projectInto(view, width, height, opts.player.x, opts.player.y);
      drawPlayer(ctx, me.x, me.y, opts.player.heading + view.rotation, opts.iconSize * 1.15);
      const r = opts.iconSize * 1.15;
      taken.push({ x0: me.x - r, y0: me.y - r, x1: me.x + r, y1: me.y + r });
    }
    return { taken, placed };
  }

  /**
   * Every tier the zoom shows. The casings first, widest first, then the
   * colours narrowest first, so a highway lies over the street it meets and
   * every road is outlined where it runs alone.
   */
  private strokeRoads(ctx: CanvasRenderingContext2D, view: MapView, bounds: MapBounds): void {
    const keys = this.segments.segmentsIn(bounds);
    const px = view.metresPerPixel;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [tier] of TIER_COLOURS) {
      const pen = tierPen(tier, px);
      if (pen < CASED_PEN) continue;
      ctx.strokeStyle = CASING;
      ctx.lineWidth = (pen + CASING_PX * 2) * px;
      this.strokeTier(ctx, tier, keys);
    }
    for (let i = TIER_COLOURS.length - 1; i >= 0; i--) {
      const [tier, colour] = TIER_COLOURS[i]!;
      const pen = tierPen(tier, px);
      if (pen === 0) continue;
      ctx.strokeStyle = colour;
      // A road drawn as a hairline is dimmed, so a pulled-back map is a web of
      // faint streets under bright highways rather than a smear of one colour.
      ctx.globalAlpha = pen < CASED_PEN ? 0.55 : 1;
      ctx.lineWidth = pen * px;
      this.strokeTier(ctx, tier, keys);
    }
    ctx.globalAlpha = 1;
  }

  private strokeTier(ctx: CanvasRenderingContext2D, tier: RoadTier, keys: Int32Array): void {
    const roads = this.world.roads;
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

  /** District names, at the site of each cell, each where no name is yet. */
  private drawDistrictNames(
    ctx: CanvasRenderingContext2D,
    view: MapView,
    width: number,
    height: number,
    bounds: MapBounds,
    taken: Taken[],
  ): void {
    ctx.save();
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.letterSpacing = '1.5px';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(18,7,15,.85)';
    ctx.fillStyle = 'rgba(250,224,204,.92)';
    for (const index of this.namingOrder) {
      const district = this.world.districts[index]!;
      if (district.x < bounds.minX || district.x > bounds.maxX) continue;
      if (district.y < bounds.minY || district.y > bounds.maxY) continue;
      const p = projectInto(view, width, height, district.x, district.y);
      const text = district.name.toUpperCase();
      const w = ctx.measureText(text).width;
      const box = { x0: p.x - w / 2, y0: p.y - 8, x1: p.x + w / 2, y1: p.y + 8 };
      if (overlaps(box, taken)) continue;
      taken.push(box);
      ctx.strokeText(text, p.x, p.y);
      ctx.fillText(text, p.x, p.y);
    }
    ctx.restore();
  }
}

/**
 * The way to the waypoint: along the roads where there is a route, bright and
 * outlined, with the walk to the road and from it dashed; a dashed straight
 * line where there is no route.
 */
function drawRoute(
  ctx: CanvasRenderingContext2D,
  px: number,
  player: Point,
  waypoint: Point,
  route: MapRoute | null,
): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const dashed = (points: readonly Point[]): void => {
    if (points.length < 2) return;
    ctx.strokeStyle = ROUTE;
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([5 * px, 5 * px]);
    ctx.beginPath();
    polyline(ctx, points);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  if (route === null) {
    dashed([player, waypoint]);
    return;
  }
  dashed(route.lead);
  dashed(route.tail);
  if (route.road.length < 2) return;
  ctx.beginPath();
  polyline(ctx, route.road);
  ctx.strokeStyle = ROUTE_CASING;
  ctx.lineWidth = 7 * px;
  ctx.stroke();
  ctx.strokeStyle = ROUTE;
  ctx.lineWidth = 4 * px;
  ctx.stroke();
}

/** A bar a round number of metres long, with its length written over it. */
function drawScaleBar(ctx: CanvasRenderingContext2D, px: number, height: number): void {
  const want = 120 * px;
  const magnitude = 10 ** Math.floor(Math.log10(want));
  const metres = [5, 2, 1].map((k) => k * magnitude).find((m) => m <= want) ?? magnitude;
  const w = metres / px;
  const x = 16;
  const y = height - 18;
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(18,7,15,.85)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(250,224,204,.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y - 4);
  ctx.stroke();
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(18,7,15,.85)';
  ctx.fillStyle = 'rgba(250,224,204,.95)';
  const text = distanceText(metres);
  ctx.strokeText(text, x + 4, y - 5);
  ctx.fillText(text, x + 4, y - 5);
  ctx.restore();
}

/** Metres as a player reads them: `350 m`, `1.2 km`. */
export function distanceText(metres: number): string {
  if (metres < 1000) return `${Math.round(metres / 10) * 10 || Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
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
/** The parts of an airfield the map paints. */
const PAVED: readonly AirfieldPart['kind'][] = ['runway', 'taxiway', 'apron', 'pad', 'forecourt', 'deck'];

/** The four corners of one part of an airfield, on the map. */
function partCorners(field: Airfield, part: AirfieldPart): Point[] {
  const { u, v, halfU, halfV } = part;
  return [fromLocal(field, u - halfU, v - halfV), fromLocal(field, u + halfU, v - halfV), fromLocal(field, u + halfU, v + halfV), fromLocal(field, u - halfU, v + halfV)];
}

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

function overlaps(box: Taken, taken: readonly Taken[]): boolean {
  for (const t of taken) {
    if (box.x0 - LABEL_GAP < t.x1 && box.x1 + LABEL_GAP > t.x0 && box.y0 < t.y1 && box.y1 > t.y0) return true;
  }
  return false;
}

/** A name under an icon, where it runs into nothing already placed. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, taken: Taken[]): void {
  ctx.save();
  ctx.font = '600 11px system-ui, sans-serif';
  const w = ctx.measureText(text).width;
  const box = { x0: x - w / 2, y0: y + 1, x1: x + w / 2, y1: y + 15 };
  if (overlaps(box, taken)) {
    ctx.restore();
    return;
  }
  taken.push(box);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(18,7,15,.85)';
  ctx.fillStyle = 'rgba(250,224,204,.95)';
  ctx.strokeText(text, x, y + 2);
  ctx.fillText(text, x, y + 2);
  ctx.restore();
}
