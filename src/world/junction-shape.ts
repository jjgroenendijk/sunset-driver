/**
 * The ground a junction's carriageway is drawn over, as a ring on the map (spec
 * section 6.2). A junction holds its carriageway alone: the pavement round its
 * corners is cut out of the blocks by `pavement.ts`.
 *
 * The ring is the outline of the union of every mouth's carriageway, from the
 * node out to its cut along its own curve, and every corner between two
 * mouths (issue #676, E1). `road-mesh.ts` draws none of that ground, so the
 * ring has to hold all of it. Each piece holds the node, so the union is star
 * shaped about the node: a ray from the node leaves it once, at the furthest
 * place it leaves any piece. The ring is those places, swept round the node,
 * so it never crosses itself and the fan `junction-mesh.ts` draws from the
 * node covers it exactly.
 *
 * `junction-mesh.ts` lays a surface on the ring and `carve.ts` levels the
 * ground under it to the junction's plane. Both read the ring from here, so
 * the carve covers exactly what is drawn, and every vertex carries its height
 * from the one surface `bed.ts` defines.
 */
import { planeHeight } from './bed.ts';
import type { Junction, JunctionMouth } from './junctions.ts';
import type { RoadRibbons } from './ribbon.ts';
import { TIERS } from './tiers.ts';
import type { Point } from './types.ts';

/**
 * One corner of a junction ring. `bed` is the height of the surface there, read
 * off the one surface of `bed.ts`: the road's banked section where the vertex
 * stands on a mouth, and the junction's plane everywhere else. It is undefined
 * only where the ribbons were built without the junctions, and the vertex then
 * stands on the carved ground.
 */
export interface JunctionVertex {
  x: number;
  y: number;
  bed: number | undefined;
}

/** The ring of one junction's carriageway. */
export interface JunctionShape {
  /**
   * The carriageway, anticlockwise round the node: the outline of every
   * mouth's carriageway out to its cut and every corner between them. A ray
   * from the node crosses it once, so the fan from the node draws it exactly.
   */
  carriageway: JunctionVertex[];
  /** The height of the surface at the node, which the carriageway is fanned from. */
  centre: number | undefined;
}

/** One edge of a piece of the junction's ground, with the surface height at each end. */
interface Edge {
  a: JunctionVertex;
  b: JunctionVertex;
}

/**
 * The carriageway of a junction. The vertices along each mouth are the kerbs
 * the road's own loft runs on, out to the section it ends on. Nothing where
 * fewer than two mouths meet, since then nothing is drawn.
 */
export function junctionShape(junction: Junction, ribbons: RoadRibbons): JunctionShape {
  const plane = ribbons.beds.planeAt(junction.node);
  const shape: JunctionShape = { carriageway: [], centre: plane?.level };
  if (junction.mouths.length < 2) return shape;
  const ground = (p: Point): JunctionVertex => ({
    x: p.x,
    y: p.y,
    bed: plane === undefined ? undefined : planeHeight(plane, p.x, p.y),
  });
  const node: Point = { x: junction.x, y: junction.y };
  const edges: Edge[] = [];
  const ring = (points: readonly JunctionVertex[]): void => {
    for (let i = 0; i < points.length; i++) edges.push({ a: points[i] as JunctionVertex, b: points[(i + 1) % points.length] as JunctionVertex });
  };
  junction.mouths.forEach((mouth, i) => {
    for (const piece of mouthPieces(mouth, node, ribbons, ground)) ring(piece);
    const corner = junction.corners[i] as Junction['corners'][number];
    ring([ground(node), ...corner.kerb.map(ground)]);
  });
  shape.carriageway = outline(node, edges);
  return shape;
}

/**
 * The ground of a mouth's carriageway from the node out to its cut, as pieces:
 * one rectangle along each stretch of the curve inside the cut, and at each
 * point of the curve between two stretches the wedge the loft's mitre fills on
 * the outside of the bend. A rectangle and not a chain of kerbs, since the
 * stretch next to the node can reach past the section the next one is cut on,
 * and that ground is drawn by nothing else. The last rectangle ends on the
 * section the loft starts from, so the two meet on one line.
 */
function mouthPieces(
  mouth: JunctionMouth,
  node: Point,
  ribbons: RoadRibbons,
  ground: (p: Point) => JunctionVertex,
): JunctionVertex[][] {
  const kerb = TIERS[mouth.tier].width / 2;
  const points = ribbons.pointsOf(mouth.curve);
  const line: Point[] = [node];
  const segments: number[] = [];
  const side = mouth.direction;
  for (let k = mouth.point + side; side > 0 ? k <= mouth.segment : k > mouth.segment; k += side) {
    line.push(points[k] as Point);
    segments.push(side > 0 ? k - 1 : k);
  }
  line.push(mouth.at);
  segments.push(mouth.segment);
  const pieces: JunctionVertex[][] = [];
  // Where a kerb stands across a stretch at one of its ends, and the height
  // the road's own section gives it there.
  const kerbAt = (segment: number, p: Point, nx: number, ny: number, off: number, first: boolean): JunctionVertex => {
    const place = { x: p.x + nx * off, y: p.y + ny * off };
    if (first && p === node) return ground(place);
    const frame = ribbons.frameAt(mouth.curve, segment, p.x, p.y);
    return { x: place.x, y: place.y, bed: frame.height + frame.bank * off * (nx * frame.acrossX + ny * frame.acrossY) };
  };
  let before: { left: JunctionVertex; right: JunctionVertex } | undefined;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i] as Point;
    const b = line[i + 1] as Point;
    const segment = segments[i] as number;
    const length = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    if (length === 0) continue;
    // Left of the way out from the node.
    const nx = -(b.y - a.y) / length;
    const ny = (b.x - a.x) / length;
    const start = { left: kerbAt(segment, a, nx, ny, kerb, true), right: kerbAt(segment, a, nx, ny, -kerb, true) };
    const end =
      i + 2 === line.length
        ? sectionAt(ribbons, mouth.curve, segment, b, kerb, side)
        : { leftKerb: kerbAt(segment, b, nx, ny, kerb, false), rightKerb: kerbAt(segment, b, nx, ny, -kerb, false) };
    pieces.push([start.right, end.rightKerb, end.leftKerb, start.left]);
    if (before !== undefined) {
      // The mitre the loft lays at the point fills the notch on the outside of
      // the bend; where the turn is too sharp for one, the loft leaves it too.
      const frame = ribbons.frameAt(mouth.curve, segment, a.x, a.y);
      if (frame.mitre > 1) {
        const mitred = sectionAt(ribbons, mouth.curve, segment, a, kerb, side);
        const middle = ground(a);
        pieces.push([middle, before.left, mitred.leftKerb, start.left]);
        pieces.push([middle, start.right, mitred.rightKerb, before.right]);
      }
    }
    before = { left: end.leftKerb, right: end.rightKerb };
  }
  return pieces;
}

/** How far a ray is turned either side of a vertex to read which edge is furthest: a fraction of its length. */
const NUDGE = 1e-7;
/** Metres two places may stand apart and still be one vertex of the ring. */
const SAME_VERTEX = 1e-6;

/** A direction from the node, and where it falls on a turn round the node. */
interface Ray {
  dx: number;
  dy: number;
  /** A number that grows with the angle anticlockwise from -y, in [0, 4): the order of the sweep, with no trigonometry. */
  turn: number;
}

function rayOf(dx: number, dy: number, after = -Infinity): Ray {
  // The diamond angle: the same order as the angle, read off the slope. It
  // starts at -y and turns anticlockwise. A ray read on the way round from
  // `after` keeps the sweep's order past the start.
  const p = dy / (Math.abs(dx) + Math.abs(dy));
  const turn = dx >= 0 ? 1 + p : 3 - p;
  return { dx, dy, turn: turn < after ? turn + 4 : turn };
}

/** A ray turned a little anticlockwise (`hand` 1) or clockwise (`hand` -1). */
function nudged(ray: Ray, hand: number): Ray {
  return { dx: ray.dx - ray.dy * NUDGE * hand, dy: ray.dy + ray.dx * NUDGE * hand, turn: ray.turn };
}

/**
 * The outline of the union of pieces that each hold the node, anticlockwise:
 * at every direction a vertex of any piece stands in, the furthest place a ray
 * from the node leaves any piece, read just before and just after it. Between
 * two such directions the furthest edge is one straight edge, unless two edges
 * cross there, and then the crossing is a vertex too.
 */
function outline(node: Point, all: readonly Edge[]): JunctionVertex[] {
  const edges = new AngularIndex(node, all);
  const rays: Ray[] = [];
  for (const edge of all) {
    for (const v of [edge.a, edge.b]) {
      const dx = v.x - node.x;
      const dy = v.y - node.y;
      if (dx * dx + dy * dy > SAME_VERTEX * SAME_VERTEX) rays.push(rayOf(dx, dy));
    }
  }
  rays.sort((m, n) => m.turn - n.turn);
  // Two vertices in one direction are one ray.
  const unique = rays.filter((r, i) => {
    const q = rays[i - 1];
    if (q === undefined) return true;
    const scale = Math.sqrt((r.dx * r.dx + r.dy * r.dy) * (q.dx * q.dx + q.dy * q.dy));
    return Math.abs(r.dx * q.dy - r.dy * q.dx) > NUDGE * scale || r.dx * q.dx + r.dy * q.dy < 0;
  });
  const out: JunctionVertex[] = [];
  const push = (v: JunctionVertex | undefined): void => {
    if (v === undefined) return;
    const last = out[out.length - 1];
    if (last !== undefined && (last.x - v.x) ** 2 + (last.y - v.y) ** 2 <= SAME_VERTEX * SAME_VERTEX) return;
    out.push(v);
  };
  // The edge furthest just before each ray is the one read just before it on
  // the way from the ray behind, so each is cast once.
  let before = furthest(node, edges, nudged(unique[0] as Ray, -1));
  for (let k = 0; k < unique.length; k++) {
    const ray = unique[k] as Ray;
    const next = unique[(k + 1) % unique.length] as Ray;
    const after = furthest(node, edges, nudged(ray, 1));
    push(before === undefined ? undefined : along(node, before, ray));
    push(after === undefined ? undefined : along(node, after, ray));
    // Where the furthest edge changes between two rays, edges cross there,
    // and each crossing on the outside is a corner of the outline.
    const ahead = furthest(node, edges, nudged(next, -1));
    if (after !== undefined && ahead !== undefined) between(node, edges, ray, after, next, ahead, push, 0);
    before = ahead;
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (first !== undefined && last !== undefined && out.length > 1 && (first.x - last.x) ** 2 + (first.y - last.y) ** 2 <= SAME_VERTEX * SAME_VERTEX) out.pop();
  return out;
}

/** How many times the stretch between two rays is split while the outside edge keeps changing. */
const MAX_SPLITS = 8;

/**
 * The corners of the outline strictly between two rays, where the furthest
 * edge is `from` just after the first and `to` just before the second. No
 * edge ends between the two, so the outline there is straight edges meeting
 * where they cross: the crossing of the two is the corner, unless a third
 * edge stands further out along the ray through it, and then that edge is
 * the outline in the middle and each side is split again.
 */
function between(
  node: Point,
  edges: AngularIndex,
  left: Ray,
  from: Edge,
  right: Ray,
  to: Edge,
  push: (v: JunctionVertex | undefined) => void,
  depth: number,
): void {
  if (from === to) return;
  const corner = crossing(node, from, to, left, right);
  const middle = corner === undefined ? bisector(left, right) : rayOf(corner.x - node.x, corner.y - node.y, left.turn);
  const top = middle === undefined ? undefined : furthest(node, edges, middle);
  const above = corner === undefined || (top !== undefined && top !== from && top !== to && further(node, top, middle as Ray, corner));
  if (!above || depth >= MAX_SPLITS || middle === undefined || top === undefined) {
    push(corner);
    return;
  }
  between(node, edges, left, from, middle, top, push, depth + 1);
  push(along(node, top, middle));
  between(node, edges, middle, top, right, to, push, depth + 1);
}

/** True where an edge stands further out along a ray than a place on it, by more than a vertex is wide. */
function further(node: Point, edge: Edge, ray: Ray, place: Point): boolean {
  const r = rayHit(node, ray.dx, ray.dy, edge);
  if (r === undefined) return false;
  const length = Math.sqrt(ray.dx * ray.dx + ray.dy * ray.dy);
  return (r * length) - Math.sqrt((place.x - node.x) ** 2 + (place.y - node.y) ** 2) > SAME_VERTEX;
}

/** The ray halfway round from one ray to the next, or undefined where they point apart. */
function bisector(left: Ray, right: Ray): Ray | undefined {
  const l = Math.sqrt(left.dx * left.dx + left.dy * left.dy);
  const r = Math.sqrt(right.dx * right.dx + right.dy * right.dy);
  const dx = left.dx / l + right.dx / r;
  const dy = left.dy / l + right.dy / r;
  if (dx * dx + dy * dy < 1e-12) return undefined;
  return rayOf(dx, dy, left.turn);
}

/** Buckets of turn round the node an {@link AngularIndex} files its edges in. */
const BUCKETS = 32;

/** The bucket a turn round the node falls in. */
function bucketOf(turn: number): number {
  return Math.min(BUCKETS - 1, Math.floor(((turn % 4) / 4) * BUCKETS));
}

/**
 * The edges of a junction's pieces filed by the directions round the node they
 * face, so a ray is tested against the few that can meet it. An edge on a line
 * through the node faces no ray: a ray along it never leaves a piece there.
 */
class AngularIndex {
  private readonly buckets: Edge[][] = [];

  constructor(node: Point, edges: readonly Edge[]) {
    for (let b = 0; b < BUCKETS; b++) this.buckets.push([]);
    for (const edge of edges) {
      const ax = edge.a.x - node.x;
      const ay = edge.a.y - node.y;
      const bx = edge.b.x - node.x;
      const by = edge.b.y - node.y;
      const turn = ax * by - ay * bx;
      if (Math.abs(turn) <= SAME_VERTEX * Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2)) continue;
      // The edge faces the directions from one end to the other, the short way.
      const [from, to] = turn > 0 ? [rayOf(ax, ay), rayOf(bx, by)] : [rayOf(bx, by), rayOf(ax, ay)];
      const last = bucketOf(to.turn);
      for (let b = bucketOf(from.turn); ; b = (b + 1) % BUCKETS) {
        (this.buckets[b] as Edge[]).push(edge);
        if (b === last) break;
      }
    }
  }

  /**
   * The edges a ray may meet. A nudged ray keeps the turn of the vertex it was
   * nudged off, whose bucket holds every edge that starts or ends there.
   */
  at(ray: Ray): readonly Edge[] {
    return this.buckets[bucketOf(ray.turn)] as Edge[];
  }
}

/** The edge a ray from the node leaves last, or undefined where it meets none. */
function furthest(node: Point, index: AngularIndex, ray: Ray): Edge | undefined {
  let best: Edge | undefined;
  let reach = -Infinity;
  for (const edge of index.at(ray)) {
    const r = rayHit(node, ray.dx, ray.dy, edge);
    if (r !== undefined && r > reach) {
      reach = r;
      best = edge;
    }
  }
  return best;
}

/** How far along a ray from the node, in lengths of the ray, it meets an edge; undefined where it misses. */
function rayHit(node: Point, dx: number, dy: number, edge: Edge): number | undefined {
  const ex = edge.b.x - edge.a.x;
  const ey = edge.b.y - edge.a.y;
  const denominator = dx * ey - dy * ex;
  if (denominator === 0) return undefined;
  const ox = edge.a.x - node.x;
  const oy = edge.a.y - node.y;
  const r = (ox * ey - oy * ex) / denominator;
  const s = (ox * dy - oy * dx) / denominator;
  if (r < 0 || s < -1e-9 || s > 1 + 1e-9) return undefined;
  return r;
}

/** The place a ray from the node meets the line of an edge, with the surface there. */
function along(node: Point, edge: Edge, ray: Ray): JunctionVertex | undefined {
  const ex = edge.b.x - edge.a.x;
  const ey = edge.b.y - edge.a.y;
  const denominator = ray.dx * ey - ray.dy * ex;
  if (denominator === 0) return undefined;
  const ox = edge.a.x - node.x;
  const oy = edge.a.y - node.y;
  const s = Math.min(1, Math.max(0, (ox * ray.dy - oy * ray.dx) / denominator));
  return lerpVertex(edge, s);
}

/** Where two edges cross strictly between two rays round the node, or undefined where they do not. */
function crossing(node: Point, one: Edge, two: Edge, from: Ray, to: Ray): JunctionVertex | undefined {
  const rx = one.b.x - one.a.x;
  const ry = one.b.y - one.a.y;
  const sx = two.b.x - two.a.x;
  const sy = two.b.y - two.a.y;
  const denominator = rx * sy - ry * sx;
  if (denominator === 0) return undefined;
  const ox = two.a.x - one.a.x;
  const oy = two.a.y - one.a.y;
  const t = (ox * sy - oy * sx) / denominator;
  if (t < 0 || t > 1) return undefined;
  const v = lerpVertex(one, t);
  const vx = v.x - node.x;
  const vy = v.y - node.y;
  // Between the two rays: anticlockwise of the first and clockwise of the second.
  return from.dx * vy - from.dy * vx > 0 && vx * to.dy - vy * to.dx > 0 ? v : undefined;
}

function lerpVertex(edge: Edge, s: number): JunctionVertex {
  const bed = edge.a.bed === undefined || edge.b.bed === undefined ? undefined : edge.a.bed + (edge.b.bed - edge.a.bed) * s;
  return { x: edge.a.x + (edge.b.x - edge.a.x) * s, y: edge.a.y + (edge.b.y - edge.a.y) * s, bed };
}

/** The two kerbs of the road's section at a place on one of its segments, anticlockwise round the node. */
interface MouthSection {
  leftKerb: JunctionVertex;
  rightKerb: JunctionVertex;
}

/**
 * The section of a mouth's loft at a place. Left is anticlockwise round the
 * node, which is the curve's own left where the road leaves along its curve
 * and its right where it leaves against it. The place is worked out as `place`
 * in `road-section.ts` works it out, so the vertices are the loft's to the
 * last bit.
 */
function sectionAt(ribbons: RoadRibbons, curve: number, segment: number, at: Point, kerb: number, side: 1 | -1): MouthSection {
  const frame = ribbons.frameAt(curve, segment, at.x, at.y);
  const place = (across: number): JunctionVertex => {
    const off = across * frame.mitre;
    return {
      x: at.x + frame.acrossX * off,
      y: at.y + frame.acrossY * off,
      bed: frame.height + frame.bank * off,
    };
  };
  return { leftKerb: place(side * kerb), rightKerb: place(-side * kerb) };
}
