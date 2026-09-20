/**
 * The outline of a building, as geometry (spec section 10.1).
 *
 * It is an inverted hull drawn back-face only: a shell a few centimetres
 * outside the building, wound so that only the far side of it is drawn. What
 * shows is the rim, which reads as a line around the building from the
 * top-down camera.
 *
 * The hull is the building's massing and not its facade. A shell around every
 * window reveal would cost as much again as the building and draw an outline
 * round detail the camera cannot see. It follows the shape band of height by
 * band, so a setback is outlined where it stands.
 *
 * `building-mesh.ts` builds it at every detail, and gives it the box the shell
 * really fills rather than the massing that was asked for. It is built square,
 * and leaned onto the lot with the shell.
 */
import { Box3, BufferAttribute, BufferGeometry, ShapeUtils, Vector2 } from 'three';
import type { Point } from '../world/types.ts';
import { CHAMFER_WIDTH, FOUNDATION, type BuildingMassing, type Fit, type Lean } from './building-plan.ts';
import { ringOf as shapeRing, type BuildingShape } from './building-shape.ts';

/** Metres the outline hull stands outside the shell it rims (spec section 10.1). */
export const OUTLINE_WIDTH = 0.35;

/**
 * Metres of height one band of an outline hull covers, and the most bands one
 * hull is cut into. A hull follows the shape of the building band by band, so a
 * setback is outlined where it stands rather than buried inside a box; a band
 * this deep costs a few dozen vertices and reads as a straight wall from above.
 */
const HULL_BAND = 1;
const HULL_BANDS = 80;

/**
 * The inverted hull that outlines a building (spec section 10.1). It is the
 * building's massing, not its facade: a shell around every window reveal would
 * cost as much again as the building and draw an outline round detail the
 * top-down camera cannot see.
 *
 * The hull is built around the box the shell really fills, because a crown
 * stands over the height that was asked for and a cornice outside the footprint
 * that was given. It is stretched, sheared and scaled with the shell, so each
 * of its faces is pushed out by the width that transform takes back and every
 * one of them comes out {@link OUTLINE_WIDTH} wide in the world — see
 * {@link pushOf}.
 *
 * The `footing` is how far the building carries its foundation wall below the
 * ground it stands on, in the frame the shell is built in. The outline reaches
 * down over it, so a building on a slope is outlined to the ground it meets
 * rather than to the ground its highest corner stands at.
 */
export function hullOf(
  massing: BuildingMassing,
  shell: BufferGeometry,
  box: Box3,
  fit: Fit,
  shape: BuildingShape,
  lean: Lean | undefined,
  footing: number,
): BufferGeometry {
  // The shell is centred on the lot, so the box around it is centred on the
  // origin and the ring of the footprint can be laid out there as well.
  const around = { width: box.max.x - box.min.x, depth: box.max.z - box.min.z };
  const ring = footprintRing(shape, around, massing.chamfer);
  const faces = facesOf(ring);
  const push = pushOf(ring, faces, fit, lean);
  // Height is scaled by the fit across the frontage alone, and the lean leaves
  // it alone, so the roof stands over the shell by the one width.
  const bands = profileOf(shell, box, ring, faces, push, OUTLINE_WIDTH / fit.across, footing);
  const positions: number[] = [];
  const normals: number[] = [];

  for (let b = 0; b < bands.length; b++) {
    const band = bands[b] as Band;
    wall(positions, normals, band.ring, faces, band.y0, band.y1);
    const next = bands[b + 1];
    if (next === undefined) continue;
    // The step between one band and the next, which is what an outline follows
    // round a setback. It looks up where the building draws in and down where it
    // reaches back out.
    for (let i = 0; i < faces.length; i++) {
      if (band.reach[i] === next.reach[i]) continue;
      const from = band.ring;
      const to = next.ring;
      const up = (band.reach[i] as number) > (next.reach[i] as number);
      const j = (i + 1) % faces.length;
      flat(positions, normals, from[i] as Point, from[j] as Point, to[j] as Point, band.y1, up);
      flat(positions, normals, from[i] as Point, to[j] as Point, to[i] as Point, band.y1, up);
    }
  }

  // The caps, so the hull is closed and its rim shows around the roof as well
  // as around the walls. An L and a U are not convex, so the ring is cut into
  // triangles rather than fanned from one corner.
  const floor = bands[0] as Band;
  const roof = bands[bands.length - 1] as Band;
  for (const [at, y, up] of [
    [roof.ring, roof.y1, true],
    [floor.ring, floor.y0, false],
  ] as const) {
    for (const face of capOf(at)) {
      const [i, j, k] = face as [number, number, number];
      flat(positions, normals, at[i] as Point, at[j] as Point, at[k] as Point, y, up);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  return geometry;
}

/** One slice of a hull: the ground it covers, and between which heights. */
interface Band {
  y0: number;
  y1: number;
  /** How far out the shell reaches along each face, in the order `facesOf` gives. */
  reach: number[];
  /** Those faces as a ring of corners. */
  ring: Point[];
}

/** How far a face is pushed out at each of its two ends, in the shell's units. */
type Push = readonly [number, number];

/**
 * How far each face of the footprint is pushed out, in the shell's own units,
 * so that all of them come out {@link OUTLINE_WIDTH} wide in the world.
 *
 * The hull is drawn with the shell's own matrix and leaned with it, so what it
 * is pushed out by here is not what the camera sees. The frontage is scaled by
 * `fit.along` and by the lean, the depth and the height by `fit.across` alone.
 * Pushing every face out by the same amount then rims the ends of a stretched
 * building metres wide where its front keeps a third of a metre.
 *
 * So each face is pushed by what the transform takes back. The lean changes
 * from one end of a wall to the other, which on a lot that leans hard is a
 * factor of two, so each face is measured at both of its ends and the wall
 * between them runs from the one to the other.
 */
function pushOf(ring: readonly Point[], faces: readonly Point[], fit: Fit, lean: Lean | undefined): Push[] {
  const out: Push[] = [];
  for (let i = 0; i < faces.length; i++) {
    const n = faces[i] as Point;
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    out.push([pushAt(n, a, fit, lean), pushAt(n, b, fit, lean)]);
  }
  return out;
}

/**
 * The push that comes out {@link OUTLINE_WIDTH} wide in the world at one place
 * on a face. For a face with unit normal `n`, a push of `d` comes out
 * `d / |J⁻ᵀ n|` wide, where `J` is the map from these units to the world: `x`
 * scaled by `along`, `z` and `y` by `across`, and `x` sheared along `z` by the
 * lean. `J` is read where the face stands, because the lean is not the same
 * over the whole building.
 */
function pushAt(n: Point, at: Point, fit: Fit, lean: Lean | undefined): number {
  const depth = at.y * fit.across;
  // The frontage's own scale there, and how far `x` moves there for each metre
  // of depth. Both are `leanGeometry` read at the one place.
  const along = fit.along * (lean === undefined ? 1 : lean.scale + lean.scaleSlope * depth);
  const shear = lean === undefined ? 0 : fit.across * (fit.along * lean.scaleSlope * at.x + lean.shiftSlope);
  return OUTLINE_WIDTH * Math.hypot(n.x / along, (n.y - (shear * n.x) / along) / fit.across);
}

/**
 * The profile of a shell, band of height by band of height: how far out each
 * face of its footprint reaches over that height. The width of the outline is
 * added to that where the ring is laid out, because a face is pushed out by a
 * different amount at each of its two ends.
 *
 * A face is measured from the triangles of the shell rather than from its
 * vertices, and a triangle reaches into every band its own height spans: a wall
 * of one quad from the ground to the roof has no vertex in between, and a band
 * that only asked its vertices would come out empty.
 *
 * Bands that reach the same distance are run together, so a building with
 * straight sides costs one band however tall it is.
 */
function profileOf(
  shell: BufferGeometry,
  box: Box3,
  ring: readonly Point[],
  faces: readonly Point[],
  push: readonly Push[],
  top: number,
  footing: number,
): Band[] {
  const height = Math.max(box.max.y - box.min.y, HULL_BAND);
  const count = Math.max(1, Math.min(HULL_BANDS, Math.ceil(height / HULL_BAND)));
  const step = height / count;
  const width = faces.length;
  // How far each face reaches over each band, and how far the whole shell does.
  const near = new Float64Array(count * width).fill(-Infinity);
  const all = new Float64Array(count * width).fill(-Infinity);
  const span = extentOf(ring);
  const array = (shell.getAttribute('position') as BufferAttribute).array as Float32Array;
  // The shells are not indexed, so three vertices in a row are one triangle.
  for (let t = 0; t + 8 < array.length; t += 9) {
    let low = Infinity;
    let high = -Infinity;
    for (let v = 0; v < 3; v++) {
      const y = array[t + v * 3 + 1] as number;
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
    const from = Math.max(0, Math.min(count - 1, Math.floor((low - box.min.y) / step)));
    const to = Math.max(from, Math.min(count - 1, Math.floor((high - box.min.y) / step)));
    for (let k = 0; k < width; k++) {
      const n = faces[k] as Point;
      const edge = span[k] as Extent;
      let mine = -Infinity;
      let any = -Infinity;
      for (let v = 0; v < 3; v++) {
        const x = array[t + v * 3] as number;
        const z = array[t + v * 3 + 2] as number;
        const d = x * n.x + z * n.y;
        if (d > any) any = d;
        // Only what stands along this face measures it. A face of an L or a U
        // looks into the notch, and the far wing is the furthest thing in that
        // direction: measured over the whole shell, the notch would fill in.
        const u = (x - edge.x) * -n.y + (z - edge.y) * n.x;
        if (u >= -edge.slack && u <= edge.length + edge.slack && d > mine) mine = d;
      }
      for (let b = from; b <= to; b++) {
        const at = b * width + k;
        if (mine > (near[at] as number)) near[at] = mine;
        if (any > (all[at] as number)) all[at] = any;
      }
    }
  }

  const bands: Band[] = [];
  // How far out a corner of the band may stand, face by face: the furthest the
  // shell itself reaches that way, and the width of the outline. It is what
  // holds a corner in when one face is measured well inside its neighbours —
  // the far corner of a building falls inside the slack of a chamfer's edge,
  // and two faces that cross behind the shell cross a long way outside it.
  let bound: number[] = [];
  for (let b = 0; b < count; b++) {
    const spread: number[] = [];
    const limit: number[] = [];
    for (let k = 0; k < width; k++) {
      const measured = near[b * width + k] as number;
      // A face with nothing standing along it in this band is pushed out until
      // it binds on nothing: the whole shell is inside it, and the ring closes
      // on its neighbours instead. That is what drops the notch of an L above
      // the wing that cuts it. A band the shell does not reach at all takes the
      // one below it, and the lowest band falls back on the box.
      const empty = all[b * width + k] as number;
      const fallback = empty === -Infinity ? (bands[bands.length - 1]?.reach[k] ?? 0) : empty;
      const ends = push[k] as Push;
      spread.push(measured === -Infinity ? fallback : measured);
      // A band the shell does not reach at all holds nothing in: it has
      // nothing to measure a limit from, and the band below it is not its own.
      limit.push(empty === -Infinity ? (bound[k] ?? Infinity) : empty + Math.max(ends[0], ends[1]));
    }
    bound = limit;
    // The hull starts below the ground, so the first band reaches down to the
    // footing, and the last one stands over the roof by the width of the outline.
    const y0 = b === 0 ? -(FOUNDATION + footing) : box.min.y + b * step;
    const y1 = b === count - 1 ? box.max.y + top : box.min.y + (b + 1) * step;
    const last = bands[bands.length - 1];
    if (last !== undefined && sameReach(last.reach, spread)) last.y1 = y1;
    else bands.push({ y0, y1, reach: spread, ring: ringOf(faces, spread, push, limit) });
  }
  return bands;
}

/** Where one edge of a footprint ring starts, and how far it runs. */
interface Extent {
  x: number;
  y: number;
  length: number;
  /**
   * Metres past each end of the edge that still count as standing along it. A
   * cornice overhangs the footprint it is given, and a chamfer cuts a corner
   * back, so a wall runs a little past the edge that names it.
   */
  slack: number;
}

/** Metres past the end of an edge that still count as standing along it. */
const EDGE_SLACK = 3;

/** Every edge of a ring as where it starts and how far it runs. */
function extentOf(ring: readonly Point[]): Extent[] {
  const out: Extent[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    out.push({ x: a.x, y: a.y, length: Math.hypot(b.x - a.x, b.y - a.y), slack: EDGE_SLACK });
  }
  return out;
}

/** A ring cut into triangles, as triples of indices into it. */
function capOf(ring: readonly Point[]): number[][] {
  const contour = ring.map((p) => new Vector2(p.x, p.y));
  return ShapeUtils.triangulateShape(contour, []);
}

function sameReach(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The outward unit normal of every edge of a footprint ring, in edge order. */
function facesOf(ring: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const nx = b.y - a.y;
    const ny = -(b.x - a.x);
    const span = Math.hypot(nx, ny) || 1;
    out.push({ x: nx / span, y: ny / span });
  }
  return out;
}

/**
 * The ring bounded by a set of faces, each pushed out to its own distance. A
 * corner is where two neighbouring faces cross, so pushing one face out moves
 * the two corners of it and nothing else.
 *
 * Two faces that cross at a narrow angle cross a long way out, and a face
 * measured inside its neighbours turns a corner of the outline into a spike
 * metres long. So every corner is held inside `limit`: how far the shell itself
 * reaches that way, and the width of the outline. Nothing of the hull then
 * stands further outside the building than the rim is wide.
 */
function ringOf(faces: readonly Point[], reach: readonly number[], push: readonly Push[], limit: readonly number[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < faces.length; i++) {
    const back = (i + faces.length - 1) % faces.length;
    const before = faces[back] as Point;
    const here = faces[i] as Point;
    // The face behind ends at this corner, and the face here starts at it, so
    // each is pushed out by what it is pushed out by at this end of itself.
    const d0 = (reach[back] as number) + ((push[back] as Push)[1] as number);
    const d1 = (reach[i] as number) + ((push[i] as Push)[0] as number);
    const det = before.x * here.y - before.y * here.x;
    // Two faces that look the same way never cross. A footprint has no such
    // pair, but a shell measured to nothing could, so the corner falls back to
    // the face itself rather than to infinity.
    const at =
      Math.abs(det) < 1e-9
        ? { x: here.x * d1, y: here.y * d1 }
        : { x: (d0 * here.y - d1 * before.y) / det, y: (before.x * d1 - here.x * d0) / det };
    out.push(held(at, faces, limit));
  }
  return out;
}

/**
 * A corner pulled back inside every face's limit. It is moved square to the
 * face it stands furthest outside, which is the shortest way back onto that
 * face. Moving it back for one face may put it outside another, so the move is
 * made again until nothing stands outside, and at most once per face.
 */
function held(at: Point, faces: readonly Point[], limit: readonly number[]): Point {
  const out = { x: at.x, y: at.y };
  for (let pass = 0; pass < faces.length; pass++) {
    let worst = -Infinity;
    let which = -1;
    for (let k = 0; k < faces.length; k++) {
      const n = faces[k] as Point;
      const over = out.x * n.x + out.y * n.y - (limit[k] as number);
      if (over > worst) {
        worst = over;
        which = k;
      }
    }
    if (worst <= 0 || which < 0) break;
    const n = faces[which] as Point;
    out.x -= n.x * worst;
    out.y -= n.y * worst;
  }
  return out;
}

/**
 * One wall of a band, wound to look outward. Drawing the hull back faces only
 * then leaves the far side of it standing outside the building that covers the
 * near side; a hull wound the other way would hide the building instead.
 */
function wall(
  positions: number[],
  normals: number[],
  ring: readonly Point[],
  faces: readonly Point[],
  y0: number,
  y1: number,
): void {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const face = faces[i] as Point;
    const n: [number, number, number] = [face.x, 0, face.y];
    push(positions, normals, [a.x, y0, a.y], [b.x, y1, b.y], [b.x, y0, b.y], n);
    push(positions, normals, [a.x, y0, a.y], [a.x, y1, a.y], [b.x, y1, b.y], n);
  }
}

/** One level triangle, wound to look up or down as asked. */
function flat(positions: number[], normals: number[], a: Point, b: Point, c: Point, y: number, up: boolean): void {
  const looksUp = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y) > 0;
  const n: [number, number, number] = up ? [0, 1, 0] : [0, -1, 0];
  if (looksUp === up) push(positions, normals, [a.x, y, a.y], [b.x, y, b.y], [c.x, y, c.y], n);
  else push(positions, normals, [a.x, y, a.y], [c.x, y, c.y], [b.x, y, b.y], n);
}

function push(
  positions: number[],
  normals: number[],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  n: readonly [number, number, number],
): void {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  for (let i = 0; i < 3; i++) normals.push(n[0], n[1], n[2]);
}

/**
 * The ground a building covers, as a ring in its own frame: `x` across the
 * frontage and `y` towards the road. It is the outline of the shape the
 * building is massed in, laid out on the ground the shell really covers, with
 * the corner that faces a junction cut away exactly as the generator cuts it.
 */
function footprintRing(shape: BuildingShape, rect: { width: number; depth: number }, chamfer: number): Point[] {
  const ring = shapeRing(shape, rect);
  const hd = rect.depth / 2;
  const cut = chamfer === 0 ? 0 : Math.min(CHAMFER_WIDTH, rect.width * 0.25, rect.width / 2, hd);
  if (cut <= 0) return ring;
  const out: Point[] = [];
  for (let i = 0; i < ring.length; i++) {
    const corner = ring[i] as Point;
    // The corner the chamfer cuts is the one at the front of the lot, on the
    // side the junction stands.
    if (Math.sign(corner.x) === chamfer && corner.y > hd - 1e-6) {
      const prev = ring[(i + ring.length - 1) % ring.length] as Point;
      const next = ring[(i + 1) % ring.length] as Point;
      out.push(towards(corner, prev, cut), towards(corner, next, cut));
    } else {
      out.push(corner);
    }
  }
  return out;
}

/** A point `distance` metres from `from` along the way to `to`. */
function towards(from: Point, to: Point, distance: number): Point {
  const span = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const t = Math.min(1, distance / span);
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

/**
 * A convex ring pushed out by the same distance all the way round. Each corner
 * moves along the bisector of the two edges that meet there, so every edge of
 * the ring ends up exactly `by` metres outside where it started.
 */
function expand(ring: readonly Point[], by: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < ring.length; i++) {
    const before = outward(ring[(i + ring.length - 1) % ring.length] as Point, ring[i] as Point);
    const after = outward(ring[i] as Point, ring[(i + 1) % ring.length] as Point);
    const share = 1 + before.x * after.x + before.y * after.y;
    const p = ring[i] as Point;
    out.push({ x: p.x + (by * (before.x + after.x)) / share, y: p.y + (by * (before.y + after.y)) / share });
  }
  return out;
}

/**
 * The way an edge of a footprint faces. The ring is centred on the origin, so
 * the normal that points away from it is the one that points out of the ring.
 */
function outward(a: Point, b: Point): Point {
  const nx = b.y - a.y;
  const ny = -(b.x - a.x);
  const span = Math.hypot(nx, ny) || 1;
  const n = { x: nx / span, y: ny / span };
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  return n.x * midX + n.y * midY < 0 ? { x: -n.x, y: -n.y } : n;
}
