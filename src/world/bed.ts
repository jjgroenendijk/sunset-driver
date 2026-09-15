/**
 * The line each road drives: its bed (spec sections 6.1, 7.1).
 *
 * Between junctions a bed is the natural ground under the curve's own points,
 * straight between them, plus whatever `RoadCurve.lift` carries the road over
 * the ground by. At a junction it is not: every road that meets there
 * would otherwise keep its own grade up to the node, and the ground under the
 * junction would be creased where two beds meet, a step no flat surface can
 * be laid over. So a junction is one plane. It passes through the node at the
 * height of the ground there and tilts the way the roads leaving it tilt, fitted
 * by least squares, and each road follows that plane out to its cut and then
 * blends back onto its own line over as far again.
 *
 * This is the one place the bed is defined. The carve cuts its bench to it and
 * the ribbons loft the surface onto it, so the ground and the road agree by
 * construction. Pure: the same terrain, roads and junctions give the same beds.
 */
import { lerp } from '../core/math.ts';
import { Heightfield } from './heightfield.ts';
import { alongCurve, type JunctionMap, type JunctionMouth } from './junctions.ts';
import { curveDistances } from './ribbon.ts';
import type { HeightfieldData, Point, RoadCurve } from './types.ts';

/** How far past its cut, in cuts, a road takes to get back onto its own line. */
const BLEND_CUTS = 1;

/** Metres a mouth has to be cut back for its grade to say anything about the plane. */
const MIN_FIT_CUT = 0.5;

/**
 * How well spanned a direction has to be for the fit to tilt the plane along
 * it. Two roads that leave a node in one line, or at a shallow angle, say
 * nothing about the tilt across them; a fit that solved for it anyway would
 * answer with the difference of their grades divided by almost nothing.
 */
const MIN_SPAN = 0.5;

/** A knot of a bed profile: how far along its segment it stands, and the bed height there. */
interface Knot {
  t: number;
  h: number;
}

/** The bed of one curve. */
class CurveBed {
  /** The bed height at each point of the curve. */
  readonly heights: Float64Array;
  /** Knots inside a segment, ascending in `t`, for the segments a junction plane ends in. */
  readonly inner: (Knot[] | undefined)[];

  constructor(count: number) {
    this.heights = new Float64Array(count);
    this.inner = new Array<Knot[] | undefined>(Math.max(0, count - 1)).fill(undefined);
  }

  heightAt(segment: number, t: number): number {
    const from = this.heights[segment] as number;
    const to = this.heights[segment + 1] as number;
    const knots = this.inner[segment];
    if (knots === undefined) return lerp(from, to, t);
    let lastT = 0;
    let lastH = from;
    for (const knot of knots) {
      if (t <= knot.t) return knot.t === lastT ? knot.h : lerp(lastH, knot.h, (t - lastT) / (knot.t - lastT));
      lastT = knot.t;
      lastH = knot.h;
    }
    return lastT === 1 ? lastH : lerp(lastH, to, (t - lastT) / (1 - lastT));
  }

  /** The knots of a segment from its start to its end, both included. */
  knotsOf(segment: number): Knot[] {
    return [{ t: 0, h: this.heights[segment] as number }, ...(this.inner[segment] ?? []), { t: 1, h: this.heights[segment + 1] as number }];
  }
}

/** The plane one junction is levelled to: its height at the node, and how it tilts. */
export interface JunctionPlane {
  x: number;
  y: number;
  level: number;
  /** Rise per metre along x and along y. */
  gx: number;
  gy: number;
}

/** The beds of a whole road network, built once and asked about a place at a time. */
export class RoadBeds {
  private readonly curves: (CurveBed | undefined)[] = [];
  /** The plane of each junction, in the order the junctions were given. Empty without them. */
  readonly planes: JunctionPlane[] = [];

  constructor(terrain: HeightfieldData, roads: readonly RoadCurve[], junctions?: JunctionMap) {
    const hf = new Heightfield(terrain);
    const distances: (Float32Array | undefined)[] = [];
    const fixed: (Uint8Array | undefined)[] = [];
    for (const road of roads) {
      const bed = new CurveBed(road.points.length);
      for (let i = 0; i < road.points.length; i++) {
        const p = road.points[i] as Point;
        // A road carried over another one stands off the ground it was traced
        // on; the lift is the only thing that says so (`overpass.ts`).
        bed.heights[i] = hf.sample(p.x, p.y) + (road.lift?.[i] ?? 0);
      }
      this.curves[road.id] = bed;
      distances[road.id] = curveDistances(road.points);
      fixed[road.id] = new Uint8Array(road.points.length);
    }
    if (junctions === undefined) return;
    for (const junction of junctions.junctions) {
      const node = { x: junction.x, y: junction.y };
      const level = hf.sample(node.x, node.y);
      const plane = planeOf(hf, node, level, junction.mouths);
      this.planes.push({ x: node.x, y: node.y, level, gx: plane.x, gy: plane.y });
      for (const mouth of junction.mouths) {
        const road = roads[mouth.curve] as RoadCurve;
        const bed = this.curves[road.id] as CurveBed;
        this.follow(road, bed, distances[road.id] as Float32Array, fixed[road.id] as Uint8Array, hf, mouth, node, level, plane);
      }
    }
  }

  /** The bed height at `t` along segment `segment` of curve `curve`. */
  heightAt(curve: number, segment: number, t: number): number {
    return this.bed(curve).heightAt(segment, t);
  }

  /** The bed height at a point of a curve. */
  pointHeight(curve: number, point: number): number {
    return this.bed(curve).heights[point] as number;
  }

  /** The knots of one segment, from its start to its end, as `carve.ts` files them. */
  knotsOf(curve: number, segment: number): { t: number; h: number }[] {
    return this.bed(curve).knotsOf(segment);
  }

  private bed(curve: number): CurveBed {
    const bed = this.curves[curve];
    if (bed === undefined) throw new Error(`no road curve ${curve}`);
    return bed;
  }

  /**
   * Lay one mouth of a junction on the junction's plane out to its cut, and
   * blend it back onto its own line past that. A point the plane fixes stays
   * fixed; a point only a blend moved gives way to a plane that reaches it.
   */
  private follow(
    road: RoadCurve,
    bed: CurveBed,
    distances: Float32Array,
    fixed: Uint8Array,
    hf: Heightfield,
    mouth: JunctionMouth,
    node: Point,
    level: number,
    plane: Point,
  ): void {
    const onPlane = (p: Point): number => level + plane.x * (p.x - node.x) + plane.y * (p.y - node.y);
    const start = distances[mouth.point] as number;
    const along = (i: number): number => Math.abs((distances[i] as number) - start);
    const cutHeight = onPlane(mouth.at);
    const blendEnd = mouth.cut * (1 + BLEND_CUTS);

    // The points inside the cut take the plane; the cut itself is a knot.
    fixed[mouth.point] = 1;
    bed.heights[mouth.point] = level;
    let i = mouth.point + mouth.direction;
    while (i >= 0 && i < road.points.length && along(i) < mouth.cut) {
      fixed[i] = 1;
      bed.heights[i] = onPlane(road.points[i] as Point);
      i += mouth.direction;
    }
    if (i >= 0 && i < road.points.length && along(i) === mouth.cut) {
      // The cut falls on a point of the curve, which is the knot then.
      fixed[i] = 1;
      bed.heights[i] = cutHeight;
      i += mouth.direction;
    } else if (mouth.cut > 0) {
      const a = road.points[mouth.segment] as Point;
      const b = road.points[mouth.segment + 1] as Point;
      const t = fractionAlong(a, b, mouth.at);
      const knots = bed.inner[mouth.segment] ?? [];
      knots.push({ t, h: cutHeight });
      knots.sort((p, q) => p.t - q.t);
      bed.inner[mouth.segment] = knots;
    }
    // The blend: the cut stands off the natural ground by some height, and
    // that offset falls away to nothing where the blend ends. The points
    // inside the blend take their share of it, and the end is a knot of its
    // own, so a long segment past the cut is not tilted all the way along.
    if (blendEnd <= mouth.cut) return;
    const offset = cutHeight - hf.sample(mouth.at.x, mouth.at.y);
    for (let k = i; k >= 0 && k < road.points.length && along(k) < blendEnd; k += mouth.direction) {
      if (fixed[k] === 1) continue;
      const p = road.points[k] as Point;
      const share = (along(k) - mouth.cut) / (blendEnd - mouth.cut);
      bed.heights[k] = hf.sample(p.x, p.y) + offset * (1 - share);
    }
    const end = alongCurve(road.points, mouth.point, mouth.direction, blendEnd);
    const a = road.points[end.segment] as Point;
    const b = road.points[end.segment + 1] as Point;
    const t = fractionAlong(a, b, end.at);
    if (t <= 0 || t >= 1) return;
    const knots = bed.inner[end.segment] ?? [];
    knots.push({ t, h: hf.sample(end.at.x, end.at.y) });
    knots.sort((p, q) => p.t - q.t);
    bed.inner[end.segment] = knots;
  }
}

/**
 * The tilt of the plane a junction is levelled to: the gradient that fits the
 * grade every mouth leaves the node at, in the least-squares sense. A flat
 * road across a climbing one gives a plane that tilts along the climbing road
 * and is level along the flat one, which is what both of them asked for.
 *
 * The normal equations are solved along their own two axes, so a direction the
 * mouths barely span is left level rather than solved for, and the plane is
 * never tilted more steeply than the steepest road leaving the node.
 */
function planeOf(hf: Heightfield, node: Point, level: number, mouths: readonly JunctionMouth[]): Point {
  let axx = 0;
  let axy = 0;
  let ayy = 0;
  let bx = 0;
  let by = 0;
  let steepest = 0;
  for (const mouth of mouths) {
    if (mouth.cut < MIN_FIT_CUT) continue;
    const grade = (hf.sample(mouth.at.x, mouth.at.y) - level) / mouth.cut;
    steepest = Math.max(steepest, Math.abs(grade));
    axx += mouth.dx * mouth.dx;
    axy += mouth.dx * mouth.dy;
    ayy += mouth.dy * mouth.dy;
    bx += mouth.dx * grade;
    by += mouth.dy * grade;
  }
  // The eigenvectors of the symmetric 2 x 2 matrix: the axis the mouths span
  // most, and the one across it.
  const half = (axx + ayy) / 2;
  const spread = Math.hypot((axx - ayy) / 2, axy);
  const major = half + spread;
  const minor = half - spread;
  let ex = axy;
  let ey = major - axx;
  if (Math.hypot(ex, ey) < 1e-12) {
    ex = axx >= ayy ? 1 : 0;
    ey = axx >= ayy ? 0 : 1;
  }
  const length = Math.hypot(ex, ey);
  ex /= length;
  ey /= length;
  const alongMajor = major < MIN_SPAN ? 0 : (bx * ex + by * ey) / major;
  const alongMinor = minor < MIN_SPAN ? 0 : (bx * -ey + by * ex) / minor;
  let gx = ex * alongMajor - ey * alongMinor;
  let gy = ey * alongMajor + ex * alongMinor;
  const tilt = Math.hypot(gx, gy);
  if (tilt > steepest && tilt > 0) {
    gx *= steepest / tilt;
    gy *= steepest / tilt;
  }
  return { x: gx, y: gy };
}

/** How far along a segment a place on it stands, in [0, 1]. */
function fractionAlong(a: Point, b: Point, at: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const squared = dx * dx + dy * dy;
  if (squared === 0) return 0;
  return Math.min(1, Math.max(0, ((at.x - a.x) * dx + (at.y - a.y) * dy) / squared));
}
