/**
 * What the ground is made of at a place, and where the nearest road is
 * (spec section 11.3). Both are what a driver needs to know about the ground.
 *
 * Driving reads this and nothing else about the ground it is on: the grip a
 * tyre finds on asphalt, on a dirt road, on sand and on open country differ,
 * and that difference is what makes a beach buggy worth having. The parcel
 * model (spec section 6.4) already gives every piece of ground exactly one
 * owner, so this is a read of that allocation rather than a second one: a road
 * claims the ground within `footprintHalfWidth` of its centreline, a beach
 * claims its sand, an airfield its paved parts and the ramp up to them (spec
 * section 8.4), and everything else is open ground. An airstrip's runway is
 * grass and dirt, so it drives as a dirt road does.
 *
 * It answers one place at a time and stores nothing per place, so the physics
 * may ask it for every wheel of every tick. The segments are filed in a bucket
 * grid the way `carve.ts` files them, which is what keeps that affordable.
 */
import { pointInRing } from '../core/geom.ts';
import { atan2, hypot } from '../core/libm.ts';
import { airfieldAt, airfieldRamp, toLocal } from './airfield-frame.ts';
import { RAMP_HALF } from './airfields.ts';
import { Heightfield } from './heightfield.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { Airfield, AirfieldPart, Point, RoadCurve, RoadTier, WorldDescription } from './types.ts';

/**
 * The ground a tyre is on. `ground` is everything the roads and the beaches
 * left: grass, scrub, dust and the yards behind the buildings.
 */
export type Surface = 'asphalt' | 'dirt' | 'sand' | 'ground';

/** Side of one bucket of the segment index, in metres. */
const INDEX_CELL = 48;

/** The parts of an airfield a tyre runs on as it would on a road. */
const PAVED: readonly AirfieldPart['kind'][] = ['runway', 'taxiway', 'apron', 'pad', 'forecourt'];

const local = { u: 0, v: 0 };

/** A beach's sand with the box around it, so a point outside is refused without walking the ring. */
interface SandPatch {
  ring: readonly Point[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The surface of a world, asked one place at a time.
 *
 * A road wins over sand where both reach a place, because the road claimed the
 * ground first: a boardwalk or an island link laid across a beach is driven on
 * as the road it is.
 */
export class SurfaceIndex {
  /** Segment ends, direction and the squared reach of each one. */
  private readonly ax: number[] = [];
  private readonly ay: number[] = [];
  private readonly vx: number[] = [];
  private readonly vy: number[] = [];
  /** One over the squared length, so the projection onto a segment is a multiply. */
  private readonly inv: number[] = [];
  private readonly half: number[] = [];
  private readonly paved: boolean[] = [];
  private readonly buckets: number[][] = [];
  private readonly sand: SandPatch[] = [];
  private readonly airfields: readonly Airfield[];
  private readonly ramps: SandPatch[] = [];
  private readonly columns: number;
  private readonly originX: number;
  private readonly originY: number;

  constructor(world: WorldDescription) {
    // The index covers the map with a margin, so a road beside the edge is
    // filed rather than folded onto the last column.
    const reach = world.size / 2 + 2 * INDEX_CELL;
    this.originX = -reach;
    this.originY = -reach;
    this.columns = Math.ceil((2 * reach) / INDEX_CELL);
    for (let i = 0; i < this.columns * this.columns; i++) this.buckets.push([]);
    for (const road of world.roads) this.file(road);
    for (const beach of world.beaches) {
      if (beach.sand.length >= 3) this.sand.push(boxed(beach.sand));
    }
    this.airfields = world.airfields;
    for (const field of world.airfields) {
      if (field.kind !== 'dock') this.ramps.push(boxed(airfieldRamp(field, RAMP_HALF)));
    }
  }

  /** What the ground is made of at a place. */
  at(x: number, y: number): Surface {
    const paved = this.roadAt(x, y);
    if (paved !== undefined) return paved ? 'asphalt' : 'dirt';
    const field = this.airfieldAt(x, y);
    if (field !== undefined) return field;
    for (const patch of this.sand) {
      if (inPatch(patch, x, y)) return 'sand';
    }
    return 'ground';
  }

  /** The surface an airfield lays at a place, or undefined where it lays none. */
  private airfieldAt(x: number, y: number): Surface | undefined {
    for (const ramp of this.ramps) if (inPatch(ramp, x, y)) return 'asphalt';
    const field = airfieldAt(this.airfields, x, y);
    if (field === undefined) return undefined;
    toLocal(field, x, y, local);
    for (const part of field.parts) {
      if (!PAVED.includes(part.kind)) continue;
      if (Math.abs(local.u - part.u) > part.halfU || Math.abs(local.v - part.v) > part.halfV) continue;
      return field.kind === 'airstrip' && part.kind === 'runway' ? 'dirt' : 'asphalt';
    }
    return undefined;
  }

  /** True where a paved road claims the place, false where a dirt road does, undefined off the roads. */
  private roadAt(x: number, y: number): boolean | undefined {
    const column = Math.floor((x - this.originX) / INDEX_CELL);
    const row = Math.floor((y - this.originY) / INDEX_CELL);
    if (column < 0 || row < 0 || column >= this.columns || row >= this.columns) return undefined;
    const bucket = this.buckets[row * this.columns + column];
    if (bucket === undefined) return undefined;
    let best: boolean | undefined;
    let bestDistance = Infinity;
    for (const i of bucket) {
      const half = this.half[i] as number;
      const distance = this.distanceTo(i, x, y);
      if (distance > half || distance >= bestDistance) continue;
      bestDistance = distance;
      best = this.paved[i] as boolean;
    }
    return best;
  }

  /** Distance from a place to the centreline of one segment. */
  private distanceTo(i: number, x: number, y: number): number {
    const dx = x - (this.ax[i] as number);
    const dy = y - (this.ay[i] as number);
    const vx = this.vx[i] as number;
    const vy = this.vy[i] as number;
    const t = Math.max(0, Math.min(1, (dx * vx + dy * vy) * (this.inv[i] as number)));
    const ox = dx - vx * t;
    const oy = dy - vy * t;
    return hypot(ox, oy);
  }

  /** File every segment of one road in each bucket the box around it touches. */
  private file(road: RoadCurve): void {
    const half = footprintHalfWidth(road.tier);
    const paved = road.tier !== 'dirt';
    for (let i = 0; i + 1 < road.points.length; i++) {
      const a = road.points[i] as Point;
      const b = road.points[i + 1] as Point;
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const length2 = vx * vx + vy * vy;
      if (length2 === 0) continue;
      const at = this.ax.length;
      this.ax.push(a.x);
      this.ay.push(a.y);
      this.vx.push(vx);
      this.vy.push(vy);
      this.inv.push(1 / length2);
      this.half.push(half);
      this.paved.push(paved);
      const minColumn = this.cell(Math.min(a.x, b.x) - half - this.originX);
      const maxColumn = this.cell(Math.max(a.x, b.x) + half - this.originX);
      const minRow = this.cell(Math.min(a.y, b.y) - half - this.originY);
      const maxRow = this.cell(Math.max(a.y, b.y) + half - this.originY);
      for (let row = minRow; row <= maxRow; row++) {
        for (let column = minColumn; column <= maxColumn; column++) {
          this.buckets[row * this.columns + column]?.push(at);
        }
      }
    }
  }

  /** A coordinate measured from the index origin, as a bucket index inside the grid. */
  private cell(offset: number): number {
    return Math.max(0, Math.min(this.columns - 1, Math.floor(offset / INDEX_CELL)));
  }
}

/** A place on a road, and the way the road runs there. */
export interface RoadPlace {
  x: number;
  y: number;
  /** Radians, along the road in the direction the curve was traced. */
  heading: number;
}

/** The same place, with the tier of the road it stands on. */
export interface RoadSpot extends RoadPlace {
  tier: RoadTier;
}

/**
 * The nearest place a car can stand on a road, or undefined where the world has
 * none. This is where a session starts and where a respawn will put a car
 * (spec section 11.7).
 *
 * Highways are skipped, because a driver should not begin on one, and so are
 * the segments on a deck or in a bore: the physics carries a deck (`decks.ts`)
 * but a session should not start halfway over a bridge, and a bore is inside a
 * hill. One pass over the curves at the start of a session.
 */
export function nearestRoadPlace(world: WorldDescription, x: number, y: number): RoadPlace | undefined {
  return nearestRoadSpot(world, x, y);
}

/**
 * The same answer with the tier of the road it found. Whoever stands something
 * beside the road rather than on it needs the tier, because how far the
 * carriageway, the verge and the pavement reach is a fact about the tier
 * ({@link footprintHalfWidth}). The metro entrances of spec section 13.3 stand
 * that way, and they take `accept` to ask for a road with a pavement to stand
 * on: a tier that has none claims no ground beside its carriageway.
 */
export function nearestRoadSpot(
  world: WorldDescription,
  x: number,
  y: number,
  accept?: (tier: RoadTier) => boolean,
): RoadSpot | undefined {
  let best: RoadSpot | undefined;
  let bestDistance = Infinity;
  for (const road of world.roads) {
    if (road.tier === 'highway') continue;
    if (accept !== undefined && !accept(road.tier)) continue;
    const found = nearestOnRoad(road, x, y, bestDistance);
    if (found === undefined) continue;
    bestDistance = found.distance;
    best = found.spot;
  }
  return best;
}

/** The place on the ground of one road nearest a point, where it is nearer than `within` metres. */
function nearestOnRoad(road: RoadCurve, x: number, y: number, within: number): { spot: RoadSpot; distance: number } | undefined {
  let best: RoadSpot | undefined;
  let bestDistance = within;
  for (let i = 0; i + 1 < road.points.length; i++) {
    if (road.bridges.includes(i) || road.tunnels.includes(i)) continue;
    const a = road.points[i] as Point;
    const b = road.points[i + 1] as Point;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const length2 = vx * vx + vy * vy;
    if (length2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / length2));
    const px = a.x + vx * t;
    const py = a.y + vy * t;
    const distance = hypot(px - x, py - y);
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = { x: px, y: py, heading: atan2(vy, vx), tier: road.tier };
  }
  return best === undefined ? undefined : { spot: best, distance: bestDistance };
}

/** Metres of water a boat needs under it, and of open water around it, to be put down. */
const BOAT_DEPTH = 2;
const BOAT_CLEARANCE = 12;

/**
 * The nearest open water a boat can be put down on, or undefined where the
 * world has none. This is where the debug picker of spec section 11.3 puts a
 * boat, since a boat on a street is not a boat that can be driven.
 *
 * Open water is a place with {@link BOAT_DEPTH} metres under it and as much
 * again {@link BOAT_CLEARANCE} metres away on all four sides, so the boat lands
 * in the sea or the river rather than in a puddle it cannot leave. It heads
 * toward the deepest of those four, which is away from the shore it was put
 * down beside.
 *
 * One pass over the terrain grid. The nearest place found so far bounds the
 * search, so most cells are refused on a distance before the ground is sampled.
 */
export function nearestWaterPlace(world: WorldDescription, x: number, y: number): RoadPlace | undefined {
  const field = new Heightfield(world.terrain);
  const sea = world.water.seaLevel;
  let best: RoadPlace | undefined;
  let bestDistance = Infinity;
  for (let iy = 0; iy < field.gridSize; iy++) {
    const py = field.originY + iy * field.cellSize;
    for (let ix = 0; ix < field.gridSize; ix++) {
      const px = field.originX + ix * field.cellSize;
      const distance = hypot(px - x, py - y);
      if (distance >= bestDistance) continue;
      if (sea - field.at(ix, iy) < BOAT_DEPTH) continue;
      const east = sea - field.sample(px + BOAT_CLEARANCE, py);
      const west = sea - field.sample(px - BOAT_CLEARANCE, py);
      const north = sea - field.sample(px, py + BOAT_CLEARANCE);
      const south = sea - field.sample(px, py - BOAT_CLEARANCE);
      if (Math.min(east, west, north, south) < BOAT_DEPTH) continue;
      bestDistance = distance;
      // Head for the deepest water within reach, which is away from the shore.
      best = { x: px, y: py, heading: atan2(north - south, east - west) };
    }
  }
  return best;
}

/** True where a place is inside a ring, tried against its box first. */
function inPatch(patch: SandPatch, x: number, y: number): boolean {
  if (x < patch.minX || x > patch.maxX || y < patch.minY || y > patch.maxY) return false;
  return pointInRing({ x, y }, patch.ring);
}

function boxed(ring: readonly Point[]): SandPatch {
  const patch: SandPatch = { ring, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of ring) {
    patch.minX = Math.min(patch.minX, p.x);
    patch.minY = Math.min(patch.minY, p.y);
    patch.maxX = Math.max(patch.maxX, p.x);
    patch.maxY = Math.max(patch.maxY, p.y);
  }
  return patch;
}
