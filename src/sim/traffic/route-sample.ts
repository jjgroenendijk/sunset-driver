/**
 * A point a distance round a closed route of the road graph (spec section 6.5).
 *
 * The traffic (`traffic.ts`) and the tram (`tram.ts`) both drive a loop of
 * edges and ask where on it a distance falls. This answers on the centreline:
 * the point, the road height under it, how the surface tilts there and the
 * right hand of the direction of travel. The caller moves the point out into
 * its own lane or track, and reads the height there with {@link heightOff}.
 */
import { hypot } from '../../core/libm.ts';
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import { surfaceHeight } from '../../world/carve/bed.ts';
import type { Point, RoadCurve } from '../../world/types.ts';
import { legAt } from './traffic-timing.ts';

/** The height of a road, `t` along a segment of a curve that stands at `(x, y)`. */
export type BedHeight = (curve: number, segment: number, t: number, x: number, y: number) => number;

/**
 * How a road's surface tilts `t` along a segment of a curve: rise per metre
 * along x and along y of the map, as a bed knot carries it in `bed.ts`.
 */
export type BedTilt = (curve: number, segment: number, t: number) => { gx: number; gy: number };

/** A loop of edges and the metres round it each one starts at. */
export interface RouteLegs {
  edges: Int32Array;
  startDistance: Float64Array;
  /** Metres once round. */
  length: number;
}

/** A point on a centreline, the road height there, and the right hand of travel as a unit vector. */
export interface RoutePoint {
  x: number;
  y: number;
  height: number;
  /** Rise per metre along x and along y of the map. Zero away from a junction's mouth. */
  tiltX: number;
  tiltY: number;
  rightX: number;
  rightY: number;
  /** The edge the point lies on. */
  edge: RoadEdge;
  /** The bends either side of the point, filled in by a sample only where the caller asks for them. */
  around?: RouteAround;
}

/**
 * The two bends of the centreline either side of a point: the corners of the
 * polyline behind and ahead of it, whether they fall inside one edge or where
 * one edge of the route meets the next.
 */
export interface RouteAround {
  /** Metres back to the corner behind, and on to the corner ahead. */
  back: number;
  ahead: number;
  /** The right hand of travel on the segment before the corner behind, and after the corner ahead. */
  backRightX: number;
  backRightY: number;
  aheadRightX: number;
  aheadRightY: number;
  /** The edges those two segments lie on: the point's own edge but for a corner that joins two. */
  backEdge: RoadEdge;
  aheadEdge: RoadEdge;
}

export class RouteSampler {
  private readonly roads: readonly RoadCurve[];
  private readonly graph: RoadGraph;
  private readonly heightAt: BedHeight;
  private readonly tiltAt: BedTilt | undefined;
  /** Cumulative metres at each point of each edge, in its direction of travel. */
  private readonly runs: (Float64Array | undefined)[] = [];

  /** A road with no `tiltAt` is level across everywhere. */
  constructor(roads: readonly RoadCurve[], graph: RoadGraph, heightAt: BedHeight, tiltAt?: BedTilt) {
    this.roads = roads;
    this.graph = graph;
    this.heightAt = heightAt;
    this.tiltAt = tiltAt;
  }

  /** The point a distance round a route. A distance past either end wraps round the loop. */
  sample(route: RouteLegs, distance: number, out: RoutePoint): RoutePoint {
    let d = distance % route.length;
    if (d < 0) d += route.length;
    const leg = legAt(route.startDistance, d);
    const edge = this.graph.edges[route.edges[leg] as number] as RoadEdge;
    const run = this.runOf(edge);
    const s = d - (route.startDistance[leg] as number);
    const k = Math.min(legAt(run, s), run.length - 2);
    const span = (run[k + 1] as number) - (run[k] as number);
    const f = span > 0 ? Math.min(1, Math.max(0, (s - (run[k] as number)) / span)) : 0;
    const step = edge.end >= edge.start ? 1 : -1;
    const points = (this.roads[edge.curve] as RoadCurve).points;
    const a = points[edge.start + k * step] as Point;
    const b = points[edge.start + (k + 1) * step] as Point;
    const length = hypot(b.x - a.x, b.y - a.y) || 1;
    out.x = a.x + (b.x - a.x) * f;
    out.y = a.y + (b.y - a.y) * f;
    out.rightX = -(b.y - a.y) / length;
    out.rightY = (b.x - a.x) / length;
    out.edge = edge;
    const segment = step > 0 ? edge.start + k : edge.start - k - 1;
    const t = step > 0 ? f : 1 - f;
    out.height = this.heightAt(edge.curve, segment, t, out.x, out.y);
    const tilt = this.tiltAt?.(edge.curve, segment, t);
    out.tiltX = tilt?.gx ?? 0;
    out.tiltY = tilt?.gy ?? 0;
    const around = out.around;
    if (around !== undefined) {
      around.back = s - (run[k] as number);
      around.ahead = (run[k + 1] as number) - s;
      const count = route.edges.length;
      // The segment before the corner behind: this edge's last one, or the edge before's.
      let edgeBack = edge;
      let from = k - 1;
      if (k === 0) {
        edgeBack = this.graph.edges[route.edges[(leg + count - 1) % count] as number] as RoadEdge;
        from = this.runOf(edgeBack).length - 2;
      }
      this.rightOn(edgeBack, from, around, true);
      let edgeAhead = edge;
      let to = k + 1;
      if (k + 2 >= run.length) {
        edgeAhead = this.graph.edges[route.edges[(leg + 1) % count] as number] as RoadEdge;
        to = 0;
      }
      this.rightOn(edgeAhead, to, around, false);
      around.backEdge = edgeBack;
      around.aheadEdge = edgeAhead;
    }
    return out;
  }

  /** The right hand of travel on segment `k` of an edge, into the back or the ahead of `around`. */
  private rightOn(edge: RoadEdge, k: number, around: RouteAround, back: boolean): void {
    const step = edge.end >= edge.start ? 1 : -1;
    const points = (this.roads[edge.curve] as RoadCurve).points;
    const a = points[edge.start + k * step] as Point;
    const b = points[edge.start + (k + 1) * step] as Point;
    const length = hypot(b.x - a.x, b.y - a.y) || 1;
    if (back) {
      around.backRightX = -(b.y - a.y) / length;
      around.backRightY = (b.x - a.x) / length;
    } else {
      around.aheadRightX = -(b.y - a.y) / length;
      around.aheadRightY = (b.x - a.x) / length;
    }
  }

  private runOf(edge: RoadEdge): Float64Array {
    const known = this.runs[edge.id];
    if (known !== undefined) return known;
    const points = (this.roads[edge.curve] as RoadCurve).points;
    const step = edge.end >= edge.start ? 1 : -1;
    const run = new Float64Array(Math.abs(edge.end - edge.start) + 1);
    for (let k = 1; k < run.length; k++) {
      const a = points[edge.start + (k - 1) * step] as Point;
      const b = points[edge.start + k * step] as Point;
      run[k] = (run[k - 1] as number) + hypot(b.x - a.x, b.y - a.y);
    }
    this.runs[edge.id] = run;
    return run;
  }
}

/** The height of the road surface `offset` metres to the right of a point on its centreline. */
export function heightOff(at: RoutePoint, offset: number): number {
  return surfaceHeight(at.height, at.tiltX, at.tiltY, at.rightX * offset, at.rightY * offset);
}
