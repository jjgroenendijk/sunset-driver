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
 * blends back onto its own line over as far again. The road tilts across as the
 * plane does inside its cut, and levels out over the blend.
 *
 * This is the one place the surface height is defined. The carve cuts its bench
 * to it, the ribbons loft the road onto it and the junction rings stand on it,
 * so the ground and the road agree by construction. Pure: the same terrain, roads and junctions give the same beds.
 */
import { hypot } from '../core/libm.ts';
import { lerp } from '../core/math.ts';
import { Heightfield } from './heightfield.ts';
import type { JunctionMap, JunctionMouth } from './junctions.ts';
import { curveDistances } from './ribbon.ts';
import type { HeightfieldData, Point, RoadCurve } from './types.ts';

/** How far past its cut, in cuts, a road takes to get back onto its own line. */
export const BLEND_CUTS = 1;

/** Metres a mouth has to be cut back for its grade to say anything about the plane. */
const MIN_FIT_CUT = 0.5;

/**
 * How well spanned a direction has to be for the fit to tilt the plane along
 * it. Two roads that leave a node in one line, or at a shallow angle, say
 * nothing about the tilt across them; a fit that solved for it anyway would
 * answer with the difference of their grades divided by almost nothing.
 */
const MIN_SPAN = 0.5;

/** The natural ground under a place: the terrain, with no road on it. */
export type Ground = (x: number, y: number) => number;

/**
 * A knot of a bed profile: how far along its segment it stands, the bed height
 * on the centreline there, and how the surface tilts there. The tilt is rise per
 * metre along x and along y of the map, so the surface a metre off the
 * centreline stands `gx * dx + gy * dy` above the bed whichever way the road
 * runs.
 */
export interface Knot {
  t: number;
  h: number;
  gx: number;
  gy: number;
}

/** The bed of one curve. */
class CurveBed {
  /** The bed height at each point of the curve, and the tilt of the surface there. */
  readonly heights: Float64Array;
  readonly tiltX: Float64Array;
  readonly tiltY: Float64Array;
  /** Knots inside a segment, ascending in `t`, for the segments a junction plane ends in. */
  readonly inner: (Knot[] | undefined)[];

  constructor(count: number) {
    this.heights = new Float64Array(count);
    this.tiltX = new Float64Array(count);
    this.tiltY = new Float64Array(count);
    this.inner = new Array<Knot[] | undefined>(Math.max(0, count - 1)).fill(undefined);
  }

  /** The knot a point of the curve is. */
  point(i: number, t: number): Knot {
    return { t, h: this.heights[i] as number, gx: this.tiltX[i] as number, gy: this.tiltY[i] as number };
  }

  /** The profile at `t` along a segment: straight between its knots. */
  at(segment: number, t: number): Knot {
    let last = this.point(segment, 0);
    for (const knot of [...(this.inner[segment] ?? []), this.point(segment + 1, 1)]) {
      if (t <= knot.t) {
        if (knot.t === last.t) return { ...knot, t };
        const share = (t - last.t) / (knot.t - last.t);
        return { t, h: lerp(last.h, knot.h, share), gx: lerp(last.gx, knot.gx, share), gy: lerp(last.gy, knot.gy, share) };
      }
      last = knot;
    }
    return { ...last, t };
  }

  /** The knots of a segment from its start to its end, both included. */
  knotsOf(segment: number): Knot[] {
    return [this.point(segment, 0), ...(this.inner[segment] ?? []), this.point(segment + 1, 1)];
  }

  /** Add a knot inside a segment, keeping the knots in order. */
  insert(segment: number, knot: Knot): void {
    const knots = this.inner[segment] ?? [];
    knots.push(knot);
    knots.sort((p, q) => p.t - q.t);
    this.inner[segment] = knots;
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

/** The height of a junction's plane at a place. */
export function planeHeight(plane: JunctionPlane, x: number, y: number): number {
  return plane.level + plane.gx * (x - plane.x) + plane.gy * (y - plane.y);
}

/**
 * The height of the drivable surface `dx, dy` metres off a place of a bed,
 * where the bed stands at `h` and tilts by `gx, gy` (see {@link Knot}). This is
 * the one rule for how high a road surface stands off its centreline: the loft
 * and the junction rings read it through `RoadFrame.bank`, and the carve here.
 * Scalars rather than a knot, because the carve asks it for every place.
 */
export function surfaceHeight(h: number, gx: number, gy: number, dx: number, dy: number): number {
  return h + gx * dx + gy * dy;
}

/**
 * The beds of a whole road network, built once and asked about a place at a time.
 *
 * Together with the planes this is the one surface height function of the
 * network. A junction's surface is its plane. A road's surface is its bed on
 * the centreline and tilts across the road: level away from a junction, tilted
 * as the plane is inside a mouth's cut, and back to level where the blend ends.
 * So the section a road's loft ends on at a mouth lies on the junction's plane.
 */
export class RoadBeds {
  private readonly curves: (CurveBed | undefined)[] = [];
  /** The plane of each junction, in the order the junctions were given. Empty without them. */
  readonly planes: JunctionPlane[] = [];
  /** The plane of each junction, filed under its node. */
  private readonly byNode: (JunctionPlane | undefined)[] = [];

  constructor(terrain: HeightfieldData, roads: readonly RoadCurve[], junctions?: JunctionMap) {
    const hf = new Heightfield(terrain);
    const ground: Ground = (x, y) => hf.sample(x, y);
    const distances: (Float32Array | undefined)[] = [];
    const fixed: (Uint8Array | undefined)[] = [];
    /** Each curve's own line, before any junction moved it: what a blend returns to. */
    const own: (Float64Array | undefined)[] = [];
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
      own[road.id] = bed.heights.slice();
    }
    if (junctions === undefined) return;
    for (const junction of junctions.junctions) {
      const node = { x: junction.x, y: junction.y };
      const fitted = junctionPlane(ground, node, junction.mouths);
      const level = fitted.level;
      const plane = { x: fitted.gx, y: fitted.gy };
      this.planes.push(fitted);
      this.byNode[junction.node] = fitted;
      for (const mouth of junction.mouths) {
        const road = roads[mouth.curve] as RoadCurve;
        const bed = this.curves[road.id] as CurveBed;
        this.follow(road, bed, distances[road.id] as Float32Array, fixed[road.id] as Uint8Array, own[road.id] as Float64Array, mouth, node, level, plane);
      }
    }
  }

  /** The bed height at `t` along segment `segment` of curve `curve`. */
  heightAt(curve: number, segment: number, t: number): number {
    return this.bed(curve).at(segment, t).h;
  }

  /** The profile at `t` along segment `segment` of curve `curve`: the bed and its tilt. */
  profileAt(curve: number, segment: number, t: number): Knot {
    return this.bed(curve).at(segment, t);
  }

  /** The bed height at a point of a curve. */
  pointHeight(curve: number, point: number): number {
    return this.bed(curve).heights[point] as number;
  }

  /** The profile at a point of a curve. */
  pointProfile(curve: number, point: number): Knot {
    return this.bed(curve).point(point, 0);
  }

  /** The knots of one segment, from its start to its end, as `carve.ts` files them. */
  knotsOf(curve: number, segment: number): Knot[] {
    return this.bed(curve).knotsOf(segment);
  }

  /** The plane of the junction at a node, or undefined where no junction was given there. */
  planeAt(node: number): JunctionPlane | undefined {
    return this.byNode[node];
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
    own: Float64Array,
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
    const lay = (k: number, h: number, share: number): void => {
      bed.heights[k] = h;
      bed.tiltX[k] = plane.x * share;
      bed.tiltY[k] = plane.y * share;
    };

    // The points inside the cut take the plane, tilt and all; the cut itself
    // is a knot.
    fixed[mouth.point] = 1;
    lay(mouth.point, level, 1);
    let i = mouth.point + mouth.direction;
    while (i >= 0 && i < road.points.length && along(i) < mouth.cut) {
      fixed[i] = 1;
      lay(i, onPlane(road.points[i] as Point), 1);
      i += mouth.direction;
    }
    if (i >= 0 && i < road.points.length && along(i) === mouth.cut) {
      // The cut falls on a point of the curve, which is the knot then.
      fixed[i] = 1;
      lay(i, cutHeight, 1);
      i += mouth.direction;
    } else if (mouth.cut > 0) {
      const a = road.points[mouth.segment] as Point;
      const b = road.points[mouth.segment + 1] as Point;
      bed.insert(mouth.segment, { t: fractionAlong(a, b, mouth.at), h: cutHeight, gx: plane.x, gy: plane.y });
    }
    // The blend: the cut stands off the road's own line by some height and
    // tilts as the plane does, and both fall away to nothing where the blend
    // ends. The points inside the blend take their share of it. The blend ends
    // on the first point of the curve at least `blendEnd` from the node, never
    // inside a segment: a road's loft has a section at every point and none
    // between them, so a knot there would stand off the surface drawn over it.
    if (blendEnd <= mouth.cut) return;
    const first = road.points[mouth.segment] as Point;
    const second = road.points[mouth.segment + 1] as Point | undefined;
    const t = second === undefined ? 0 : fractionAlong(first, second, mouth.at);
    const offset = cutHeight - lerp(own[mouth.segment] as number, (own[mouth.segment + 1] ?? own[mouth.segment]) as number, t);
    let end = i;
    while (end >= 0 && end < road.points.length && along(end) < blendEnd) end += mouth.direction;
    const span = end >= 0 && end < road.points.length ? along(end) - mouth.cut : blendEnd - mouth.cut;
    // `end` lies `steps` points from `i` in the mouth's direction.
    const steps = (end - i) * mouth.direction;
    for (let s = 0; s < steps; s++) {
      const k = i + s * mouth.direction;
      if (fixed[k] === 1) continue;
      const share = 1 - (along(k) - mouth.cut) / span;
      lay(k, (own[k] as number) + offset * share, share);
    }
  }
}

/**
 * The plane a junction is levelled to: the height its roads drive at the node,
 * and the tilt that fits its mouths. The crossing plan fits the plane of a node
 * it has not built a junction for yet through the same door (`plane-lift.ts`),
 * so a crossing is decided on the line the road will really drive.
 *
 * The node stands at the ground under it plus the most any road meeting it is
 * carried over that ground (`JunctionMouth.lift`). A road on fill drives over
 * the ground it stands on — the approach to a bridge climbs on an embankment
 * the carve makes up (`road-route.ts`) — and a plane levelled to the ground
 * would dig that approach back down to it and leave a trough at the junction.
 * Every other road at the node climbs to meet it, which is what a street
 * joining an embankment does.
 */
export function junctionPlane(ground: Ground, node: Point, mouths: readonly JunctionMouth[]): JunctionPlane {
  let lift = 0;
  for (const mouth of mouths) lift = Math.max(lift, mouth.lift);
  const level = ground(node.x, node.y) + lift;
  const tilt = planeOf(ground, level, mouths);
  return { x: node.x, y: node.y, level, gx: tilt.x, gy: tilt.y };
}

/**
 * The tilt of the plane a junction is levelled to: the gradient that fits the
 * grade every mouth leaves the node at, in the least-squares sense. A flat
 * road across a climbing one gives a plane that tilts along the climbing road
 * and is level along the flat one, which is what both of them asked for.
 *
 * Each mouth counts by the square of its cut, so the fit gives the least
 * height error at the cuts rather than the least grade error: the same grade
 * error costs a mouth cut 27 m back thirteen times the height it costs one cut
 * 2 m back (issue #676, E2). The weights are scaled to average 1, so
 * {@link MIN_SPAN} reads the same whatever the cuts are.
 *
 * The normal equations are solved along their own two axes, so a direction the
 * mouths barely span is left level rather than solved for, and the plane is
 * never tilted more steeply than the steepest road leaving the node.
 */
function planeOf(ground: Ground, level: number, mouths: readonly JunctionMouth[]): Point {
  let axx = 0;
  let axy = 0;
  let ayy = 0;
  let bx = 0;
  let by = 0;
  let steepest = 0;
  let count = 0;
  let squares = 0;
  for (const mouth of mouths) {
    if (mouth.cut < MIN_FIT_CUT) continue;
    count++;
    squares += mouth.cut * mouth.cut;
  }
  for (const mouth of mouths) {
    if (mouth.cut < MIN_FIT_CUT) continue;
    // The grade of the line the road really drives, which is its own lift over
    // the ground at the cut, against the level of the node.
    const grade = (ground(mouth.at.x, mouth.at.y) + mouth.liftAtCut - level) / mouth.cut;
    const weight = (mouth.cut * mouth.cut * count) / squares;
    steepest = Math.max(steepest, Math.abs(grade));
    axx += weight * mouth.dx * mouth.dx;
    axy += weight * mouth.dx * mouth.dy;
    ayy += weight * mouth.dy * mouth.dy;
    bx += weight * mouth.dx * grade;
    by += weight * mouth.dy * grade;
  }
  // The eigenvectors of the symmetric 2 x 2 matrix: the axis the mouths span
  // most, and the one across it.
  const half = (axx + ayy) / 2;
  const spread = hypot((axx - ayy) / 2, axy);
  const major = half + spread;
  const minor = half - spread;
  let ex = axy;
  let ey = major - axx;
  if (hypot(ex, ey) < 1e-12) {
    ex = axx >= ayy ? 1 : 0;
    ey = axx >= ayy ? 0 : 1;
  }
  const length = hypot(ex, ey);
  ex /= length;
  ey /= length;
  const alongMajor = major < MIN_SPAN ? 0 : (bx * ex + by * ey) / major;
  const alongMinor = minor < MIN_SPAN ? 0 : (bx * -ey + by * ex) / minor;
  let gx = ex * alongMajor - ey * alongMinor;
  let gy = ey * alongMajor + ex * alongMinor;
  const tilt = hypot(gx, gy);
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
