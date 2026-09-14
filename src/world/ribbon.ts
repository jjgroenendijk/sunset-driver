/**
 * The frame a road surface is swept in (spec sections 6.1, 7.1).
 *
 * Road surfaces, kerbs, decks and tunnels are lofted along the tensor-field
 * curves, so everything drawn on a road needs three numbers at a place on it:
 * how high the bed stands there, which way is across the road, and how far along
 * the curve the place is. This holds all three.
 *
 * The bed is the line the road drives, as `bed.ts` defines it: the natural
 * ground under the curve's own points, straight between them, and the plane of
 * a junction where the road meets one. That is the same line `carve.ts` cuts
 * the bench to, so a surface laid on it sits in the bench the terrain carries.
 *
 * Every answer is a function of the curve and the place, never of the chunk that
 * asked. At a point the tracer laid, the frame is mitred between the two
 * segments that meet there; anywhere else along a segment it is that segment's
 * own. A chunk boundary cuts a segment at a point both sides compute the same
 * way, so both sides get the same frame and the surfaces meet exactly.
 */
import { clamp } from '../core/math.ts';
import { RoadBeds } from './bed.ts';
import type { JunctionMap } from './junctions.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { HeightfieldData, Point, RoadCurve } from './types.ts';

/**
 * Metres a mitre may move the outer corner of a section along the road, and the
 * share of the shorter segment beside the point that it may take.
 *
 * A mitre swings the section round to the bisector of the two segments meeting
 * at a point, which keeps the road its full width through a bend. Swung too
 * far, the corner reaches past the segment beside it and the surface folds over
 * itself. So a bend that asks for more than this room takes no mitre at all:
 * each side keeps its own segment's frame and the surface is cut at the turn.
 * Two runs that overlap through a hairpin still read as road from above; a
 * folded one reads as a hole. `road-mesh.ts` bevels the joint, because the two
 * sides leave a wedge of ground showing on the outside of the turn.
 *
 * The metre limit is what makes the rule survive a chunk boundary. A boundary
 * cuts a segment anywhere along it, so the run beside a mitred point can be far
 * shorter than the segment the share was measured against.
 */
export const MITRE_SHIFT = 0.5;
const MITRE_SHARE = 0.25;

/** Where a place on a road stands, and which way the road runs there. */
export interface RoadFrame {
  /** Height of the road bed, in metres. */
  height: number;
  /** Unit vector across the road, to the left of travel, in the x of the map. */
  acrossX: number;
  /** The same vector in the y of the map. */
  acrossY: number;
  /**
   * How far to stretch a cross section so a bend keeps its width. 1 anywhere
   * along a segment, and more at a point where two of them meet at an angle.
   */
  mitre: number;
  /** Metres from the start of the curve, so a dash pattern can be laid along it. */
  distance: number;
}

/**
 * Metres from the start of a curve at each of its points. This is the one
 * measure of distance along a road: the dash pattern, the street lamps and the
 * junction cuts are all laid out on it, so anything that measures a curve
 * calls this rather than summing the segments itself.
 */
export function curveDistances(points: readonly Point[]): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    out[i + 1] = (out[i] as number) + Math.hypot(b.x - a.x, b.y - a.y);
  }
  return out;
}

/** One curve's frame, sampled at its own points and along its segments. */
class CurveRibbon {
  readonly points: readonly Point[];
  private readonly beds: RoadBeds;
  private readonly curve: number;
  /** Metres from the start of the curve at each point. */
  private readonly distances: Float32Array;
  /** Length of each segment, so a place along one is a multiply. */
  private readonly spans: Float32Array;
  /** Unit direction of each segment, across the road. */
  private readonly segX: Float32Array;
  private readonly segY: Float32Array;
  /** The mitred frame at each point, and whether the point may take it. */
  private readonly pointX: Float32Array;
  private readonly pointY: Float32Array;
  private readonly mitres: Float32Array;
  private readonly mitred: Uint8Array;
  private readonly standing: Uint8Array;
  private readonly bridged: Uint8Array;
  private readonly bored: Uint8Array;

  constructor(beds: RoadBeds, road: RoadCurve) {
    const points = road.points;
    const n = points.length;
    const segments = Math.max(0, n - 1);
    this.points = points;
    this.beds = beds;
    this.curve = road.id;
    this.spans = new Float32Array(segments);
    this.segX = new Float32Array(segments);
    this.segY = new Float32Array(segments);
    this.pointX = new Float32Array(n);
    this.pointY = new Float32Array(n);
    this.mitres = new Float32Array(n);
    this.mitred = new Uint8Array(n);
    this.bridged = new Uint8Array(segments);
    this.bored = new Uint8Array(segments);
    this.standing = new Uint8Array(segments).fill(1);
    for (const i of road.bridges) {
      if (i >= 0 && i < segments) {
        this.bridged[i] = 1;
        this.standing[i] = 0;
      }
    }
    for (const i of road.tunnels) {
      if (i >= 0 && i < segments) {
        this.bored[i] = 1;
        this.standing[i] = 0;
      }
    }

    this.distances = curveDistances(points);
    for (let i = 0; i < segments; i++) {
      const a = points[i] as Point;
      const b = points[i + 1] as Point;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const span = Math.hypot(dx, dy);
      this.spans[i] = span;
      // Across the road is to the left of travel. A curve that stands still
      // says nothing about direction, so it borrows the segment before it.
      if (span > 0) {
        this.segX[i] = -dy / span;
        this.segY[i] = dx / span;
      } else if (i > 0) {
        this.segX[i] = this.segX[i - 1] as number;
        this.segY[i] = this.segY[i - 1] as number;
      } else {
        this.segX[i] = 0;
        this.segY[i] = 1;
      }
    }
    // A curve that starts with a step of no length has no earlier segment to
    // borrow a direction from, so the first real one is carried back to it.
    for (let i = segments - 2; i >= 0; i--) {
      if ((this.spans[i] as number) === 0) {
        this.segX[i] = this.segX[i + 1] as number;
        this.segY[i] = this.segY[i + 1] as number;
      }
    }

    const half = footprintHalfWidth(road.tier);
    for (let i = 0; i < n; i++) {
      const before = i > 0 ? i - 1 : 0;
      const after = i < segments ? i : segments - 1;
      if (segments === 0) {
        this.pointX[i] = 0;
        this.pointY[i] = 1;
        this.mitres[i] = 1;
        this.mitred[i] = 1;
        continue;
      }
      const ax = (this.segX[before] as number) + (this.segX[after] as number);
      const ay = (this.segY[before] as number) + (this.segY[after] as number);
      const length = Math.hypot(ax, ay);
      this.mitres[i] = 1;
      this.pointX[i] = this.segX[before] as number;
      this.pointY[i] = this.segY[before] as number;
      // A point the road doubles back at has no bisector to swing to at all.
      if (length < 1e-9) continue;
      const ux = ax / length;
      const uy = ay / length;
      const cosine = ux * (this.segX[before] as number) + uy * (this.segY[before] as number);
      if (cosine <= 0) continue;
      // How far the mitre would move the outer corner along the road, against
      // the room the two segments beside the point leave for it.
      const shift = (half * Math.sqrt(Math.max(0, 1 - cosine * cosine))) / cosine;
      const room = Math.min(MITRE_SHIFT, MITRE_SHARE * Math.min(this.spans[before] as number, this.spans[after] as number));
      // A point where the two segments lie on one line moves nothing, so it
      // takes the mitre whatever room there is. That is every point of a
      // straight road, and both ends of every curve.
      if (shift > room) continue;
      this.pointX[i] = ux;
      this.pointY[i] = uy;
      this.mitres[i] = 1 / cosine;
      this.mitred[i] = 1;
    }
  }

  get segments(): number {
    return this.spans.length;
  }

  /**
   * The frame at a place on segment `segment`.
   *
   * A place that is one of the segment's own ends takes the mitred frame of
   * that point, where the point takes a mitre at all; a turn too sharp for one
   * answers with the frame of the segment asked about, so the two sides of it
   * get different frames and the caller cuts its surface there. Everywhere else
   * along the segment the frame is the segment's own.
   */
  frameAt(segment: number, x: number, y: number): RoadFrame {
    const i = clamp(segment, 0, Math.max(0, this.segments - 1));
    const a = this.points[i] as Point;
    const b = this.points[i + 1] as Point | undefined;
    if (b === undefined) return this.atPoint(i);
    const vertex = x === a.x && y === a.y ? i : x === b.x && y === b.y ? i + 1 : -1;
    if (vertex >= 0 && this.mitred[vertex] === 1) return this.atPoint(vertex);
    const span = this.spans[i] as number;
    const t =
      vertex === i
        ? 0
        : vertex === i + 1
          ? 1
          : span === 0
            ? 0
            : clamp(((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / (span * span), 0, 1);
    return {
      height: vertex >= 0 ? this.beds.pointHeight(this.curve, vertex) : this.beds.heightAt(this.curve, i, t),
      acrossX: this.segX[i] as number,
      acrossY: this.segY[i] as number,
      mitre: 1,
      distance: vertex >= 0 ? (this.distances[vertex] as number) : (this.distances[i] as number) + t * span,
    };
  }

  /** True where segment `segment` stands on a deck, is bored, or lies on the ground. */
  isBridge(segment: number): boolean {
    return this.bridged[segment] === 1;
  }

  isTunnel(segment: number): boolean {
    return this.bored[segment] === 1;
  }

  isOnGround(segment: number): boolean {
    return this.standing[segment] === 1;
  }

  private atPoint(i: number): RoadFrame {
    return {
      height: this.beds.pointHeight(this.curve, i),
      acrossX: this.pointX[i] as number,
      acrossY: this.pointY[i] as number,
      mitre: this.mitres[i] as number,
      distance: this.distances[i] as number,
    };
  }
}

/**
 * The frames of a whole road network, built once and asked about a place at a
 * time. Pure: the same terrain and curves give the same frames, and no answer
 * depends on which was asked for first.
 */
export class RoadRibbons {
  /** One ribbon per curve, filed under the curve's own id. */
  private readonly curves: (CurveRibbon | undefined)[] = [];

  /**
   * Without the junctions every bed is the natural ground under its curve.
   * Given beds already built, the ribbons read those instead of building them
   * again.
   */
  constructor(terrain: HeightfieldData | RoadBeds, roads: readonly RoadCurve[], junctions?: JunctionMap) {
    const beds = terrain instanceof RoadBeds ? terrain : new RoadBeds(terrain, roads, junctions);
    for (const road of roads) this.curves[road.id] = new CurveRibbon(beds, road);
  }

  /** The frame of curve `curve` at a place on its segment `segment`. */
  frameAt(curve: number, segment: number, x: number, y: number): RoadFrame {
    return this.ribbon(curve).frameAt(segment, x, y);
  }

  /** True where the segment is carried on a deck (spec section 6.1). */
  isBridge(curve: number, segment: number): boolean {
    return this.ribbon(curve).isBridge(segment);
  }

  /** True where the segment is bored through the ground. */
  isTunnel(curve: number, segment: number): boolean {
    return this.ribbon(curve).isTunnel(segment);
  }

  /** True where the segment lies on the ground, which is neither of the above. */
  isOnGround(curve: number, segment: number): boolean {
    return this.ribbon(curve).isOnGround(segment);
  }

  private ribbon(curve: number): CurveRibbon {
    const ribbon = this.curves[curve];
    if (ribbon === undefined) throw new Error(`no road curve ${curve}`);
    return ribbon;
  }
}
