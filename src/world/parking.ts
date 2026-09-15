/**
 * The parking bays of spec section 13.1: where a parked car may stand.
 *
 * A street carries a parking strip inside each kerb (`TierSpec.parking`), and a
 * bay is a length of that strip. A bay stands back from every junction, off
 * every bridge and tunnel, and off a bend too sharp for a straight bay. It is
 * placed only where it stays clear of the ground every other road claims, so a
 * bay never stands on another road's carriageway. A car park parcel is laid
 * out in rows of bays with an aisle between each two rows, inside the planted
 * rim `vegetation.ts` keeps along its edge.
 *
 * This is layout, not life: which bays hold a car at a tick is
 * `src/sim/parked.ts`. The bays are plain arrays, one entry per bay, so a chunk
 * worker can hand them to the main thread whole.
 */
import { ringArea, type Point, type Region } from '../core/geom.ts';
import { layoutZones, zoneAt } from './districts.ts';
import type { RoadCarve } from './carve.ts';
import type { JunctionMap } from './junctions.ts';
import { insideRegion, ringsClash } from './lot-geom.ts';
import type { Parcel, ParcelMap } from './parcels.ts';
import { footprintHalfWidth, TIERS } from './tiers.ts';
import type { RoadCurve, RoadTier, WorldDescription, Zone } from './types.ts';
import { STREET_REACH } from './vegetation.ts';

/** What the ground round a bay is used for, which is what says when its cars come and go. */
export type BayUse = 'home' | 'town' | 'work' | 'shops' | 'leisure';

/** Every use, in the order {@link ParkingBays.use} indexes them. Append; never reorder. */
export const BAY_USES: readonly BayUse[] = ['home', 'town', 'work', 'shops', 'leisure'];

/** The bays of a world, one entry per bay in each array. */
export interface ParkingBays {
  count: number;
  /** The middle of the bay on the map. */
  x: Float64Array;
  y: Float64Array;
  /** The carved ground under the middle of the bay. */
  height: Float32Array;
  /** The way a car in the bay faces. */
  heading: Float32Array;
  /** Index into {@link BAY_USES}. */
  use: Uint8Array;
  /** 1 for a bay along a street, 0 for a bay in a car park. */
  street: Uint8Array;
}

/** Metres along the kerb one street bay takes: a car and the room to pull out of it. */
export const STREET_BAY_LENGTH = 6;
/** Metres deep and wide one car park bay is. */
export const LOT_BAY_LENGTH = 5.4;
export const LOT_BAY_WIDTH = 2.6;
/** Metres of aisle between two rows of car park bays. */
const AISLE = 6;
/** Metres a street bay stands back from the ground a junction covers, and from a deck or a bore. */
const SETBACK = 5;
/** Radians a street may turn over one bay before the bay would stand off its strip. */
const MAX_BEND = 0.1;
/** Metres along its own curve past which a street's other stretches count as other roads. */
const OWN_REACH = 3 * STREET_BAY_LENGTH;
/**
 * Metres a bay may lie over its own street's lane and still count as beside
 * it: the rounding of a bay whose edge is the lane's edge.
 */
export const BAY_SHARE = 0.01;
/** Metres each way of one bucket of the segment grid. */
const CELL = 50;

/** The long half and the short half of a bay. */
export function baySize(bays: ParkingBays, bay: number): { halfLength: number; halfWidth: number } {
  if (bays.street[bay] === 1) return { halfLength: STREET_BAY_LENGTH / 2, halfWidth: TIERS.street.parking / 2 };
  return { halfLength: LOT_BAY_LENGTH / 2, halfWidth: LOT_BAY_WIDTH / 2 };
}

/** The ground a bay covers, as a ring wound anticlockwise. */
export function bayRing(bays: ParkingBays, bay: number): Point[] {
  const size = baySize(bays, bay);
  const heading = bays.heading[bay] as number;
  return rectangle(bays.x[bay] as number, bays.y[bay] as number, Math.cos(heading), Math.sin(heading), size.halfLength, size.halfWidth);
}

/** A bay before it is packed: where it stands, the way it faces and what it is for. */
interface Bay {
  x: number;
  y: number;
  heading: number;
  use: BayUse;
  street: boolean;
}

/**
 * Lay out every bay of a world. The junctions say where a street is cut back,
 * the parcels which ground is a car park, and the carve how high each bay
 * stands.
 */
export function buildParkingBays(world: WorldDescription, junctions: JunctionMap, parcels: ParcelMap, carve: RoadCarve): ParkingBays {
  const zones = layoutZones(world.size, world.core, world.water);
  return layBays(world.roads, junctions, parcels.parcels, (x, y) => zoneAt(zones, x, y), (x, y) => carve.heightAt(x, y));
}

/** Lay out the bays of a road network and its parcels, given the zone and the ground height at a place. */
export function layBays(
  roads: readonly RoadCurve[],
  junctions: JunctionMap,
  parcels: readonly Parcel[],
  zoneOf: (x: number, y: number) => Zone,
  heightAt: (x: number, y: number) => number,
): ParkingBays {
  const grid = new SegmentGrid(roads);
  const out: Bay[] = [];
  for (const road of roads) {
    if (road.tier === 'street') streetBays(road, junctions, grid, (x, y) => STREET_USE[zoneOf(x, y)], out);
  }
  const lots: Bay[] = [];
  for (const parcel of parcels) {
    if (parcel.owner === 'car-park') lotBays(parcel.region, LOT_USE[parcel.zone], lots);
  }
  // A car park is land the roads left, but a deck another corridor cut short
  // can leave the ground under its ramp to one. No bay stands under a road.
  const none = new Float64Array(0);
  for (const bay of lots) {
    const ring = rectangle(bay.x, bay.y, Math.cos(bay.heading), Math.sin(bay.heading), LOT_BAY_LENGTH / 2, LOT_BAY_WIDTH / 2);
    if (grid.clear(ring, -1, none, 0)) out.push(bay);
  }
  const bays: ParkingBays = {
    count: out.length,
    x: new Float64Array(out.length),
    y: new Float64Array(out.length),
    height: new Float32Array(out.length),
    heading: new Float32Array(out.length),
    use: new Uint8Array(out.length),
    street: new Uint8Array(out.length),
  };
  out.forEach((bay, i) => {
    bays.x[i] = bay.x;
    bays.y[i] = bay.y;
    bays.height[i] = heightAt(bay.x, bay.y);
    bays.heading[i] = bay.heading;
    bays.use[i] = BAY_USES.indexOf(bay.use);
    bays.street[i] = bay.street ? 1 : 0;
  });
  return bays;
}

/** What a street's bays are for, by the zone it runs through. */
const STREET_USE: Record<Zone, BayUse> = {
  core: 'town',
  inner: 'town',
  industrial: 'work',
  suburban: 'home',
  outskirts: 'home',
  wilderness: 'home',
};

/** What a car park is for, by its zone: a supermarket in town, a yard at the works, a trailhead out of it. */
const LOT_USE: Record<Zone, BayUse> = {
  core: 'shops',
  inner: 'shops',
  industrial: 'work',
  suburban: 'shops',
  outskirts: 'leisure',
  wilderness: 'leisure',
};

/** The bays along both kerbs of one street. */
function streetBays(road: RoadCurve, junctions: JunctionMap, grid: SegmentGrid, useAt: (x: number, y: number) => BayUse, out: Bay[]): void {
  const points = road.points;
  const along = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    along[i] = (along[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y);
  }
  const total = along[points.length - 1] as number;
  // The stretches no bay may reach: the ends, the junctions, the decks and the bores.
  const blocked: [number, number][] = [
    [-Infinity, SETBACK],
    [total - SETBACK, Infinity],
  ];
  for (const gap of junctions.gaps[road.id] ?? []) blocked.push([gap.from.distance - SETBACK, gap.to.distance + SETBACK]);
  for (const i of [...road.bridges, ...road.tunnels]) blocked.push([(along[i] as number) - SETBACK, (along[i + 1] as number) + SETBACK]);
  blocked.sort((a, b) => a[0] - b[0]);

  const inset = TIERS.street.width / 2 - TIERS.street.parking / 2;
  // The last bay laid along each kerb.
  let right: Point[] | undefined;
  let left: Point[] | undefined;
  let from = -Infinity;
  for (const [start, end] of blocked) {
    const room = start - from;
    const count = Math.floor(room / STREET_BAY_LENGTH);
    if (from > -Infinity && count > 0) {
      const first = from + (room - count * STREET_BAY_LENGTH) / 2;
      const middle = pointAt(points, along, (from + start) / 2);
      const use = useAt(middle.x, middle.y);
      for (let j = 0; j < count; j++) {
        const s = first + (j + 0.5) * STREET_BAY_LENGTH;
        const back = pointAt(points, along, s - STREET_BAY_LENGTH / 2);
        const ahead = pointAt(points, along, s + STREET_BAY_LENGTH / 2);
        const centre = pointAt(points, along, s);
        if (bendOver(points, along, s - STREET_BAY_LENGTH / 2, s + STREET_BAY_LENGTH / 2) > MAX_BEND) continue;
        const length = Math.hypot(ahead.x - back.x, ahead.y - back.y);
        const tx = (ahead.x - back.x) / length;
        const ty = (ahead.y - back.y) / length;
        const heading = Math.atan2(ty, tx);
        // The right hand of the curve's direction first, where its traffic drives
        // that way, then the left, where a car faces the other way.
        for (const side of [1, -1] as const) {
          const bay: Bay = {
            x: centre.x - side * ty * inset,
            y: centre.y + side * tx * inset,
            heading: side > 0 ? heading : heading + Math.PI,
            use,
            street: true,
          };
          const ring = rectangle(bay.x, bay.y, tx, ty, STREET_BAY_LENGTH / 2, TIERS.street.parking / 2);
          // On a bend two neighbours meet at the corners inside it, so the later one gives way.
          const before = side > 0 ? right : left;
          if (before !== undefined && ringsClash(ring, before, -BAY_SHARE)) continue;
          if (!grid.clear(ring, road.id, along, s)) continue;
          out.push(bay);
          if (side > 0) right = ring;
          else left = ring;
        }
      }
    }
    from = Math.max(from, end);
  }
}

/** The rows of bays of one car park, laid along its longest side. */
function lotBays(region: Region, use: BayUse, out: Bay[]): void {
  const ring = region.outer;
  let ux = 1;
  let uy = 0;
  let longest = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    if (span <= longest) continue;
    longest = span;
    ux = (b.x - a.x) / span;
    uy = (b.y - a.y) / span;
  }
  // The frame of the rows: `u` along them, `v` across.
  const vx = -uy;
  const vy = ux;
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of ring) {
    const u = p.x * ux + p.y * uy;
    const v = p.x * vx + p.y * vy;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  // A pair of rows faces one aisle between them, and the next pair backs onto it.
  const pair = 2 * LOT_BAY_LENGTH + AISLE;
  const heading = Math.atan2(vy, vx);
  for (let v0 = minV + STREET_REACH; v0 + pair <= maxV - STREET_REACH; v0 += pair) {
    for (const [v, facing] of [
      [v0 + LOT_BAY_LENGTH / 2, heading],
      [v0 + pair - LOT_BAY_LENGTH / 2, heading + Math.PI],
    ] as const) {
      for (let u = minU + STREET_REACH + LOT_BAY_WIDTH / 2; u + LOT_BAY_WIDTH / 2 <= maxU - STREET_REACH; u += LOT_BAY_WIDTH) {
        const x = u * ux + v * vx;
        const y = u * uy + v * vy;
        // The bay and the planted rim round it both stand on the car park.
        const room = rectangle(x, y, vx, vy, LOT_BAY_LENGTH / 2 + STREET_REACH, LOT_BAY_WIDTH / 2 + STREET_REACH);
        if (insideRegion(room, region)) out.push({ x, y, heading: facing, use, street: false });
      }
    }
  }
}

/** A rectangle about a middle, its long side along `(dx, dy)`, wound anticlockwise. */
function rectangle(x: number, y: number, dx: number, dy: number, halfLength: number, halfWidth: number): Point[] {
  const lx = dx * halfLength;
  const ly = dy * halfLength;
  const wx = -dy * halfWidth;
  const wy = dx * halfWidth;
  const ring = [
    { x: x - lx - wx, y: y - ly - wy },
    { x: x + lx - wx, y: y + ly - wy },
    { x: x + lx + wx, y: y + ly + wy },
    { x: x - lx + wx, y: y - ly + wy },
  ];
  return ringArea(ring) < 0 ? ring.reverse() : ring;
}

/** The point a distance along a curve, given the metres at each of its points. */
function pointAt(points: readonly Point[], along: Float64Array, s: number): Point {
  let k = 0;
  while (k + 2 < points.length && (along[k + 1] as number) < s) k++;
  const a = points[k] as Point;
  const b = points[k + 1] as Point;
  const span = (along[k + 1] as number) - (along[k] as number);
  const t = span > 0 ? Math.min(1, Math.max(0, (s - (along[k] as number)) / span)) : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Radians a curve turns through between two distances along it, summed over its corners. */
function bendOver(points: readonly Point[], along: Float64Array, from: number, to: number): number {
  let turn = 0;
  for (let k = 1; k + 1 < points.length; k++) {
    const at = along[k] as number;
    if (at <= from || at >= to) continue;
    const a = points[k - 1] as Point;
    const b = points[k] as Point;
    const c = points[k + 1] as Point;
    const delta = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
    turn += Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
  }
  return turn;
}

/** Every road segment, filed by the box its footprint covers, so a bay asks only its neighbours. */
class SegmentGrid {
  private readonly roads: readonly RoadCurve[];
  private readonly cells = new Map<number, number[]>();
  /** Two numbers to a segment: the curve and the point it starts at. */
  private readonly segments: number[] = [];

  constructor(roads: readonly RoadCurve[]) {
    this.roads = roads;
    for (const road of roads) {
      const reach = footprintHalfWidth(road.tier);
      for (let i = 0; i + 1 < road.points.length; i++) {
        const a = road.points[i] as Point;
        const b = road.points[i + 1] as Point;
        const index = this.segments.length / 2;
        this.segments.push(road.id, i);
        for (let cy = cellOf(Math.min(a.y, b.y) - reach); cy <= cellOf(Math.max(a.y, b.y) + reach); cy++) {
          for (let cx = cellOf(Math.min(a.x, b.x) - reach); cx <= cellOf(Math.max(a.x, b.x) + reach); cx++) {
            const key = keyOf(cx, cy);
            const list = this.cells.get(key);
            if (list === undefined) this.cells.set(key, [index]);
            else list.push(index);
          }
        }
      }
    }
  }

  /**
   * True when a bay of a street stands clear of the ground every other road
   * claims, and of its own street's lanes. The street's own stretches more
   * than {@link OWN_REACH} along it count as other roads, so a street that
   * bends back past itself is kept to.
   */
  clear(ring: readonly Point[], curve: number, along: Float64Array, s: number): boolean {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of ring) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    for (let cy = cellOf(minY); cy <= cellOf(maxY); cy++) {
      for (let cx = cellOf(minX); cx <= cellOf(maxX); cx++) {
        for (const index of this.cells.get(keyOf(cx, cy)) ?? []) {
          const id = this.segments[index * 2] as number;
          const i = this.segments[index * 2 + 1] as number;
          const own = id === curve && (along[i + 1] as number) > s - OWN_REACH && (along[i] as number) < s + OWN_REACH;
          const road = this.roads[id] as RoadCurve;
          const reach = own ? laneHalfWidth(road.tier) : footprintHalfWidth(road.tier);
          const quad = segmentQuad(road.points[i] as Point, road.points[i + 1] as Point, reach);
          if (quad !== undefined && ringsClash(ring, quad, own ? -BAY_SHARE : 0)) return false;
        }
      }
    }
    return true;
  }
}

/** Metres from a road's centreline to the outer edge of its lanes: the carriageway less its parking strip. */
export function laneHalfWidth(tier: RoadTier): number {
  return TIERS[tier].width / 2 - TIERS[tier].parking;
}

/** The ground a road claims along one segment, as a rectangle; nothing for a segment of no length. */
export function segmentQuad(a: Point, b: Point, halfWidth: number): Point[] | undefined {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length === 0) return undefined;
  const dx = (b.x - a.x) / length;
  const dy = (b.y - a.y) / length;
  return rectangle((a.x + b.x) / 2, (a.y + b.y) / 2, dx, dy, length / 2, halfWidth);
}

function cellOf(v: number): number {
  return Math.floor(v / CELL);
}

function keyOf(cx: number, cy: number): number {
  return (cx + 32768) * 65536 + (cy + 32768);
}
