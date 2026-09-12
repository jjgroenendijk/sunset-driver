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
import { pointInRing, type Point as GeomPoint } from '../core/geom.ts';
import { clamp, lerp, smoothstep } from '../core/math.ts';
import { RoadBeds, type JunctionPlane } from './bed.ts';
import { Heightfield } from './heightfield.ts';
import type { JunctionMap } from './junctions.ts';
import { CHUNK_TERRAIN_CELL } from './terrain.ts';
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
 * cell of the chunk grid wide is the narrowest one the ground the game draws
 * can hold; the skeleton's coarser grid is only what the roads were traced on.
 */
const MIN_BENCH = CHUNK_TERRAIN_CELL;

/**
 * Metres of level ground a bench keeps past the edge of the road drawn on it.
 *
 * The ground is a grid of {@link CHUNK_TERRAIN_CELL} cells and a road is a
 * surface laid over it, so a cell that holds the edge of the road has corners
 * each side of it. A corner outside the bench stands on the hillside blending
 * back, which on the uphill side is higher than the road: the triangle between
 * the two corners then cuts up through the road and the ground shows through
 * its verge. One cell diagonal of level ground past the edge is what puts every
 * corner of every such cell on the bench itself.
 */
const BENCH_MARGIN = CHUNK_TERRAIN_CELL * Math.SQRT2;

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
 * Metres two roads claiming one place may ask for and still be one bed. Below
 * this the ground the lower of them gets is the ground the other wanted, to
 * within what the grid can hold anyway.
 */
const CROWDED_BY = 0.05;

/**
 * How far the flat bench of a tier reaches each side of its centreline: the
 * ground the road claims (spec section 6.4), or one chunk terrain cell where
 * that is narrower than the grid can hold, and {@link BENCH_MARGIN} past either
 * so the grid cannot lift the hillside through the edge of the road.
 */
export function benchHalfWidth(tier: RoadTier): number {
  return Math.max(footprintHalfWidth(tier), MIN_BENCH) + BENCH_MARGIN;
}

/**
 * The terrain a road network is cut into.
 *
 * Ask it for the ground at a place and it answers with the natural height there
 * moved toward the road bed of the nearest road that reaches it. The bed is
 * the one `bed.ts` defines, so a junction is one plane. Nothing is stored per
 * place, so the whole map and one chunk of it get the same answer for the same
 * place, whichever is asked first.
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
  /**
   * How far each side of the segment the road's own surface is drawn, which is
   * the ground it claims (spec section 6.4). A place inside it belongs to that
   * road before any road that merely reaches it.
   */
  private readonly claimed: number[] = [];
  /** The curve each segment belongs to, so a caller can ask who carved the ground. */
  private readonly curve: number[] = [];
  /** The segments filed in each bucket of the index, by index into the arrays above. */
  private readonly buckets: number[][] = [];
  /**
   * The junctions (spec section 6.2), each levelled to one plane over the
   * whole of its outline, and the junctions filed in each bucket.
   */
  private readonly junctions: { ring: GeomPoint[]; plane: JunctionPlane; curve: number; claimed: number }[] = [];
  private readonly junctionBuckets: number[][] = [];
  private readonly columns: number;
  private readonly originX: number;
  private readonly originY: number;
  /** The last answer of {@link RoadCarve.claim}, so asking twice allocates nothing. */
  private weight = 0;
  private height = 0;
  private road = -1;
  private crowded = false;

  constructor(terrain: HeightfieldData, roads: readonly RoadCurve[], junctions?: JunctionMap) {
    const hf = new Heightfield(terrain);
    const beds = new RoadBeds(terrain, roads, junctions);
    this.hf = hf;
    // The index covers the map with a margin, so a road beside the edge is filed
    // rather than folded onto the last column.
    this.originX = hf.originX - INDEX_CELL;
    this.originY = hf.originY - INDEX_CELL;
    this.columns = Math.ceil((hf.extent + 4 * INDEX_CELL) / INDEX_CELL);
    for (let i = 0; i < this.columns * this.columns; i++) {
      this.buckets.push([]);
      this.junctionBuckets.push([]);
    }
    if (junctions !== undefined) {
      for (let j = 0; j < junctions.junctions.length; j++) {
        const junction = junctions.junctions[j] as JunctionMap['junctions'][number];
        const plane = beds.planes[j] as JunctionPlane;
        const mouth = junction.mouths[0];
        if (mouth === undefined || junction.outline.length < 3) continue;
        const at = this.junctions.length;
        this.junctions.push({
          ring: junction.outline,
          plane,
          curve: mouth.curve,
          claimed: footprintHalfWidth(junction.tier),
        });
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const p of junction.outline) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
        this.fileJunction(at, minX, minY, maxX, maxY, BENCH_MARGIN + CARVE_BLEND);
      }
    }

    for (const road of roads) {
      const halfWidth = benchHalfWidth(road.tier);
      const claimed = footprintHalfWidth(road.tier);
      const reach = halfWidth + CARVE_BLEND;
      const segments = Math.max(0, road.points.length - 1);
      const standing = new Uint8Array(segments).fill(1);
      for (const i of road.bridges) if (i >= 0 && i < segments) standing[i] = 0;
      for (const i of road.tunnels) if (i >= 0 && i < segments) standing[i] = 0;
      for (let i = 0; i < segments; i++) {
        if (standing[i] === 0) continue;
        const a = road.points[i] as Point;
        const b = road.points[i + 1] as Point;
        // A curve that stands still carves nothing the segments beside it do not.
        if (a.x === b.x && a.y === b.y) continue;
        // The bed is straight between the knots of the segment, so each stretch
        // between two knots is filed on its own with its own rise.
        const knots = beds.knotsOf(road.id, i);
        for (let k = 0; k + 1 < knots.length; k++) {
          const from = knots[k] as { t: number; h: number };
          const to = knots[k + 1] as { t: number; h: number };
          if (to.t <= from.t) continue;
          const ax = a.x + (b.x - a.x) * from.t;
          const ay = a.y + (b.y - a.y) * from.t;
          const dx = (b.x - a.x) * (to.t - from.t);
          const dy = (b.y - a.y) * (to.t - from.t);
          const squared = dx * dx + dy * dy;
          if (squared === 0) continue;
          const at = this.ax.length;
          this.ax.push(ax);
          this.ay.push(ay);
          this.vx.push(dx);
          this.vy.push(dy);
          this.inv.push(1 / squared);
          this.h0.push(from.h);
          this.rise.push(to.h - from.h);
          this.half.push(halfWidth);
          this.claimed.push(claimed);
          this.reach.push(reach);
          this.curve.push(road.id);
          this.file(at, Math.min(ax, ax + dx), Math.min(ay, ay + dy), Math.max(ax, ax + dx), Math.max(ay, ay + dy), reach);
        }
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

  /**
   * True where more than one stretch of road claims the ground at a place and
   * they ask for different heights — two roads crowded within a bench of each
   * other, or one road brought back beside itself by a hairpin. One grid holds
   * one height, so the ground follows the lowest of the beds asked for and
   * every other road there stands over the ground it drives on. Nothing in the
   * carve can mend that; it is the road network that put two roads in one
   * place, so the sweeps ask this before holding the carve to account for the
   * ground under them.
   */
  crowdedAt(x: number, y: number): boolean {
    this.claim(x, y);
    return this.crowded;
  }

  /**
   * Find the road whose bed carves a place, and how far the ground follows it.
   * A junction is one claimant among the roads: the whole of its outline and
   * the margin around it are on its plane, and the ground beyond that blends
   * back over {@link CARVE_BLEND} as it does beside a bench.
   *
   * Where two roads reach the same ground the ground goes to the one that
   * draws its surface there — the point stands inside the ground that road
   * claims (spec section 6.4) — and to the wider of them where it stands
   * inside both. An alley crossing a highway is two metres wide and the
   * highway is thirty; carving the ground under the highway to the alley's bed
   * would bury the road the player is driving on. Only where no road claims
   * the place does the nearest bench win it, and the road each bucket lists
   * first wins where even that is a tie, so the answer never depends on the
   * order the question is asked in.
   */
  private claim(x: number, y: number): void {
    this.weight = 0;
    this.height = 0;
    this.road = -1;
    this.crowded = false;
    const at = this.row(y) * this.columns + this.column(x);
    const bucket = this.buckets[at];
    if (bucket === undefined) return;
    /** The highest and lowest bed the claims ask for, which say if they differ. */
    let asked = Infinity;
    let askedHigh = -Infinity;
    let bestClaimed = 0;
    let bestWeight = 0;
    let bestDistance = Infinity;
    let bestHeight = 0;
    let bestRoad = -1;
    /**
     * Take a claimant where it beats the best so far. `claimed` is how wide the
     * road that claims the place is, and zero where the place is outside the
     * ground it claims. A claim always beats ground merely reached; between two
     * claims the lower bed wins, then the wider road, then the nearer one.
     */
    const offer = (claimed: number, weight: number, distance: number, bed: number, road: number): void => {
      if (claimed > 0) {
        asked = Math.min(asked, bed);
        askedHigh = Math.max(askedHigh, bed);
      }
      if (claimed > 0 || bestClaimed > 0) {
        if (bestClaimed > 0 && claimed === 0) return;
        if (
          bestClaimed > 0 &&
          (bed > bestHeight ||
            (bed === bestHeight && (claimed < bestClaimed || (claimed === bestClaimed && distance >= bestDistance))))
        ) {
          return;
        }
      } else if (weight < bestWeight || (weight === bestWeight && distance >= bestDistance)) {
        return;
      }
      bestClaimed = claimed;
      bestWeight = weight;
      bestDistance = distance;
      bestHeight = bed;
      bestRoad = road;
    };
    // A place inside a junction's outline is the junction's, whatever else
    // reaches it: the whole outline stands on the one plane, which is what
    // leaves no crease under the surfaces laid over it (`bed.ts`). The scan
    // carries on all the same, because another road may claim the same place at
    // another height — a street crossing under a junction of a wider road is
    // exactly the crowded case this answers — and that is only seen by asking
    // every claimant.
    let ownerHeight = 0;
    let ownerRoad = -1;
    for (const j of this.junctionBuckets[at] ?? []) {
      const junction = this.junctions[j] as (typeof this.junctions)[number];
      const distance = pointInRing({ x, y }, junction.ring) ? 0 : ringDistance(junction.ring, x, y);
      if (distance >= BENCH_MARGIN + CARVE_BLEND) continue;
      const claims = distance <= BENCH_MARGIN;
      const weight = claims ? 1 : 1 - smoothstep(BENCH_MARGIN, BENCH_MARGIN + CARVE_BLEND, distance);
      const plane = junction.plane;
      const bed = plane.level + plane.gx * (x - plane.x) + plane.gy * (y - plane.y);
      if (distance === 0) {
        if (ownerRoad < 0) {
          ownerHeight = bed;
          ownerRoad = junction.curve;
        }
        asked = Math.min(asked, bed);
        askedHigh = Math.max(askedHigh, bed);
        continue;
      }
      offer(claims ? junction.claimed : 0, weight, distance, bed, junction.curve);
    }
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
      // The bench is the ground the road draws its surface on, plus the margin
      // the grid needs around it, so that is the ground the road claims.
      offer(distance <= half ? (this.claimed[i] as number) : 0, weight, distance, bed, this.curve[i] as number);
    }
    this.weight = ownerRoad >= 0 ? 1 : bestWeight;
    this.height = ownerRoad >= 0 ? ownerHeight : bestHeight;
    this.road = ownerRoad >= 0 ? ownerRoad : bestRoad;
    this.crowded = askedHigh - asked > CROWDED_BY;
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

  /** File a junction in every bucket its outline and the blend beyond it reach into. */
  private fileJunction(at: number, minX: number, minY: number, maxX: number, maxY: number, reach: number): void {
    const x0 = this.column(minX - reach);
    const x1 = this.column(maxX + reach);
    const y0 = this.row(minY - reach);
    const y1 = this.row(maxY + reach);
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) (this.junctionBuckets[iy * this.columns + ix] as number[]).push(at);
    }
  }

  private column(x: number): number {
    return clamp(Math.floor((x - this.originX) / INDEX_CELL), 0, this.columns - 1);
  }

  private row(y: number): number {
    return clamp(Math.floor((y - this.originY) / INDEX_CELL), 0, this.columns - 1);
  }
}

/** Metres from a place to the nearest edge of a ring. */
function ringDistance(ring: readonly GeomPoint[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j] as GeomPoint;
    const b = ring[i] as GeomPoint;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const squared = dx * dx + dy * dy;
    const t = squared === 0 ? 0 : clamp(((x - a.x) * dx + (y - a.y) * dy) / squared, 0, 1);
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)));
  }
  return best;
}

/**
 * Build the carve of a road network over the terrain it was traced on. Given
 * the junctions, the ground under each is levelled to the junction's plane
 * (`bed.ts`); without them every bed is the natural ground under its curve.
 */
export function buildCarve(terrain: HeightfieldData, roads: readonly RoadCurve[], junctions?: JunctionMap): RoadCarve {
  return new RoadCarve(terrain, roads, junctions);
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
