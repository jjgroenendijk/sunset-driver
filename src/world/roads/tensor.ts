/**
 * The seeded tensor field road direction follows (spec section 6.1).
 *
 * A direction is stored as a symmetric traceless tensor, encoded as
 * `(a, b) = w · (cos 2θ, sin 2θ)`. Adding tensors blends directions the way a
 * road network needs: θ and θ + π are the same street, so influences that face
 * opposite ways reinforce instead of cancelling, while influences at 45° do
 * cancel. The major eigenvector, `½·atan2(b, a)`, is the direction a road wants
 * to run in; the minor eigenvector is the cross street.
 *
 * Four influences blend: the terrain gradient (roads follow the contour on
 * steep ground), the shoreline and the river banks (roads run parallel to
 * water), a radial field around the core, and a per-district grid in planned
 * districts. A slow noise wander keeps the result from ever being exactly
 * regular.
 *
 * Over the core and the inner ring one more thing holds: the city's plan. How
 * firmly a city holds a plan is drawn from its seed (spec section 6.1). A
 * planned city gives the grid almost the whole weight, so its avenues run
 * straight and stop at the water. An organic city gives it to the coast, the
 * river and the rings around the middle. Both cut the wander back to nothing,
 * because a street that wobbles every fifty metres belongs to neither.
 *
 * The field is a pure function of the world description: no state, no
 * wall-clock, safe to build in a worker or in Node.
 */
import { clamp, lerp, smoothstep, wrapDirection } from '../../core/math.ts';
import { Noise2D } from '../../core/noise.ts';
import { genRng, Subsystem } from '../../core/rng.ts';
import { atan2, cos, hypot, sin } from '../../core/libm.ts';
import { ZONE_RADII } from '../terrain/districts.ts';
import { Heightfield } from '../terrain/heightfield.ts';
import { segmentDistance } from '../terrain/terrain.ts';
import type { Point, WorldSkeleton, Zone } from '../types.ts';

const HALF_PI = Math.PI / 2;

type Weights = Record<'coast' | 'grid' | 'river' | 'terrain' | 'radial' | 'wander', number>;

/**
 * Peak weight of each influence. Only the ratios matter: an influence of weight
 * `w2` pulls a dominant influence of weight `w1` off its direction by at most
 * `½·asin(w2 / w1)`.
 */
const WEIGHT: Weights = {
  coast: 4,
  grid: 3,
  river: 1.6,
  terrain: 1.2,
  radial: 0.9,
  wander: 0.35,
};

/**
 * The same weights over the core and the inner ring, at the two ends of the
 * range a seed draws from. Inside the city one influence has to win clearly:
 * where nothing wins, the streets fan and the result is noise rather than a
 * city.
 *
 * Planned: the grid outweighs everything, so the coast bends an avenue by under
 * four degrees and the rings are gone. Organic: the water and the rings decide,
 * and the grid only says which way the ground between them leans.
 */
const PLANNED: Weights = {
  coast: 1.2,
  grid: 9,
  river: 0.8,
  terrain: 1.2,
  radial: 0.15,
  wander: 0.04,
};
const ORGANIC: Weights = {
  coast: 4,
  grid: 1,
  river: 2,
  terrain: 1.2,
  radial: 2.2,
  wander: 0.05,
};

/**
 * Where the city's plan holds, as fractions of the world side: full over the
 * core and the inner ring, gone a little way past them. Outside it the weights
 * above give way to {@link WEIGHT} and the streamline character of the suburbs,
 * the outskirts and the wilderness returns (spec section 6.1).
 */
const PLAN_HOLD = ZONE_RADII.inner;
const PLAN_FADE = ZONE_RADII.inner * 1.25;

/** How firmly a district holds its own grid, and how far that hold reaches (fraction of the world side). */
const GRID_BY_ZONE: Record<Zone, { hold: number; radius: number; jitter: number }> = {
  // The core districts share one plan, whatever plan the seed drew. Jittering
  // each of the three separately is what broke a long street into three.
  core: { hold: 1, radius: 0.08, jitter: 0 },
  inner: { hold: 0.9, radius: 0.09, jitter: 0.15 },
  industrial: { hold: 0.8, radius: 0.07, jitter: 0.35 },
  suburban: { hold: 0.5, radius: 0.1, jitter: 0.6 },
  outskirts: { hold: 0.2, radius: 0.1, jitter: 1 },
  wilderness: { hold: 0, radius: 0, jitter: 0 },
};

/** Metres between shoreline-distance samples. */
const SHORE_CELL = 20;
/** Half-stencil for the shore normal: two cells, so the field crosses a chamfer crease smoothly. */
const SHORE_STEP = 2 * SHORE_CELL;
/** Distance from the shore over which roads stop caring about it, in metres. */
const COAST_HOLD = 30;
const COAST_REACH = 280;
/** How far a river's pull reaches beyond its own bank, in metres. */
const RIVER_REACH = 260;
/** Half-stencil for the terrain gradient: roads bend over tens of metres, not over one cell. */
const TERRAIN_STEP = 50;
/** Grades between which the contour takes over from the rest of the field. */
const GENTLE_GRADE = 0.05;
const STEEP_GRADE = 0.2;
/** Metres per cycle of the noise that keeps the field from being exactly regular. */
const WANDER_SCALE = 900;

/** The blended field at a point. */
export interface TensorSample {
  /** Direction a road wants to run in, wrapped to (-π/2, π/2]. */
  major: number;
  /** The cross direction, `major + π/2`, wrapped the same way. */
  minor: number;
  /** Anisotropy in [0, 1]: 1 where every influence agrees, 0 where they cancel and no direction is preferred. */
  strength: number;
}

/** One district's grid: a constant street direction with a radius of influence. */
export interface DistrictGrid {
  districtId: number;
  x: number;
  y: number;
  /** The grid's street direction, wrapped to (-π/2, π/2]. */
  angle: number;
  /** Metres over which the hold fades to nothing. */
  radius: number;
  /** Hold at the district site, in [0, 1]. */
  hold: number;
  /** cos 2·angle and sin 2·angle, precomputed because the angle is constant. */
  c2: number;
  s2: number;
}

export class TensorField {
  readonly core: Point;
  /** Grids of the planned districts, in district order. Wilderness districts have none. */
  readonly grids: readonly DistrictGrid[];
  /** The city's dominant street direction; every district grid is a jitter around it. */
  readonly cityAngle: number;
  /**
   * How firmly this city holds its plan, in [0, 1]: 0 an organic city that
   * follows its water and its rings, 1 a planned one whose avenues run straight
   * (spec section 6.1).
   */
  readonly plannedness: number;
  /** cos 2·cityAngle and sin 2·cityAngle, for the plan the whole city shares. */
  private readonly cityC2: number;
  private readonly cityS2: number;
  /** Metres from the core over which the city's plan gives way to the streamline field. */
  private readonly planHold: number;
  private readonly planFade: number;
  private readonly hf: Heightfield;
  /** Signed distance to the shoreline in metres, positive on land, on a coarse grid. */
  private readonly shore: Heightfield;
  private readonly wander: Noise2D;
  /** The two ends of every segment of every river, and how far its pull reaches. */
  private readonly riverFrom: readonly Point[];
  private readonly riverTo: readonly Point[];
  private readonly riverReach: readonly number[];
  /** cos 2θ and sin 2θ of each river segment's own direction, one per segment. */
  private readonly riverC2: Float64Array;
  private readonly riverS2: Float64Array;
  private readonly radialInner: number;
  private readonly radialPeak: number;
  private readonly radialOuter: number;
  /** Scratch for {@link sample} and {@link majorAt}: (a, b, total weight). Reused, never escapes. */
  private readonly acc = new Float64Array(3);
  /** Scratch for one influence of {@link accumulate}, as the helpers that sum it leave it. Reused, never escapes. */
  private readonly part = new Float64Array(3);

  constructor(world: WorldSkeleton) {
    const size = world.size;
    this.core = world.core;
    this.hf = new Heightfield(world.terrain);
    this.shore = buildShoreField(this.hf, world.water.seaLevel);
    this.wander = new Noise2D(world.seed ^ 0x2f11);
    const from: Point[] = [];
    const to: Point[] = [];
    const reach: number[] = [];
    for (const river of world.water.rivers) {
      for (let i = 0; i + 1 < river.path.length; i++) {
        from.push(river.path[i] as Point);
        to.push(river.path[i + 1] as Point);
        reach.push((river.halfWidths[i] as number) + RIVER_REACH);
      }
    }
    this.riverFrom = from;
    this.riverTo = to;
    this.riverReach = reach;
    this.riverC2 = new Float64Array(from.length);
    this.riverS2 = new Float64Array(from.length);
    for (let i = 0; i < from.length; i++) {
      const p = from[i] as Point;
      const q = to[i] as Point;
      const vx = q.x - p.x;
      const vy = q.y - p.y;
      const len2 = vx * vx + vy * vy;
      if (len2 === 0) continue;
      this.riverC2[i] = (vx * vx - vy * vy) / len2;
      this.riverS2[i] = (2 * vx * vy) / len2;
    }
    this.radialInner = size * 0.02;
    this.radialPeak = size * 0.09;
    this.radialOuter = size * 0.3;

    const rng = genRng(world.seed, Subsystem.Roads, 0);
    this.cityAngle = rng.range(-HALF_PI, HALF_PI);
    // Smoothstep of a uniform draw, so most seeds land near one end of the
    // range and few in the middle: a city half planned reads as neither.
    const u = rng.float();
    this.plannedness = u * u * (3 - 2 * u);
    this.cityC2 = cos(2 * this.cityAngle);
    this.cityS2 = sin(2 * this.cityAngle);
    this.planHold = size * PLAN_HOLD;
    this.planFade = size * PLAN_FADE;
    const grids: DistrictGrid[] = [];
    for (const d of world.districts) {
      const spec = GRID_BY_ZONE[d.zone];
      if (spec.hold <= 0) continue;
      // Inside the city a planned seed lets no district turn off the plan; the
      // jitter of the suburbs and the outskirts is left alone.
      const spread = d.zone === 'inner' ? spec.jitter * (1 - this.plannedness) : spec.jitter;
      const jitter = genRng(world.seed, Subsystem.Roads, d.id + 1).range(-spread, spread);
      const angle = wrapDirection(this.cityAngle + jitter);
      grids.push({
        districtId: d.id,
        x: d.x,
        y: d.y,
        angle,
        radius: size * spec.radius,
        // A dense district holds its grid harder than a sparse one of the same zone.
        hold: spec.hold * (0.6 + 0.4 * d.density),
        c2: cos(2 * angle),
        s2: sin(2 * angle),
      });
    }
    this.grids = grids;
  }

  /** The blended field at a point. */
  sample(x: number, y: number): TensorSample {
    const acc = this.accumulate(x, y);
    const a = acc[0] as number;
    const b = acc[1] as number;
    const total = acc[2] as number;
    const mag = hypot(a, b);
    const major = mag > 0 ? wrapDirection(0.5 * atan2(b, a)) : 0;
    return { major, minor: wrapDirection(major + HALF_PI), strength: total > 0 ? clamp(mag / total, 0, 1) : 0 };
  }

  /**
   * How much the city's plan holds at a point, in [0, 1]: 1 over the core and
   * the inner ring, 0 past them. Multiplied by {@link plannedness} it says how
   * far the ground here is a grid rather than a streamline field.
   */
  planHolds(x: number, y: number): number {
    const d = hypot(x - this.core.x, y - this.core.y);
    return 1 - smoothstep(this.planHold, this.planFade, d);
  }

  /** Just the major direction: the hot path for tracing streamlines. */
  majorAt(x: number, y: number): number {
    const acc = this.accumulate(x, y);
    const a = acc[0] as number;
    const b = acc[1] as number;
    return a === 0 && b === 0 ? 0 : wrapDirection(0.5 * atan2(b, a));
  }

  /**
   * Sum every influence into `acc` as (a, b, total weight).
   *
   * A direction that arrives as a vector never goes through `atan2`: for `v`,
   * `cos 2θ = (vx² − vy²)/|v|²` and `sin 2θ = 2·vx·vy/|v|²`, and turning the
   * direction by π/2 just negates both.
   */
  private accumulate(x: number, y: number): Float64Array {
    let a = 0;
    let b = 0;
    let total = 0;

    const cx = x - this.core.x;
    const cy = y - this.core.y;
    const cd2 = cx * cx + cy * cy;
    const dCore = Math.sqrt(cd2);

    // Inside the core and the inner ring the city's plan sets the weights, at
    // whichever end of the range the seed drew. Past the ring they fade back to
    // the streamline field the rest of the map runs on.
    const inCity = 1 - smoothstep(this.planHold, this.planFade, dCore);
    const p = this.plannedness;
    const wGrid = lerp(WEIGHT.grid, lerp(ORGANIC.grid, PLANNED.grid, p), inCity);
    const wCoast = lerp(WEIGHT.coast, lerp(ORGANIC.coast, PLANNED.coast, p), inCity);
    const wRiver = lerp(WEIGHT.river, lerp(ORGANIC.river, PLANNED.river, p), inCity);
    const wTerrain = lerp(WEIGHT.terrain, lerp(ORGANIC.terrain, PLANNED.terrain, p), inCity);
    const wRadial = lerp(WEIGHT.radial, lerp(ORGANIC.radial, PLANNED.radial, p), inCity);
    const wWander = lerp(WEIGHT.wander, lerp(ORGANIC.wander, PLANNED.wander, p), inCity);

    // District grids: planned blocks hold their own street direction. Overlapping
    // districts share one budget, so a cluster of them never outweighs the coast.
    // The city's own plan is one more grid, the one that covers the whole of the
    // core and the inner ring rather than a disc around a district site: without
    // it the ground between two sites holds no plan at all.
    const part = this.part;
    this.gridSum(x, y, inCity);
    const ga = part[0] as number;
    const gb = part[1] as number;
    const gw = part[2] as number;
    if (gw > 0) {
      const scale = wGrid / Math.max(1, gw);
      a += ga * scale;
      b += gb * scale;
      total += wGrid * Math.min(1, gw);
    }

    // Radial: avenues run out of the core, ring roads around it.
    const radial = wRadial * smoothstep(0, this.radialInner, dCore) * (1 - smoothstep(this.radialPeak, this.radialOuter, dCore));
    if (radial > 0 && cd2 > 0) {
      a += (radial * (cx * cx - cy * cy)) / cd2;
      b += (radial * 2 * cx * cy) / cd2;
      total += radial;
    }

    // Terrain: on steep ground roads follow the contour, perpendicular to the gradient.
    const gx = this.hf.sample(x + TERRAIN_STEP, y) - this.hf.sample(x - TERRAIN_STEP, y);
    const gy = this.hf.sample(x, y + TERRAIN_STEP) - this.hf.sample(x, y - TERRAIN_STEP);
    const rise2 = gx * gx + gy * gy;
    const terrain = wTerrain * smoothstep(GENTLE_GRADE, STEEP_GRADE, Math.sqrt(rise2) / (2 * TERRAIN_STEP));
    if (terrain > 0 && rise2 > 0) {
      a -= (terrain * (gx * gx - gy * gy)) / rise2;
      b -= (terrain * 2 * gx * gy) / rise2;
      total += terrain;
    }

    // Coast: near the water, roads run along the shore. The shoreline is a level
    // set of the signed distance field, so its gradient is the shore normal.
    const coast = wCoast * (1 - smoothstep(COAST_HOLD, COAST_REACH, Math.abs(this.shore.sample(x, y))));
    if (coast > 0 && this.coastPull(x, y, coast)) {
      a -= part[0] as number;
      b -= part[1] as number;
      total += part[2] as number;
    }

    // River banks pull the same way a coast does; nearby segments share one budget
    // so a meander doubling back on itself does not count twice.
    this.riverSum(x, y);
    const ra = part[0] as number;
    const rb = part[1] as number;
    const rw = part[2] as number;
    if (rw > 0) {
      const scale = wRiver / Math.max(1, rw);
      a += ra * scale;
      b += rb * scale;
      total += wRiver * Math.min(1, rw);
    }

    // A slow wander, so that even a flat inland grid bends a little.
    const t = 2 * Math.PI * this.wander.fbm(x / WANDER_SCALE + 5.5, y / WANDER_SCALE + 2.25, 3);
    a += wWander * cos(t);
    b += wWander * sin(t);
    total += wWander;

    const acc = this.acc;
    acc[0] = a;
    acc[1] = b;
    acc[2] = total;
    return acc;
  }

  /**
   * The district grids and the city's own plan, summed into `part` as (a, b,
   * weight). The city's plan comes first, weighted by `inCity`.
   */
  private gridSum(x: number, y: number, inCity: number): void {
    let ga = inCity * this.cityC2;
    let gb = inCity * this.cityS2;
    let gw = inCity;
    for (const g of this.grids) {
      const dx = x - g.x;
      const dy = y - g.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= g.radius * g.radius) continue;
      const w = g.hold * (1 - smoothstep(0, g.radius, Math.sqrt(d2)));
      ga += w * g.c2;
      gb += w * g.s2;
      gw += w;
    }
    const part = this.part;
    part[0] = ga;
    part[1] = gb;
    part[2] = gw;
  }

  /**
   * The pull of the shore, `coast` at full strength, into `part` as the (a, b)
   * to take away and the weight to add. False where the shore lets go.
   */
  private coastPull(x: number, y: number, coast: number): boolean {
    const nx = this.shore.sample(x + SHORE_STEP, y) - this.shore.sample(x - SHORE_STEP, y);
    const ny = this.shore.sample(x, y + SHORE_STEP) - this.shore.sample(x, y - SHORE_STEP);
    const n2 = nx * nx + ny * ny;
    // Where the distance field folds — the middle of a bay, a nook between two
    // shores — opposite normals cancel and the gradient shortens. There is no
    // one shore to run along there, so the coast lets go instead of spinning.
    const along = smoothstep(0.35, 0.75, Math.sqrt(n2) / (2 * SHORE_STEP));
    if (!(n2 > 0 && along > 0)) return false;
    const w = coast * along;
    const part = this.part;
    part[0] = (w * (nx * nx - ny * ny)) / n2;
    part[1] = (w * 2 * nx * ny) / n2;
    part[2] = w;
    return true;
  }

  /** The river banks near a place, summed into `part` as (a, b, weight). */
  private riverSum(x: number, y: number): void {
    const from = this.riverFrom;
    let ra = 0;
    let rb = 0;
    let rw = 0;
    for (let i = 0; i < from.length; i++) {
      const p = from[i] as Point;
      const q = this.riverTo[i] as Point;
      const reach = this.riverReach[i] as number;
      if (x < Math.min(p.x, q.x) - reach || x > Math.max(p.x, q.x) + reach) continue;
      if (y < Math.min(p.y, q.y) - reach || y > Math.max(p.y, q.y) + reach) continue;
      const w = 1 - smoothstep(0, reach, segmentDistance(x, y, p, q));
      if (w <= 0) continue;
      ra += w * (this.riverC2[i] as number);
      rb += w * (this.riverS2[i] as number);
      rw += w;
    }
    const part = this.part;
    part[0] = ra;
    part[1] = rb;
    part[2] = rw;
  }
}

/** Build the tensor field of a world. Pure: same world, same field. */
export function buildTensorField(world: WorldSkeleton): TensorField {
  return new TensorField(world);
}

/**
 * Signed distance to the shoreline, positive on land and negative at sea, held
 * in a heightfield of its own so it can be sampled and differentiated. Two
 * chamfer passes over the wet mask; far cheaper than searching per sample, and
 * smooth enough that its gradient is a usable shore normal.
 */
function buildShoreField(hf: Heightfield, seaLevel: number): Heightfield {
  const gridSize = Math.round(hf.extent / SHORE_CELL) + 1;
  const field = Heightfield.create(gridSize, SHORE_CELL);
  const wet = new Uint8Array(gridSize * gridSize);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) {
      wet[iy * gridSize + ix] = hf.sample(field.worldX(ix), field.worldY(iy)) < seaLevel ? 1 : 0;
    }
  }
  const toWater = chamfer(wet, gridSize, 1);
  const toLand = chamfer(wet, gridSize, 0);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) {
      const i = iy * gridSize + ix;
      field.set(ix, iy, ((toWater[i] as number) - (toLand[i] as number)) * SHORE_CELL);
    }
  }
  return field;
}

/** Two-pass chamfer distance in cells from every cell whose mask is `from`. */
function chamfer(mask: Uint8Array, n: number, from: number): Float32Array {
  const far = n * 2;
  const d = new Float32Array(n * n);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] === from ? 0 : far;
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) relaxForward(d, n, ix, iy);
  }
  for (let iy = n - 1; iy >= 0; iy--) {
    for (let ix = n - 1; ix >= 0; ix--) relaxBackward(d, n, ix, iy);
  }
  return d;
}

/** Take cell `i` down to the distance through cell `j`, a step of `cost` away, where that is shorter. */
function relax(d: Float32Array, i: number, j: number, cost: number): void {
  const v = (d[j] as number) + cost;
  if (v < (d[i] as number)) d[i] = v;
}

/** The forward pass of {@link chamfer} at one cell: from the cells before it. */
function relaxForward(d: Float32Array, n: number, ix: number, iy: number): void {
  const i = iy * n + ix;
  if (ix > 0) relax(d, i, i - 1, 1);
  if (iy > 0) {
    relax(d, i, i - n, 1);
    if (ix > 0) relax(d, i, i - n - 1, Math.SQRT2);
    if (ix < n - 1) relax(d, i, i - n + 1, Math.SQRT2);
  }
}

/** The backward pass of {@link chamfer} at one cell: from the cells after it. */
function relaxBackward(d: Float32Array, n: number, ix: number, iy: number): void {
  const i = iy * n + ix;
  if (ix < n - 1) relax(d, i, i + 1, 1);
  if (iy < n - 1) {
    relax(d, i, i + n, 1);
    if (ix < n - 1) relax(d, i, i + n + 1, Math.SQRT2);
    if (ix > 0) relax(d, i, i + n - 1, Math.SQRT2);
  }
}
