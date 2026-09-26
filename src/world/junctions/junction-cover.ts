/**
 * The ground the carve levels to a junction's plane (spec section 6.2): its
 * outline, and the carriageway `junction-shape.ts` says is drawn over it.
 *
 * The outline alone leaves ground uncovered under the carriageway. A mouth's
 * section stands on its curve and the outline is cut on a straight line, and
 * the carriageway is fanned from the node, which reaches past its own ring
 * where the node cannot see all of that ring. So the cover is the union of the
 * outline and the triangles of the fan, and the distance to it is the distance
 * to the nearer of them.
 *
 * The carve asks this for every place near a junction, so each piece keeps the
 * box around it and is skipped where the box is further than the nearest piece
 * found so far.
 */
import { pointInRing } from '../../core/geom.ts';
import type { JunctionShape } from './junction-shape.ts';
import type { Point } from '../types.ts';

/** One ring of the cover, and the box around it. */
interface Piece {
  ring: readonly Point[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /**
   * True for a carriageway the node cannot see all of, whose fan is not the
   * ring: it is tested triangle by triangle, and its spokes are edges too.
   */
  fan: boolean;
}

export class JunctionCover {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  private readonly node: Point;
  private readonly pieces: Piece[] = [];

  constructor(outline: readonly Point[], node: Point, shape: JunctionShape) {
    this.node = { x: node.x, y: node.y };
    this.add(outline, false);
    if (shape.carriageway.length >= 3) this.add(shape.carriageway, !seenWhole(shape.carriageway, node));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const piece of this.pieces) {
      minX = Math.min(minX, piece.minX);
      minY = Math.min(minY, piece.minY);
      maxX = Math.max(maxX, piece.maxX);
      maxY = Math.max(maxY, piece.maxY);
    }
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
  }

  /**
   * Metres from a place to the cover: zero inside it, and at least `reach`
   * wherever it is further than that, which is all a caller that ignores the
   * ground beyond `reach` needs to know.
   */
  distance(x: number, y: number, reach: number): number {
    if (x < this.minX - reach || x > this.maxX + reach || y < this.minY - reach || y > this.maxY + reach) return reach;
    let best = reach * reach;
    for (const piece of this.pieces) {
      const bx = Math.max(piece.minX - x, 0, x - piece.maxX);
      const by = Math.max(piece.minY - y, 0, y - piece.maxY);
      if (bx * bx + by * by >= best) continue;
      if (piece.fan ? this.inFan(piece.ring, x, y) : pointInRing({ x, y }, piece.ring)) return 0;
      best = Math.min(best, ringDistanceSquared(piece.ring, x, y));
      if (piece.fan) for (const q of piece.ring) best = Math.min(best, segmentDistanceSquared(this.node, q, x, y));
    }
    return Math.sqrt(best);
  }

  private add(ring: readonly Point[], fan: boolean): void {
    let minX = fan ? this.node.x : Infinity;
    let minY = fan ? this.node.y : Infinity;
    let maxX = fan ? this.node.x : -Infinity;
    let maxY = fan ? this.node.y : -Infinity;
    for (const p of ring) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    this.pieces.push({ ring, minX, minY, maxX, maxY, fan });
  }

  /** True inside any triangle of the fan from the node, whichever way it winds. */
  private inFan(ring: readonly Point[], x: number, y: number): boolean {
    const n = this.node;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j] as Point;
      const b = ring[i] as Point;
      const area = (a.x - n.x) * (b.y - n.y) - (a.y - n.y) * (b.x - n.x);
      // A triangle with no area covers nothing.
      if (area === 0) continue;
      const d1 = (a.x - n.x) * (y - n.y) - (a.y - n.y) * (x - n.x);
      const d2 = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      const d3 = (n.x - b.x) * (y - b.y) - (n.y - b.y) * (x - b.x);
      if (area > 0 ? d1 >= 0 && d2 >= 0 && d3 >= 0 : d1 <= 0 && d2 <= 0 && d3 <= 0) return true;
    }
    return false;
  }
}

/**
 * True where every triangle of the fan from `node` turns the same way, so the
 * fan covers exactly the ring and nothing past it.
 */
function seenWhole(ring: readonly Point[], node: Point): boolean {
  let positive = false;
  let negative = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j] as Point;
    const b = ring[i] as Point;
    const area = (a.x - node.x) * (b.y - node.y) - (a.y - node.y) * (b.x - node.x);
    if (area > 0) positive = true;
    if (area < 0) negative = true;
  }
  return !(positive && negative);
}

/** The square of the metres from a place to the nearest edge of a ring. */
function ringDistanceSquared(ring: readonly Point[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    best = Math.min(best, segmentDistanceSquared(ring[j] as Point, ring[i] as Point, x, y));
  }
  return best;
}

function segmentDistanceSquared(a: Point, b: Point, x: number, y: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const squared = dx * dx + dy * dy;
  let t = squared === 0 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / squared;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const ox = x - (a.x + dx * t);
  const oy = y - (a.y + dy * t);
  return ox * ox + oy * oy;
}
