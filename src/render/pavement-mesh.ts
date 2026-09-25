/**
 * The pavement and the verges of a chunk, as geometry (spec sections 6.2, 10.2).
 *
 * `pavement.ts` cuts each piece out of a block, down to the kerb; this lays a
 * surface over it and a face down every edge of it. The face along the
 * carriageway is the kerb, and the face along the back of the pavement buries
 * its edge in the ground beside it. An edge on the chunk boundary takes no face,
 * because the piece in the next chunk carries on from it.
 *
 * Every vertex stands on the surface of the road beside it, `RoadCarve.surfaceAt`,
 * lifted by the tier's `vergeRise`: the one surface of `bed.ts`, so the pavement
 * meets the kerb at the carriageway's own height. The carve is never above that
 * surface. The surface bends with the road, so an edge is split where the
 * surface bends away from it: a long flat triangle would cut under the ground
 * on a crest.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import { BufferAttribute, BufferGeometry, ShapeUtils, Vector2 } from 'three';
import type { Point } from '../core/geom.ts';
import type { ChunkBounds } from '../world/chunks.ts';
import type { ChunkPavement } from '../world/pavement.ts';
import type { RoadTier } from '../world/types.ts';
import { TIERS } from '../world/tiers.ts';
import { SKIRT, SURFACE_ROAD, tag, vergeRise } from './road-section.ts';

/**
 * Metres an edge of a pavement surface may run, however straight the surface
 * under it is, so no triangle spans a stretch of road the refinement never
 * asked about.
 */
export const PAVEMENT_EDGE = 16;

/**
 * Metres the surface may stand off the middle of an edge before the edge is
 * split. A bed is straight between the points and knots of a road and bends at
 * each, so an edge across a bend is split until it follows it. The ground may
 * stand at most twice this through the surface between two vertices.
 */
const PAVEMENT_SAG = 0.01;

/** Metres below which an edge is never split, whatever the surface does. */
const PAVEMENT_SHORTEST = 0.5;

/**
 * Passes in which an edge is split for bending, counted from the first pass that
 * finds no edge too long. Each pass halves every edge it splits, so this takes
 * an edge of {@link PAVEMENT_EDGE} down to half a metre.
 * Where the surface steps from one road's bed to another's, no split makes the
 * edge across the step straight, and the passes are what stop it.
 */
const REFINE_PASSES = 5;

/** Keys an edge by its two vertices: more vertices than this in one piece cannot happen. */
const EDGE_KEY = 1 << 22;

/**
 * The height of the surface a pavement of a tier stands on at a place:
 * `RoadCarve.surfaceAt`, which prefers a road of that tier.
 */
export type SurfaceAt = (x: number, y: number, tier: RoadTier) => number;

/** Metres within which a vertex stands on a chunk boundary. */
const ON_BOUNDARY = 1e-4;

/** One vertex of a piece: where it stands, how high, and how far across its road the material reads it. */
export interface PavementVertex {
  x: number;
  y: number;
  h: number;
  across: number;
}

/** The top surface of a piece: its vertices, and its triangles wound anticlockwise on the map. */
export interface PavementMesh {
  vertices: PavementVertex[];
  faces: [number, number, number][];
}

/**
 * The top surface of a piece, refined until it follows the surface under it.
 * Nothing where the piece has no triangle to draw. The sweeps read this to ask
 * the ground against the surface.
 */
export function pavementTriangles(piece: ChunkPavement, surfaceAt: SurfaceAt): PavementMesh | undefined {
  const half = TIERS[piece.tier].width / 2;
  const rise = vergeRise(piece.tier);
  const vertices: PavementVertex[] = [];
  const rings = [piece.region.outer, ...piece.region.holes];
  const depths = [piece.depth.outer, ...piece.depth.holes];
  rings.forEach((ring, r) => {
    ring.forEach((p, i) => vertices.push({ x: p.x, y: p.y, h: surfaceAt(p.x, p.y, piece.tier) + rise, across: half + (depths[r]?.[i] ?? 0) }));
  });
  const flat = rings.map((ring) => ring.map((p) => new Vector2(p.x, p.y)));
  const faces: [number, number, number][] = [];
  for (const face of ShapeUtils.triangulateShape(flat[0] as Vector2[], flat.slice(1))) {
    const [a, b, c] = face as [number, number, number];
    faces.push(turn(vertices, a, b, c) > 0 ? [a, b, c] : [a, c, b]);
  }
  if (faces.length === 0) return undefined;
  refine(vertices, faces, (x, y) => surfaceAt(x, y, piece.tier) + rise);
  return { vertices, faces };
}

/** The surface of one piece of pavement or verge, with its faces down to the ground. */
export function pavementSurface(piece: ChunkPavement, bounds: ChunkBounds, surfaceAt: SurfaceAt): BufferGeometry | undefined {
  const top = pavementTriangles(piece, surfaceAt);
  if (top === undefined) return undefined;
  const { vertices, faces } = top;
  // An edge only one triangle holds is an edge of the piece, and the piece lies
  // to its left, since every triangle turns anticlockwise.
  const n = vertices.length;
  const held = new Map<number, number>();
  for (const [a, b, c] of faces) {
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const key = Math.min(p, q) * n + Math.max(p, q);
      held.set(key, (held.get(key) ?? 0) + 1);
    }
  }
  const skirts: [PavementVertex, PavementVertex][] = [];
  for (const [a, b, c] of faces) {
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      if (held.get(Math.min(p, q) * n + Math.max(p, q)) !== 1) continue;
      const from = vertices[p] as PavementVertex;
      const to = vertices[q] as PavementVertex;
      if (!alongBoundary(from, to, bounds)) skirts.push([from, to]);
    }
  }

  const total = n + skirts.length * 4;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  const across = new Float32Array(total);
  const index = new Uint32Array((faces.length + skirts.length * 2) * 3);
  let v = 0;
  const put = (p: PavementVertex, h: number, nx: number, ny: number, nz: number): void => {
    positions[v * 3] = p.x;
    positions[v * 3 + 1] = h;
    positions[v * 3 + 2] = p.y;
    normals[v * 3] = nx;
    normals[v * 3 + 1] = ny;
    normals[v * 3 + 2] = nz;
    uvs[v * 2] = p.x;
    uvs[v * 2 + 1] = p.y;
    across[v] = p.across;
    v++;
  };
  for (const p of vertices) put(p, p.h, 0, 1, 0);

  let at = 0;
  // The map's y runs into the scene's z, which turns the winding over: a
  // triangle anticlockwise on the map is wound the other way to face up.
  for (const [a, b, c] of faces) {
    index.set([a, c, b], at);
    at += 3;
  }

  const drop = vergeRise(piece.tier) + SKIRT;
  for (const [a, b] of skirts) {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    // The piece lies to the left of the edge, so the face looks to the right.
    const nx = (b.y - a.y) / length;
    const nz = -(b.x - a.x) / length;
    const base = v;
    put(a, a.h, nx, 0, nz);
    put(b, b.h, nx, 0, nz);
    put(b, b.h - drop, nx, 0, nz);
    put(a, a.h - drop, nx, 0, nz);
    // Top a, top b, bottom b turn anticlockwise seen from outside the piece.
    index.set([base, base + 1, base + 2, base, base + 2, base + 3], at);
    at += 6;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(index, 1));
  return tag(geometry, across, SURFACE_ROAD);
}

/** Twice the area of a triangle on the map: positive where it turns anticlockwise. */
function turn(vertices: readonly Point[], a: number, b: number, c: number): number {
  const pa = vertices[a] as Point;
  const pb = vertices[b] as Point;
  const pc = vertices[c] as Point;
  return (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
}

/**
 * Split every edge the surface bends away from, at its middle, in both
 * triangles that hold it, until none is left. An edge bends away where the
 * surface at its middle stands more than {@link PAVEMENT_SAG} off the straight
 * line between its ends, for {@link REFINE_PASSES} passes, and it is split
 * whatever the surface does while it is longer than {@link PAVEMENT_EDGE}. Both sides of an edge take the same new
 * vertex, so the surface has no crack where one triangle is split and its
 * neighbour is not. The longest edges go first, which keeps the triangles from
 * growing thin. A new vertex reads its place across the road as the middle of
 * the edge's two ends.
 */
function refine(vertices: PavementVertex[], faces: [number, number, number][], height: (x: number, y: number) => number): void {
  const longest = PAVEMENT_EDGE * PAVEMENT_EDGE;
  const shortest = PAVEMENT_SHORTEST * PAVEMENT_SHORTEST;
  /** Edges already asked and found straight, which no later pass asks again. */
  const straight = new Set<number>();
  // Passes in which no edge was too long, which are the passes that count
  // towards the limit on splitting for bending.
  let settled = 0;
  for (;;) {
    let anyLong = false;
    const bent = new Map<number, { a: number; b: number; length: number; h: number }>();
    for (const [a, b, c] of faces) {
      for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
        const lo = Math.min(p, q);
        const hi = Math.max(p, q);
        const key = lo * EDGE_KEY + hi;
        if (straight.has(key) || bent.has(key)) continue;
        const u = vertices[lo] as PavementVertex;
        const w = vertices[hi] as PavementVertex;
        const length = (u.x - w.x) ** 2 + (u.y - w.y) ** 2;
        const long = length > longest;
        anyLong ||= long;
        if (!long && (length <= shortest || settled >= REFINE_PASSES)) {
          straight.add(key);
          continue;
        }
        const h = height((u.x + w.x) / 2, (u.y + w.y) / 2);
        if (long || Math.abs(h - (u.h + w.h) / 2) > PAVEMENT_SAG) bent.set(key, { a: lo, b: hi, length, h });
        else straight.add(key);
      }
    }
    if (bent.size === 0) return;
    if (!anyLong) settled++;
    const order = [...bent.values()].sort((e, f) => f.length - e.length || e.a - f.a || e.b - f.b);
    // The triangles holding each vertex, so an edge finds the two that hold it.
    const around: number[][] = vertices.map(() => []);
    faces.forEach((face, f) => {
      for (const corner of face) (around[corner] as number[]).push(f);
    });
    // A triangle split in this pass waits for the next one, so every edge is
    // split in the triangles that really hold it.
    const split = new Set<number>();
    for (const edge of order) {
      const holders = (around[edge.a] as number[]).filter((f) => (faces[f] as number[]).includes(edge.b));
      if (holders.length === 0 || holders.some((f) => split.has(f))) continue;
      const u = vertices[edge.a] as PavementVertex;
      const w = vertices[edge.b] as PavementVertex;
      const m = vertices.length;
      vertices.push({ x: (u.x + w.x) / 2, y: (u.y + w.y) / 2, h: edge.h, across: (u.across + w.across) / 2 });
      for (const f of holders) {
        const face = faces[f] as [number, number, number];
        // The corner the edge starts at, going round the triangle its own way.
        const k = face.findIndex((corner, i) => {
          const next = face[(i + 1) % 3] as number;
          return (corner === edge.a && next === edge.b) || (corner === edge.b && next === edge.a);
        });
        const p = face[k] as number;
        const q = face[(k + 1) % 3] as number;
        const r = face[(k + 2) % 3] as number;
        faces[f] = [p, m, r];
        split.add(f);
        split.add(faces.length);
        faces.push([m, q, r]);
      }
    }
  }
}

/** True where an edge runs along one side of the chunk. */
function alongBoundary(a: Point, b: Point, bounds: ChunkBounds): boolean {
  const on = (p: number, q: number, line: number): boolean => Math.abs(p - line) < ON_BOUNDARY && Math.abs(q - line) < ON_BOUNDARY;
  return on(a.x, b.x, bounds.minX) || on(a.x, b.x, bounds.maxX) || on(a.y, b.y, bounds.minY) || on(a.y, b.y, bounds.maxY);
}
