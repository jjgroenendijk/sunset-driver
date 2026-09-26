/**
 * The path the joggers and the skaters of spec section 20.1 go to and fro
 * along: the dune line of a beach stepped a little onto the sand, beside the
 * boardwalk street behind it. A runner is read from the metres they have
 * covered, so the path answers a place for any metre with nothing stepped.
 */
import { atan2 } from '../../core/libm.ts';
import type { Beach, Point } from '../../world/types.ts';

/** Metres onto the sand from the dune line the path runs. */
const PATH_IN = 3;

/** The shortest path worth running. */
const MIN_PATH = 60;

/** Where a runner is. */
interface PathPose {
  x: number;
  y: number;
  height: number;
  heading: number;
}

export class BeachPath {
  /** Metres from one end to the other. */
  readonly length: number;
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly heights: Float64Array;
  /** Metres from the start to each point. */
  private readonly at: Float64Array;

  private constructor(xs: Float64Array, ys: Float64Array, heights: Float64Array, at: Float64Array) {
    this.xs = xs;
    this.ys = ys;
    this.heights = heights;
    this.at = at;
    this.length = at[at.length - 1] ?? 0;
  }

  /** The path along a beach's dune line, or undefined on one too short to run. */
  static along(beach: Beach, heightAt: (x: number, y: number) => number): BeachPath | undefined {
    const n = beach.back.length;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const heights = new Float64Array(n);
    const at = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const back = beach.back[i] as Point;
      const shore = beach.shore[i] as Point;
      const dx = shore.x - back.x;
      const dy = shore.y - back.y;
      const deep = Math.sqrt(dx * dx + dy * dy);
      const step = deep > 0 ? Math.min(PATH_IN, deep / 2) / deep : 0;
      xs[i] = back.x + dx * step;
      ys[i] = back.y + dy * step;
      heights[i] = heightAt(xs[i] as number, ys[i] as number);
      if (i > 0) {
        const ex = (xs[i] as number) - (xs[i - 1] as number);
        const ey = (ys[i] as number) - (ys[i - 1] as number);
        at[i] = (at[i - 1] as number) + Math.sqrt(ex * ex + ey * ey);
      }
    }
    return (at[n - 1] ?? 0) < MIN_PATH ? undefined : new BeachPath(xs, ys, heights, at);
  }

  /**
   * Where a runner stands after `metres` of going to and fro: out along the
   * path, then back along it, for ever.
   */
  pace(metres: number, out: PathPose): void {
    const lap = 2 * this.length;
    const into = ((metres % lap) + lap) % lap;
    const back = into > this.length;
    const s = back ? lap - into : into;
    // The segment the metre falls in, by halving.
    let lo = 0;
    let hi = this.at.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((this.at[mid] as number) <= s) lo = mid;
      else hi = mid;
    }
    const a = this.at[lo] as number;
    const b = this.at[hi] as number;
    const t = b > a ? (s - a) / (b - a) : 0;
    const x0 = this.xs[lo] as number;
    const y0 = this.ys[lo] as number;
    const x1 = this.xs[hi] as number;
    const y1 = this.ys[hi] as number;
    out.x = x0 + (x1 - x0) * t;
    out.y = y0 + (y1 - y0) * t;
    out.height = (this.heights[lo] as number) + ((this.heights[hi] as number) - (this.heights[lo] as number)) * t;
    out.heading = back ? atan2(y0 - y1, x0 - x1) : atan2(y1 - y0, x1 - x0);
  }
}
