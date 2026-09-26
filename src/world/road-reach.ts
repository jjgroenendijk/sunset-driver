/**
 * Which roads run along a piece of ground (spec section 6.4, step 3).
 *
 * `parcels.ts` asks it of every piece the roads leave: a piece no road runs
 * along is dropped, and how much of a piece's boundary stands on a road says
 * whether the roads enclose it.
 */
import type { Point, Region } from '../core/geom.ts';
import { hypot } from '../core/libm.ts';
import { compareNumbers } from '../core/sort.ts';
import type { RoadEdge, RoadGraph } from './graph.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { RoadCurve } from './types.ts';

/** Metres past the ground a road claims that a parcel still counts as running along it. */
const ROAD_REACH = 2;
/** Metres between the points of a parcel's boundary that are asked which roads run along them. */
const EDGE_STEP = 8;
/** Metres of one bucket of the road index. Small enough that a bucket holds a handful of segments. */
const REACH_CELL = 48;

/** The outer ring of a region and the rings of its holes, outer first. */
export function ringsOf(region: Region): Point[][] {
  const rings: Point[][] = [region.outer];
  for (const hole of region.holes) rings.push(hole);
  return rings;
}

/** What the boundary of a piece of ground runs along. */
export interface RoadsAlong {
  /** The graph edges that run along it, ascending. One of each two-way pair. */
  roads: number[];
  /** How much of the boundary stands on the ground a road claims, in [0, 1]. */
  enclosed: number;
}

/**
 * Which roads run along a piece of ground.
 *
 * A parcel borders a road when its boundary stands on the edge of the ground
 * that road claims, so the question is which road centrelines pass within their
 * own footprint half-width of a point. Only the runs a road stands on are
 * indexed: a deck or a bore claims no ground, and neither borders a parcel.
 *
 * Segments sit in a uniform grid of buckets by the ground they cover, widened
 * by that half-width, so a query costs a handful of distance tests.
 */
export class RoadReach {
  private readonly graph: RoadGraph;
  private readonly ax: number[] = [];
  private readonly ay: number[] = [];
  private readonly bx: number[] = [];
  private readonly by: number[] = [];
  /** The graph edge each segment belongs to, and how far its ground reaches, squared. */
  private readonly edge: number[] = [];
  private readonly reachSquared: number[] = [];
  private readonly buckets = new Map<number, number[]>();
  private readonly minColumn: number;
  private readonly minRow: number;
  private readonly columns: number;
  private readonly rows: number;
  /** Which query last claimed each edge, so one parcel never lists a road twice. */
  private readonly claimed: Int32Array;
  private queries = 0;

  constructor(roads: readonly RoadCurve[], graph: RoadGraph) {
    this.graph = graph;
    this.claimed = new Int32Array(graph.edges.length).fill(-1);
    const offGround = groundMasks(roads);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const edge of graph.edges) {
      // One of a two-way pair is enough; the twin stands on the same ground.
      if (edge.twin >= 0 && edge.twin < edge.id) continue;
      const road = roads[edge.curve] as RoadCurve;
      const off = offGround[edge.curve] as Uint8Array;
      const reach = footprintHalfWidth(edge.tier) + ROAD_REACH;
      for (let i = Math.min(edge.start, edge.end); i < Math.max(edge.start, edge.end); i++) {
        if (off[i] === 1) continue;
        const a = road.points[i] as Point;
        const b = road.points[i + 1] as Point;
        this.ax.push(a.x);
        this.ay.push(a.y);
        this.bx.push(b.x);
        this.by.push(b.y);
        this.edge.push(edge.id);
        this.reachSquared.push(reach * reach);
        minX = Math.min(minX, a.x - reach, b.x - reach);
        minY = Math.min(minY, a.y - reach, b.y - reach);
        maxX = Math.max(maxX, a.x + reach, b.x + reach);
        maxY = Math.max(maxY, a.y + reach, b.y + reach);
      }
    }
    const empty = this.ax.length === 0;
    this.minColumn = empty ? 0 : columnOf(minX);
    this.minRow = empty ? 0 : columnOf(minY);
    this.columns = empty ? 1 : columnOf(maxX) - this.minColumn + 1;
    this.rows = empty ? 1 : columnOf(maxY) - this.minRow + 1;
    for (let s = 0; s < this.ax.length; s++) this.file(s);
  }

  /** File segment `s` in every bucket its reach covers. */
  private file(s: number): void {
    const reach = Math.sqrt(this.reachSquared[s] as number);
    const loX = columnOf(Math.min(this.ax[s] as number, this.bx[s] as number) - reach);
    const hiX = columnOf(Math.max(this.ax[s] as number, this.bx[s] as number) + reach);
    const loY = columnOf(Math.min(this.ay[s] as number, this.by[s] as number) - reach);
    const hiY = columnOf(Math.max(this.ay[s] as number, this.by[s] as number) + reach);
    for (let cx = loX; cx <= hiX; cx++) {
      for (let cy = loY; cy <= hiY; cy++) {
        const key = this.keyOf(cx, cy);
        const bucket = this.buckets.get(key);
        if (bucket === undefined) this.buckets.set(key, [s]);
        else bucket.push(s);
      }
    }
  }

  /**
   * One bucket as a single number. Every segment stands inside the bounds the
   * index was built with, so its row is in range and no two buckets share a key.
   * A point outside them is clamped onto the edge, where the distance test
   * turns it away.
   */
  private keyOf(column: number, row: number): number {
    const across = Math.max(0, Math.min(this.columns - 1, column - this.minColumn));
    const down = Math.max(0, Math.min(this.rows - 1, row - this.minRow));
    return across * this.rows + down;
  }

  /** What runs along the boundary of a region. */
  along(region: Region): RoadsAlong {
    const query = this.queries++;
    const roads: number[] = [];
    let asked = 0;
    let onRoad = 0;
    for (const ring of ringsOf(region)) {
      // Every {@link EDGE_STEP} metres round the ring, wherever its corners fall.
      let since = EDGE_STEP;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i] as Point;
        const b = ring[(i + 1) % ring.length] as Point;
        const span = hypot(b.x - a.x, b.y - a.y);
        let at = 0;
        while (since + (span - at) >= EDGE_STEP) {
          at += EDGE_STEP - since;
          since = 0;
          const t = span > 0 ? at / span : 0;
          asked++;
          if (this.gather(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, query, roads)) onRoad++;
        }
        since += span - at;
      }
    }
    roads.sort(compareNumbers);
    return { roads, enclosed: asked === 0 ? 0 : onRoad / asked };
  }

  /**
   * Add the edges whose ground covers one point to `roads`, and say whether any
   * did. An edge already found for this query is not listed twice, but the
   * point still counts as standing on a road.
   */
  private gather(x: number, y: number, query: number, roads: number[]): boolean {
    let hit = false;
    for (const s of this.buckets.get(this.keyOf(columnOf(x), columnOf(y))) ?? []) {
      if (distanceSquaredToSegment(x, y, this.ax[s] as number, this.ay[s] as number, this.bx[s] as number, this.by[s] as number) > (this.reachSquared[s] as number)) {
        continue;
      }
      hit = true;
      const edge = this.edge[s] as number;
      if (this.claimed[edge] === query) continue;
      this.claimed[edge] = query;
      roads.push(this.pairOf(edge));
    }
    return hit;
  }

  /** The lower of a two-way pair, so both directions of a road name one edge. */
  private pairOf(edge: number): number {
    const twin = (this.graph.edges[edge] as RoadEdge).twin;
    return twin >= 0 && twin < edge ? twin : edge;
  }
}

/** Which column or row of the road index a coordinate falls in. */
function columnOf(v: number): number {
  return Math.floor(v / REACH_CELL);
}

/** One mask per curve: 1 where the segment stands off the ground, on a deck or in a bore. */
function groundMasks(roads: readonly RoadCurve[]): Uint8Array[] {
  const masks: Uint8Array[] = [];
  for (const road of roads) {
    const mask = new Uint8Array(Math.max(0, road.points.length - 1));
    for (const i of road.bridges) if (i >= 0 && i < mask.length) mask[i] = 1;
    for (const i of road.tunnels) if (i >= 0 && i < mask.length) mask[i] = 1;
    masks.push(mask);
  }
  return masks;
}

function distanceSquaredToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const lengthSquared = vx * vx + vy * vy;
  let t = lengthSquared > 0 ? ((px - ax) * vx + (py - ay) * vy) / lengthSquared : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return dx * dx + dy * dy;
}
