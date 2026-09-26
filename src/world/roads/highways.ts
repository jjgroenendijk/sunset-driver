/**
 * Where the highways go (spec section 6.2): a ring round the core, and the
 * radials that leave it for the rest of the map.
 *
 * No city puts its motorways through the middle of downtown. The ring runs
 * just outside the core, and each radial leaves one of its interchanges and
 * follows the field outward, with a branch off it further out. The highways
 * are still the spine every other road grows off, and every one of them starts
 * on a highway already laid, so they are one network.
 *
 * The ring is traced round a shape rather than along the field. On some seeds
 * that shape is a circle, which the ground bends. On the rest it is a square
 * with rounded corners, its sides along the field at the core, so the ring
 * runs with the grid of streets inside it. Water cuts either,
 * because a highway takes a deck only over ground it may not climb, so where
 * the circle is broken the longest arc of it is kept. Where no arc runs as far
 * as a highway has to — a core on a narrow neck of land — the two old trunks
 * cross the core instead, so no seed goes without a highway.
 *
 * `road-route.ts` plans each highway's decks and slots as it is laid
 * (`highway-plan.ts`). `roads.ts` extends this with every other tier.
 */
import { directionDelta, dist } from '../../core/math.ts';
import { genRng, Subsystem } from '../../core/rng.ts';
import { atan2, cos, sin } from '../../core/libm.ts';
import { ZONE_RADII } from '../terrain/districts.ts';
import {
  alignTo,
  BRANCH_AT,
  HIGHWAY,
  HIGHWAY_MERGE_AFTER,
  INTERCHANGE_SPACING,
  MAX_RADIALS,
  MIN_HIGHWAY,
  MIN_RADIAL,
  polylineLength,
  RADIAL_BRANCH_AT,
  RING_MARGIN,
  RING_STARTS,
  ringOffset,
  RoadTrace,
  SQUARE_RING_SHARE,
  type Ring,
  type TraceOptions,
} from './road-trace.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { Point, RoadCurve } from '../types.ts';

/** The entity id of the roads stream that picks the ring's shape; the district streams take the small ids. */
const RING_SHAPE_STREAM = 0x10000;

/** A highway line before it is laid: the points, and where its two halves meet. */
interface Streamline {
  points: Point[];
  seam: number;
}

/** The ring as traced: its points, where the trace started, and whether it came round to that start. */
interface RingLine {
  points: Point[];
  seam: number;
  closed: boolean;
}

/** A radial as laid, and whether it follows the field's cross direction. */
interface Radial {
  curve: RoadCurve;
  minor: boolean;
}

export abstract class HighwayTrace extends RoadTrace {

  /** The ring, its radials and a branch off each radial, or the two trunks where no ring fits. */
  protected traceHighways(): void {
    const ring = this.layRing();
    if (ring.length === 0) {
      this.traceTrunks();
      return;
    }
    for (const radial of this.layRadials(ring)) {
      for (const at of this.branchPoints(radial.curve, RADIAL_BRANCH_AT)) this.streamline(at, !radial.minor, this.outsideRing);
    }
  }

  /** Metres from the middle of the core to the ring's centreline. */
  private get ringRadius(): number {
    return this.size * ZONE_RADII.core + RING_MARGIN;
  }

  /** Ground past the ring, where a radial and its branches stay. */
  private readonly outsideRing = (x: number, y: number): boolean =>
    dist(x, y, this.world.core.x, this.world.core.y) > this.ringRadius;

  // -------------------------------------------------------------------- ring

  /**
   * The ring, laid as curves: two halves that meet at an interchange at each
   * end where it closes, one arc where water broke it. Empty where no arc runs
   * as far as a highway has to.
   */
  private layRing(): RoadCurve[] {
    // The seed picks the shape. Where that one does not fit, the other may.
    const square = genRng(this.world.seed, Subsystem.Roads, RING_SHAPE_STREAM).float() < SQUARE_RING_SHARE;
    const long = (l: RingLine | undefined): l is RingLine => l !== undefined && polylineLength(l.points) >= MIN_HIGHWAY * this.size;
    let line = this.ringLine(square);
    if (!long(line)) line = this.ringLine(!square);
    if (!long(line)) return [];
    const points = line.points;
    if (!line.closed) {
      const arc = this.addCurve('highway', points, [], interchangesOf(points, line.seam));
      return arc === undefined ? [] : [arc];
    }
    // A curve that ends where it starts is one point shared with itself, so a
    // closed ring is two curves. Each half ends on an interchange, which is
    // where the other half meets it.
    const choices = interchangesOf(points, 0).filter((i) => i > 0 && i < points.length - 1);
    const half = points.length >> 1;
    let split = choices[0] ?? half;
    for (const i of choices) if (Math.abs(i - half) < Math.abs(split - half)) split = i;
    const halves: RoadCurve[] = [];
    for (const piece of [points.slice(0, split + 1), points.slice(split)]) {
      const curve = this.addCurve('highway', piece, [], interchangesOf(piece, 0));
      if (curve !== undefined) halves.push(curve);
    }
    return halves;
  }

  /**
   * The line of the ring, round a circle or a square: traced from each of a
   * few places on it, both ways round, and the first that closes or else the
   * longest arc kept.
   */
  private ringLine(square: boolean): RingLine | undefined {
    const core = this.world.core;
    const radius = this.ringRadius;
    // The ring stays out of the core, all of its footprint.
    const reach = this.size * ZONE_RADII.core + footprintHalfWidth('highway');
    const within = (x: number, y: number): boolean => dist(x, y, core.x, core.y) >= reach;
    const opt: TraceOptions = { params: HIGHWAY, joiner: 'highway', within, mergeAfter: Infinity };
    const major = this.field.majorAt(core.x, core.y);
    const around: Ring = { x: core.x, y: core.y, radius, sweep: 2 * Math.PI, square: square ? major : undefined };
    let best: RingLine | undefined;
    for (let k = 0; k < RING_STARTS; k++) {
      const angle = major + (k * 2 * Math.PI) / RING_STARTS;
      const start = onRing(around, angle);
      if (Math.abs(start.x) > this.half || Math.abs(start.y) > this.half || !this.isDry(start.x, start.y)) continue;
      const ahead = this.trace(start, { ...opt, heading: ringOffset(around, start.x, start.y).out + Math.PI / 2, around });
      const loop = ahead.swept > Math.PI ? this.closeLoop(ahead.points) : undefined;
      if (loop !== undefined) return { points: loop, seam: 0, closed: true };
      // Broken: the other way round, as far as the circle the first half left.
      const rest = 2 * Math.PI - ahead.swept - (2 * HIGHWAY.step) / radius;
      if (rest <= 0) continue;
      const back = this.trace(start, { ...opt, heading: ringOffset(around, start.x, start.y).out - Math.PI / 2, around: { ...around, sweep: rest } });
      back.points.reverse();
      const arc: RingLine = {
        points: [...back.points.slice(0, -1), ...ahead.points],
        seam: back.points.length - 1,
        closed: false,
      };
      if (best === undefined || polylineLength(arc.points) > polylineLength(best.points)) best = arc;
    }
    return best;
  }

  /**
   * A traced ring closed onto its first point, or undefined where the trace
   * stopped short of it. The trace stops a step or two before it gets back,
   * because a streamline that comes near its own points ends there.
   */
  private closeLoop(points: readonly Point[]): Point[] | undefined {
    const first = points[0] as Point;
    let end = points.length - 1;
    while (end > 0 && dist((points[end] as Point).x, (points[end] as Point).y, first.x, first.y) < HIGHWAY.step / 2) end--;
    const last = points[end] as Point;
    if (end < 8 || dist(last.x, last.y, first.x, first.y) > HIGHWAY.step * 2.5) return undefined;
    if (!this.canRun(last.x, last.y, first.x, first.y, HIGHWAY.maxGrade)) return undefined;
    return [...points.slice(0, end + 1), { x: first.x, y: first.y }];
  }

  /**
   * Radials out of the ring's free interchanges, the longest first, up to
   * {@link MAX_RADIALS}. Which way out runs furthest is up to the ground: a
   * core on a narrow island has water a few hundred metres off most of its
   * ring, so the radials go where the land is.
   */
  private layRadials(ring: readonly RoadCurve[]): Radial[] {
    const free: Point[] = [];
    for (const curve of ring) for (const i of this.freeInterchanges(curve)) free.push(curve.points[i] as Point);
    const lines = free.map((at, i) => ({ at, i, length: polylineLength(this.radialLine(at).points) }));
    lines.sort((a, b) => b.length - a.length || a.i - b.i);
    const radials: Radial[] = [];
    for (const line of lines) {
      if (radials.length >= MAX_RADIALS) break;
      // Traced again, because the radials laid before it are in the network now.
      const { points, minor } = this.radialLine(line.at);
      if (polylineLength(points) < MIN_RADIAL * this.size) continue;
      const curve = this.addCurve('highway', points, [], interchangesOf(points, 0));
      if (curve !== undefined) radials.push({ curve, minor });
    }
    return radials;
  }

  /** The line a radial follows out of the ring: whichever of the field's two directions runs nearer the way out. */
  private radialLine(at: Point): { points: Point[]; minor: boolean } {
    const core = this.world.core;
    const out = atan2(at.y - core.y, at.x - core.x);
    const major = this.field.majorAt(at.x, at.y);
    const minor = directionDelta(major, out) > Math.PI / 4;
    const heading = alignTo(minor ? major + Math.PI / 2 : major, out);
    const opt: TraceOptions = { params: HIGHWAY, joiner: 'highway', minor, heading, mergeAfter: HIGHWAY_MERGE_AFTER, within: this.outsideRing };
    return { points: this.trace(at, opt).points, minor };
  }

  // ------------------------------------------------------------------ trunks

  /**
   * Two highways crossing at the core, plus a branch off each arm of them: the
   * network of a seed whose core has no room for a ring. A branch leaves its
   * trunk at one of the trunk's interchanges, because that is the only place a
   * highway takes a junction (spec section 6.2).
   */
  private traceTrunks(): void {
    const core = this.world.core;
    const trunks = [this.streamline(core, false), this.streamline(core, true)];
    // The highways are the spine every other road grows off: the arterials fill
    // between them, and the minor roads between those. A map with no highway at
    // all therefore has no roads at all. So where the ground cuts both trunks
    // short of MIN_HIGHWAY, the longer of the two is laid whatever its length.
    // Nothing was added to the network while they were traced, so the lines are
    // the same two the calls above found.
    if (trunks[0] === undefined && trunks[1] === undefined) {
      const lines = [this.streamlineLine(core, false), this.streamlineLine(core, true)];
      const first = lines[0] as Streamline;
      const second = lines[1] as Streamline;
      const i = polylineLength(second.points) > polylineLength(first.points) ? 1 : 0;
      const best = lines[i] as Streamline;
      if (best.points.length > 1) {
        trunks[i] = this.addCurve('highway', best.points, [], interchangesOf(best.points, best.seam));
      }
    }
    for (let i = 0; i < trunks.length; i++) {
      const trunk = trunks[i];
      if (trunk === undefined) continue;
      for (const at of this.branchPoints(trunk, BRANCH_AT)) this.streamline(at, i === 0);
    }
  }

  /**
   * The interchanges of a highway a new highway may leave it at. One that is a
   * node another road already stands on is not free — a highway seeded there
   * would retrace that road — and neither is an end of the curve.
   */
  private freeInterchanges(curve: RoadCurve): number[] {
    const last = curve.points.length - 1;
    return curve.interchanges.filter((i) => i !== 0 && i !== last && !this.network.sharedAt(curve.id, i));
  }

  /** Where a branch highway leaves its trunk: the free interchange nearest each of the given fractions of its length. */
  private branchPoints(trunk: RoadCurve, fractions: readonly number[]): Point[] {
    return atFractions(trunk.points, this.freeInterchanges(trunk), fractions);
  }

  /**
   * The line a highway would follow through a point: the field line, followed
   * both ways, with the index of the point the two halves meet at.
   */
  private streamlineLine(at: Point, minor: boolean, within?: (x: number, y: number) => boolean): Streamline {
    const line = this.fieldLine(at, minor);
    const opt: TraceOptions = { params: HIGHWAY, joiner: 'highway', minor, mergeAfter: HIGHWAY_MERGE_AFTER, within };
    const forward = this.trace(at, { ...opt, heading: line });
    const backward = this.trace(at, { ...opt, heading: line + Math.PI });
    backward.points.reverse();
    return { points: [...backward.points.slice(0, -1), ...forward.points], seam: backward.points.length - 1 };
  }

  /** One highway: that line, laid as a curve if it runs as far as a highway has to. */
  private streamline(at: Point, minor: boolean, within?: (x: number, y: number) => boolean): RoadCurve | undefined {
    const { points, seam } = this.streamlineLine(at, minor, within);
    if (polylineLength(points) < MIN_HIGHWAY * this.size) return undefined;
    // The point it was seeded at is an interchange, so the road it grew out of
    // and this one meet at a junction both of them allow.
    return this.addCurve('highway', points, [], interchangesOf(points, seam));
  }
}

/** Where the ray from the ring's middle at `angle` meets the ring. */
function onRing(ring: Ring, angle: number): Point {
  const at = (r: number): Point => ({ x: ring.x + cos(angle) * r, y: ring.y + sin(angle) * r });
  let lo = 0;
  let hi = ring.radius * 2;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const p = at(mid);
    if (ringOffset(ring, p.x, p.y).off < 0) lo = mid;
    else hi = mid;
  }
  return at((lo + hi) / 2);
}

/**
 * The points of a highway a junction may stand at: its two ends, the point it
 * was seeded at, and one every {@link INTERCHANGE_SPACING} along it. Ascending.
 * Every other point of a highway takes no junction at all (spec section 6.2).
 */
function interchangesOf(points: readonly Point[], seedIndex: number): number[] {
  const at = new Array<boolean>(points.length).fill(false);
  at[0] = true;
  at[points.length - 1] = true;
  if (seedIndex > 0 && seedIndex < points.length) at[seedIndex] = true;
  let run = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    run += dist(a.x, a.y, b.x, b.y);
    if (run < INTERCHANGE_SPACING) continue;
    run = 0;
    at[i + 1] = true;
  }
  const out: number[] = [];
  for (let i = 0; i < at.length; i++) if (at[i] === true) out.push(i);
  return out;
}

/**
 * Of the points a polyline offers as `choices`, the one nearest each fraction
 * of its length. Each choice is taken at most once, so two fractions never
 * return the same place, and a fraction returns nothing once the choices run
 * out.
 */
function atFractions(points: readonly Point[], choices: readonly number[], fractions: readonly number[]): Point[] {
  const total = polylineLength(points);
  const taken: number[] = [];
  // Distance along the curve of every point, so an interchange can be measured.
  const run: number[] = [0];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    run.push((run[i] as number) + dist(a.x, a.y, b.x, b.y));
  }
  const out: Point[] = [];
  for (const f of fractions) {
    const wanted = total * f;
    let best = -1;
    let bestD = Infinity;
    for (const i of choices) {
      if (taken.includes(i)) continue;
      const d = Math.abs((run[i] as number) - wanted);
      if (d >= bestD) continue;
      bestD = d;
      best = i;
    }
    if (best < 0) continue;
    taken.push(best);
    out.push(points[best] as Point);
  }
  return out;
}
