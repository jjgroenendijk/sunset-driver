/**
 * The ground the roads stand on (spec section 7.1).
 *
 * A road is never draped over the hill it crosses. The ground under it is cut
 * flat across the carriageway and follows the line the road drives along it, and
 * the cut and fill slopes blend back into the hillside within a fixed distance.
 * So a street on a slope sits in a bench: level from kerb to kerb, banked on the
 * uphill side, made up on the downhill one. A bench never takes more than
 * {@link CARVE_CUT} off the hillside or makes up more than {@link CARVE_FILL},
 * so the ground moves by a bounded amount wherever the hill is steep.
 *
 * The line a road drives is the natural ground under its own points: the tracer
 * laid every curve on the terrain and refused any step its tier may not climb
 * (spec section 6.1), so the bed between two points of a curve is the straight
 * line between the heights there. Under the road itself the ground therefore
 * barely moves — the tracer already kept it within the cut and fill a road bed
 * absorbs — and what the carve does is take the ground each side of it down or
 * up to that bed.
 *
 * A segment carried on a deck or bored through a hill carves nothing: the
 * terrain under a bridge and over a tunnel is the terrain the world was given.
 * Corridors carve nothing of their own either — the tram runs in a lane down an
 * arterial, which carves its own bench, and the ground under an elevated deck is
 * ground the road never stands on.
 *
 * Where two roads reach the same ground, the nearer one carves it. Spec section
 * 1.1: ground is claimed once and never shared, and the terrain under it obeys
 * the same rule as the parcels over it.
 *
 * Built on demand from the curves like the road graph and the footprint, not
 * stored in the world description. Pure: the same terrain and roads give the
 * same carve, and {@link RoadCarve.heightAt} answers for one place without
 * reference to any other, which is what lets a chunk carve its own heights
 * (spec section 9.1).
 */
import { clamp, lerp, smoothstep } from '../core/math.ts';
import { Heightfield } from './heightfield.ts';
import { TERRAIN_CELL } from './terrain.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { HeightfieldData, Point, RoadCurve, RoadTier } from './types.ts';

/**
 * Metres the cut and fill slopes take to reach the hillside again, measured out
 * from the edge of the bench.
 */
export const CARVE_BLEND = 12;

/**
 * Narrowest bench a road may cut, each side of its centreline. The heights
 * between two samples of the terrain are a straight line, so a flat band
 * narrower than one cell cannot survive being sampled: an alley four metres wide
 * would leave the ground it stands on exactly as it found it. A bench at least a
 * cell wide is the narrowest one the grid can hold.
 */
const MIN_BENCH = TERRAIN_CELL;

/**
 * Metres of hillside a bench may take away, and metres of ground it may make up.
 * A road on a slope steep enough to ask for more than this gets a retaining wall
 * rather than an endless cutting: the ground beyond the limit stays where it is.
 *
 * This is also what bounds how far a road can end up standing off its own bed.
 * The carved ground between two samples is the straight line between them, so a
 * place on it is never further from the natural ground than the furthest of the
 * samples around it — and none of them moves further than this.
 */
export const CARVE_CUT = 6;
export const CARVE_FILL = 6;

/** Side of one bucket of the segment index, in metres. */
const INDEX_CELL = 48;

/**
 * How far the flat bench of a tier reaches each side of its centreline: the
 * ground the road claims (spec section 6.4), or one terrain cell where that is
 * narrower than the grid can hold.
 */
export function benchHalfWidth(tier: RoadTier): number {
  return Math.max(footprintHalfWidth(tier), MIN_BENCH);
}

/**
 * The terrain a road network is cut into.
 *
 * Ask it for the ground at a place and it answers with the natural height there
 * moved toward the road bed of the nearest road that reaches it. Nothing is
 * stored per place, so the whole map and one chunk of it get the same answer for
 * the same place, whichever is asked first.
 */
export class RoadCarve {
  private readonly hf: Heightfield;
  /** Segment ends, direction, and the profile heights along each one. */
  private readonly ax: number[] = [];
  private readonly ay: number[] = [];
  private readonly vx: number[] = [];
  private readonly vy: number[] = [];
  /** One over the squared length, so the projection is a multiply. */
  private readonly inv: number[] = [];
  private readonly h0: number[] = [];
  private readonly rise: number[] = [];
  private readonly half: number[] = [];
  private readonly reach: number[] = [];
  /** The curve each segment belongs to, so a caller can ask who carved the ground. */
  private readonly curve: number[] = [];
  /** The segments filed in each bucket of the index, by index into the arrays above. */
  private readonly buckets: number[][] = [];
  private readonly columns: number;
  private readonly originX: number;
  private readonly originY: number;
  /** The last answer of {@link RoadCarve.claim}, so asking twice allocates nothing. */
  private weight = 0;
  private height = 0;
  private road = -1;

  constructor(terrain: HeightfieldData, roads: readonly RoadCurve[]) {
    const hf = new Heightfield(terrain);
    this.hf = hf;
    // The index covers the map with a margin, so a road beside the edge is filed
    // rather than folded onto the last column.
    this.originX = hf.originX - INDEX_CELL;
    this.originY = hf.originY - INDEX_CELL;
    this.columns = Math.ceil((hf.extent + 4 * INDEX_CELL) / INDEX_CELL);
    for (let i = 0; i < this.columns * this.columns; i++) this.buckets.push([]);

    for (const road of roads) {
      const halfWidth = benchHalfWidth(road.tier);
      const reach = halfWidth + CARVE_BLEND;
      const segments = Math.max(0, road.points.length - 1);
      const standing = new Uint8Array(segments).fill(1);
      for (const i of road.bridges) if (i >= 0 && i < segments) standing[i] = 0;
      for (const i of road.tunnels) if (i >= 0 && i < segments) standing[i] = 0;
      for (let i = 0; i < segments; i++) {
        if (standing[i] === 0) continue;
        const a = road.points[i] as Point;
        const b = road.points[i + 1] as Point;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const squared = dx * dx + dy * dy;
        // A curve that stands still carves nothing the segments beside it do not.
        if (squared === 0) continue;
        const at = this.ax.length;
        this.ax.push(a.x);
        this.ay.push(a.y);
        this.vx.push(dx);
        this.vy.push(dy);
        this.inv.push(1 / squared);
        const start = hf.sample(a.x, a.y);
        this.h0.push(start);
        this.rise.push(hf.sample(b.x, b.y) - start);
        this.half.push(halfWidth);
        this.reach.push(reach);
        this.curve.push(road.id);
        this.file(at, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), reach);
      }
    }
  }

  /** How many road segments carve the ground. */
  get segments(): number {
    return this.ax.length;
  }

  /**
   * The ground at a place: the natural height there, cut or made up toward the
   * bed of the nearest road that reaches it, and never by more than
   * {@link CARVE_CUT} or {@link CARVE_FILL}. Ground no road reaches comes back
   * exactly as the terrain has it.
   */
  heightAt(x: number, y: number): number {
    const natural = this.hf.sample(x, y);
    this.claim(x, y);
    if (this.weight <= 0) return natural;
    const bed = natural + clamp(this.height - natural, -CARVE_CUT, CARVE_FILL);
    return lerp(natural, bed, this.weight);
  }

  /**
   * The curve that carves the ground at a place, or -1 where no road reaches it.
   * Ground within reach of two roads belongs to the nearer of them, as the
   * parcel over it belongs to one owner (spec section 1.1).
   */
  roadAt(x: number, y: number): number {
    this.claim(x, y);
    return this.road;
  }

  /** Find the road whose bed carves a place, and how far the ground follows it. */
  private claim(x: number, y: number): void {
    this.weight = 0;
    this.height = 0;
    this.road = -1;
    const bucket = this.buckets[this.row(y) * this.columns + this.column(x)];
    if (bucket === undefined) return;
    let bestWeight = 0;
    let bestDistance = Infinity;
    let bestHeight = 0;
    let bestRoad = -1;
    for (const i of bucket) {
      const reach = this.reach[i] as number;
      const dx = x - (this.ax[i] as number);
      const dy = y - (this.ay[i] as number);
      const vx = this.vx[i] as number;
      const vy = this.vy[i] as number;
      const t = clamp((dx * vx + dy * vy) * (this.inv[i] as number), 0, 1);
      const offX = dx - vx * t;
      const offY = dy - vy * t;
      const distance = Math.sqrt(offX * offX + offY * offY);
      if (distance >= reach) continue;
      const half = this.half[i] as number;
      const weight = distance <= half ? 1 : 1 - smoothstep(half, reach, distance);
      const bed = (this.h0[i] as number) + (this.rise[i] as number) * t;
      // The nearest road wins the ground where two of them reach it, and the
      // road each bucket lists first wins where even that is a tie, so the
      // answer never depends on the order the question is asked in.
      if (weight < bestWeight || (weight === bestWeight && distance >= bestDistance)) continue;
      bestWeight = weight;
      bestDistance = distance;
      bestHeight = bed;
      bestRoad = this.curve[i] as number;
    }
    this.weight = bestWeight;
    this.height = bestHeight;
    this.road = bestRoad;
  }

  /** File a segment in every bucket the ground it carves reaches into. */
  private file(at: number, minX: number, minY: number, maxX: number, maxY: number, reach: number): void {
    const x0 = this.column(minX - reach);
    const x1 = this.column(maxX + reach);
    const y0 = this.row(minY - reach);
    const y1 = this.row(maxY + reach);
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) (this.buckets[iy * this.columns + ix] as number[]).push(at);
    }
  }

  private column(x: number): number {
    return clamp(Math.floor((x - this.originX) / INDEX_CELL), 0, this.columns - 1);
  }

  private row(y: number): number {
    return clamp(Math.floor((y - this.originY) / INDEX_CELL), 0, this.columns - 1);
  }
}

/** Build the carve of a road network over the terrain it was traced on. */
export function buildCarve(terrain: HeightfieldData, roads: readonly RoadCurve[]): RoadCarve {
  return new RoadCarve(terrain, roads);
}

/**
 * The whole map as the roads leave it, on the grid the natural terrain uses.
 * A chunk carves its own heights instead (spec section 9.1); this is for the
 * tools and the tests that want the map in one piece.
 */
export function carvedTerrain(terrain: HeightfieldData, carve: RoadCarve): Heightfield {
  const source = new Heightfield(terrain);
  const out = new Heightfield({
    gridSize: source.gridSize,
    cellSize: source.cellSize,
    originX: source.originX,
    originY: source.originY,
    heights: new Float32Array(source.gridSize * source.gridSize),
  });
  for (let iy = 0; iy < source.gridSize; iy++) {
    const y = source.worldY(iy);
    for (let ix = 0; ix < source.gridSize; ix++) out.set(ix, iy, carve.heightAt(source.worldX(ix), y));
  }
  return out;
}
