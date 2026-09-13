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
 * really fills rather than the massing that was asked for.
 */
import { Box3, BufferAttribute, BufferGeometry } from 'three';
import type { Point } from '../world/types.ts';
import { CHAMFER_WIDTH, FOUNDATION, type BuildingMassing, type Fit } from './building-plan.ts';

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
 * that was given. It is drawn with the shell's own matrix, so it is widened by
 * the amount the shell is taken in by and comes out {@link OUTLINE_WIDTH} wide
 * on every building whatever its fit. A shell stretched along the frontage to
 * reach a wall it shares is outlined by the scale it keeps across the frontage,
 * so its two ends are rimmed the width of the stretch more thinly — a
 * centimetre of a line a third of a metre wide.
 */
export function hullOf(massing: BuildingMassing, shell: BufferGeometry, box: Box3, fit: Fit): BufferGeometry {
  const reach = OUTLINE_WIDTH / fit.across;
  // The shell is centred on the lot, so the box around it is centred on the
  // origin and the ring of the footprint can be laid out there as well.
  const around = { ...massing, width: box.max.x - box.min.x, depth: box.max.z - box.min.z };
  const faces = facesOf(footprintRing(around));
  const bands = profileOf(shell, box, faces, reach);
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

  // The caps: a fan from the first corner, so the hull is closed and its rim
  // shows around the roof as well as around the walls.
  const floor = bands[0] as Band;
  const roof = bands[bands.length - 1] as Band;
  for (let i = 1; i + 1 < faces.length; i++) {
    const up = roof.ring;
    const down = floor.ring;
    flat(positions, normals, up[0] as Point, up[i] as Point, up[i + 1] as Point, roof.y1, true);
    flat(positions, normals, down[0] as Point, down[i] as Point, down[i + 1] as Point, floor.y0, false);
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
  /** How far out each face of the footprint stands, in the order `facesOf` gives. */
  reach: number[];
  /** Those faces as a ring of corners. */
  ring: Point[];
}

/**
 * The profile of a shell, band of height by band of height: how far out each
 * face of its footprint reaches over that height, plus the width of the outline.
 *
 * A face is measured from the triangles of the shell rather than from its
 * vertices, and a triangle reaches into every band its own height spans: a wall
 * of one quad from the ground to the roof has no vertex in between, and a band
 * that only asked its vertices would come out empty.
 *
 * Bands that reach the same distance are run together, so a building with
 * straight sides costs one band however tall it is.
 */
function profileOf(shell: BufferGeometry, box: Box3, faces: readonly Point[], reach: number): Band[] {
  const height = Math.max(box.max.y - box.min.y, HULL_BAND);
  const count = Math.max(1, Math.min(HULL_BANDS, Math.ceil(height / HULL_BAND)));
  const step = height / count;
  const out = new Float64Array(count * faces.length).fill(-Infinity);
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
    for (let k = 0; k < faces.length; k++) {
      const n = faces[k] as Point;
      let d = -Infinity;
      for (let v = 0; v < 3; v++) {
        d = Math.max(d, (array[t + v * 3] as number) * n.x + (array[t + v * 3 + 2] as number) * n.y);
      }
      for (let b = from; b <= to; b++) if (d > (out[b * faces.length + k] as number)) out[b * faces.length + k] = d;
    }
  }

  const bands: Band[] = [];
  for (let b = 0; b < count; b++) {
    const spread: number[] = [];
    for (let k = 0; k < faces.length; k++) {
      const measured = out[b * faces.length + k] as number;
      // A band no triangle reached takes the one below it, and the lowest band
      // falls back on the box: a hull is never narrower than nothing.
      const fallback = bands[bands.length - 1]?.reach[k] ?? 0;
      spread.push((measured === -Infinity ? fallback : measured) + reach);
    }
    // The hull starts below the ground, so the first band reaches down to the
    // footing, and the last one stands over the roof by the width of the outline.
    const y0 = b === 0 ? -FOUNDATION : box.min.y + b * step;
    const y1 = b === count - 1 ? box.max.y + reach : box.min.y + (b + 1) * step;
    const last = bands[bands.length - 1];
    if (last !== undefined && sameReach(last.reach, spread)) last.y1 = y1;
    else bands.push({ y0, y1, reach: spread, ring: ringOf(faces, spread) });
  }
  return bands;
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
 */
function ringOf(faces: readonly Point[], reach: readonly number[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < faces.length; i++) {
    const before = faces[(i + faces.length - 1) % faces.length] as Point;
    const here = faces[i] as Point;
    const d0 = reach[(i + faces.length - 1) % faces.length] as number;
    const d1 = reach[i] as number;
    const det = before.x * here.y - before.y * here.x;
    // Two faces that look the same way never cross. A footprint has no such
    // pair, but a shell measured to nothing could, so the corner falls back to
    // the face itself rather than to infinity.
    if (Math.abs(det) < 1e-9) out.push({ x: here.x * d1, y: here.y * d1 });
    else out.push({ x: (d0 * here.y - d1 * before.y) / det, y: (before.x * d1 - here.x * d0) / det });
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
 * frontage and `y` towards the road. It is the rectangle of the massing, with
 * the corner that faces a junction cut away exactly as the generator cuts it.
 */
function footprintRing(massing: BuildingMassing): Point[] {
  const hw = massing.width / 2;
  const hd = massing.depth / 2;
  const corners: Point[] = [
    { x: hw, y: hd },
    { x: -hw, y: hd },
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
  ];
  const cut = massing.chamfer === 0 ? 0 : Math.min(CHAMFER_WIDTH, massing.width * 0.25, hw, hd);
  const out: Point[] = [];
  for (let i = 0; i < corners.length; i++) {
    const corner = corners[i] as Point;
    if (cut > 0 && Math.sign(corner.x) === massing.chamfer && corner.y > 0) {
      const prev = corners[(i + 3) % 4] as Point;
      const next = corners[(i + 1) % 4] as Point;
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
