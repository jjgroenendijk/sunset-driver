/**
 * The ground the corridors have claimed (spec sections 1.1, 6.3).
 *
 * `corridors.ts` claims each strip segment by segment. A segment is a convex
 * quad, and ground within {@link CLAIM_CLEARANCE} of a quad another run holds
 * is not free. The quads sit in a uniform grid of buckets, so "is this strip
 * free?" costs a handful of comparisons rather than a walk over everything
 * claimed so far.
 */
import { clamp, dist } from '../core/math.ts';
import type { Point } from './types.ts';

/** Metres of ground two corridors keep between them. */
const CLAIM_CLEARANCE = 0.5;
/** Metres below which an edge of a quad has no direction. */
const EPSILON = 1e-6;

/** One claimed piece of ground: a convex quad, and the run of centreline it came from. */
interface Claim {
  run: number;
  quad: Point[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The ground the corridors have claimed, in a uniform grid of buckets, so
 * "is this strip free?" costs a handful of comparisons rather than a walk over
 * everything claimed so far.
 */
export class ClaimIndex {
  private readonly cell: number;
  private readonly n: number;
  private readonly origin: number;
  private readonly buckets: Claim[][] = [];

  constructor(size: number, cell: number) {
    this.cell = cell;
    this.origin = -size / 2 - 2 * cell;
    this.n = Math.ceil((size + 4 * cell) / cell) + 1;
    for (let i = 0; i < this.n * this.n; i++) this.buckets.push([]);
  }

  private column(v: number): number {
    return clamp(Math.floor((v - this.origin) / this.cell), 0, this.n - 1);
  }

  add(run: number, quad: Point[]): void {
    const claim = { run, quad, ...boundsOf(quad) };
    for (let iy = this.column(claim.minY); iy <= this.column(claim.maxY); iy++) {
      for (let ix = this.column(claim.minX); ix <= this.column(claim.maxX); ix++) {
        (this.buckets[iy * this.n + ix] as Claim[]).push(claim);
      }
    }
  }

  /** True when a quad stands within {@link CLAIM_CLEARANCE} of ground another run holds. */
  taken(run: number, quad: Point[]): boolean {
    const box = boundsOf(quad);
    for (let iy = this.column(box.minY); iy <= this.column(box.maxY); iy++) {
      for (let ix = this.column(box.minX); ix <= this.column(box.maxX); ix++) {
        for (const claim of this.buckets[iy * this.n + ix] as Claim[]) {
          if (clashes(run, quad, box, claim)) return true;
        }
      }
    }
    return false;
  }
}

/** True when a quad of one run stands within {@link CLAIM_CLEARANCE} of a claim of another. */
function clashes(run: number, quad: readonly Point[], box: { minX: number; minY: number; maxX: number; maxY: number }, claim: Claim): boolean {
  if (claim.run === run) return false;
  if (claim.minX - box.maxX >= CLAIM_CLEARANCE || box.minX - claim.maxX >= CLAIM_CLEARANCE) return false;
  if (claim.minY - box.maxY >= CLAIM_CLEARANCE || box.minY - claim.maxY >= CLAIM_CLEARANCE) return false;
  return near(quad, claim.quad, CLAIM_CLEARANCE);
}

function boundsOf(quad: readonly Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of quad) {
    if (p.x < box.minX) box.minX = p.x;
    if (p.y < box.minY) box.minY = p.y;
    if (p.x > box.maxX) box.maxX = p.x;
    if (p.y > box.maxY) box.maxY = p.y;
  }
  return box;
}

/**
 * True when two convex rings stand less than `gap` metres apart. Separating
 * axes: where the two shapes cast disjoint shadows on the normal of any of
 * their edges, and the shadows stand `gap` apart, nothing of one is that close
 * to the other.
 */
function near(a: readonly Point[], b: readonly Point[], gap: number): boolean {
  return !apart(a, b, gap) && !apart(b, a, gap);
}

/** True when the shadows of two rings on the normal of some edge of the first stand `gap` apart. */
function apart(edges: readonly Point[], other: readonly Point[], gap: number): boolean {
  for (let i = 0; i < edges.length; i++) {
    const p = edges[i] as Point;
    const q = edges[(i + 1) % edges.length] as Point;
    const len = dist(p.x, p.y, q.x, q.y);
    if (len < EPSILON) continue;
    const nx = -(q.y - p.y) / len;
    const ny = (q.x - p.x) / len;
    const sa = span(edges, nx, ny);
    const sb = span(other, nx, ny);

    if (sb.lo - sa.hi >= gap || sa.lo - sb.hi >= gap) return true;
  }
  return false;
}

/** The shadow a ring casts on an axis. */
function span(ring: readonly Point[], nx: number, ny: number): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ring) {
    const v = p.x * nx + p.y * ny;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}
