/**
 * A point a distance round a closed route of the road graph (spec section 6.5).
 *
 * The traffic (`traffic.ts`) and the tram (`tram.ts`) both drive a loop of
 * edges and ask where on it a distance falls. This answers on the centreline:
 * the point, the road height under it and the right hand of the direction of
 * travel. The caller moves the point out into its own lane or track.
 */
import { hypot } from '../core/libm.ts';
import type { RoadEdge, RoadGraph } from '../world/graph.ts';
import type { Point, RoadCurve } from '../world/types.ts';
import { legAt } from './traffic-timing.ts';

/** The height of a road, `t` along a segment of a curve that stands at `(x, y)`. */
export type BedHeight = (curve: number, segment: number, t: number, x: number, y: number) => number;

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
  rightX: number;
  rightY: number;
  /** The edge the point lies on. */
  edge: RoadEdge;
}

export class RouteSampler {
  private readonly roads: readonly RoadCurve[];
  private readonly graph: RoadGraph;
  private readonly heightAt: BedHeight;
  /** Cumulative metres at each point of each edge, in its direction of travel. */
  private readonly runs: (Float64Array | undefined)[] = [];

  constructor(roads: readonly RoadCurve[], graph: RoadGraph, heightAt: BedHeight) {
    this.roads = roads;
    this.graph = graph;
    this.heightAt = heightAt;
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
    out.height = step > 0 ? this.heightAt(edge.curve, edge.start + k, f, out.x, out.y) : this.heightAt(edge.curve, edge.start - k - 1, 1 - f, out.x, out.y);
    return out;
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
