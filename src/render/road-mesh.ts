/**
 * The geometry of the roads in one chunk (spec sections 6.1, 6.2, 10.2).
 *
 * A road is a curve, so its surface is lofted along it: a cross section is
 * placed at every point of the run and `LoftGeometry` skins the sections
 * together. On the ground the section is the carriageway alone: the pavement and
 * the verge are cut out of each block by `pavement.ts` and drawn by
 * `pavement-mesh.ts`, so no road lays its pavement over another road. A deck or
 * a bore has no block beside it, and its section carries the whole width the
 * tier claims. The material tells the parts apart by how far across the road
 * each vertex stands.
 *
 * Everything is placed on the road bed that {@link RoadRibbons} answers with, so
 * a run cut at a chunk boundary and its other half in the next chunk stand on
 * the same sections: the frame at a place is a function of the curve and the
 * place, never of the chunk. That is the same rule the ground mesh follows, and
 * it is what makes the seam invisible rather than stitched. The same frames say
 * where a run turns too sharply to sweep through, and the loft is cut there and
 * bevelled across the outside of the turn.
 *
 * Where roads meet they are not lofted through one another. A junction is cut
 * out of every road that reaches it and the ground between the cuts is drawn by
 * `junction-mesh.ts`; the cross section itself and the lines painted on it are
 * `road-section.ts`. Both come out through this file.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { LoftGeometry } from 'three/examples/jsm/geometries/LoftGeometry.js';
import type { ChunkRoad, WorldChunk } from '../world/chunks.ts';
import type { RoadFrame, RoadRibbons } from '../world/ribbon.ts';
import { piecesOf, trimRun, type Piece } from '../world/road-pieces.ts';
import { PARAPET_HEIGHT } from '../world/decks.ts';
import { footprintHalfWidth, TIERS, TRAM_LANE } from '../world/tiers.ts';
import type { Point, RoadTier } from '../world/types.ts';
import { buildChunkCorridors } from './corridor-mesh.ts';
import { junctionSurfaces, pavesAs, type HeightAt } from './junction-mesh.ts';
import { pavementSurface, type SurfaceAt } from './pavement-mesh.ts';
import {
  beam,
  between,
  DECK_DEPTH,
  isMarked,
  markingsOf,
  merge,
  MARK_RAISE,
  PAINT_WIDTH,
  place,
  roadSection,
  SKIRT,
  structureSection,
  SURFACE_RAISE,
  SURFACE_ROAD,
  SURFACE_STRUCTURE,
  tag,
  TIER_ORDER,
  type Marking,
  type SectionPoint,
} from './road-section.ts';

// The cross section and the junction surfaces are next door. Both come out
// through this file, so a caller asks one place for a chunk's road geometry.
export type { HeightAt } from './junction-mesh.ts';
export { trimRun } from '../world/road-pieces.ts';
export {
  isMarked,
  markingsOf,
  roadSection,
  structureSection,
  SURFACE_ROAD,
  SURFACE_STRUCTURE,
  TIER_ORDER,
  vergeRise,
  type Marking,
  type SectionPoint,
} from './road-section.ts';

/** The geometry of one run of road. */
export interface RunGeometry {
  run: ChunkRoad;
  /**
   * The lofted surface: one section of `roadSection(run.tier)` per point on the
   * ground, and of `structureSection(run.tier)` on a deck or in a bore. A run
   * that turns somewhere too sharply to mitre, or leaves the ground, is cut
   * there, so it comes back in more than one piece.
   */
  surfaces: BufferGeometry[];
  /**
   * The bevels that close the outside of those turns, merged into one part. A
   * run with no turn that sharp has none.
   */
  joints: BufferGeometry[];
  /** The decks, parapets and portals that carry it, where it stands off the ground. */
  structures: BufferGeometry[];
}

/** The geometry of one tier inside one chunk. */
export interface TierGeometry {
  tier: RoadTier;
  /** The runs of the tier, each cut short of the junctions it meets. */
  runs: RunGeometry[];
  /**
   * The junction surfaces paved as this tier: the carriageway of every junction
   * whose widest road is this tier.
   */
  junctions: BufferGeometry[];
  /** The pieces of pavement and verge drawn in this tier's material. */
  pavement: BufferGeometry[];
  /** The piers under this tier's decks, and the tram track down its roads (`corridor-mesh.ts`). */
  corridors: BufferGeometry[];
  /** The painted lines as flat triangles, three numbers per vertex. Empty where the tier is unmarked. */
  markings: Float32Array;
  /** Which way each of those vertices faces, three numbers each. */
  markingNormals: Float32Array;
  /** The colour of each of those vertices, three numbers each. */
  markingTints: Float32Array;
}

/** The painted lines of a tier as they are laid, before they are packed. */
interface PaintBuffers {
  positions: number[];
  normals: number[];
  tints: number[];
}

/**
 * The parts of one tier that stand off the ground and so cast a shadow worth
 * drawing: every part of a run that has a deck or a portal, and the piers. The
 * rest is paving laid on the ground, which could shade nothing but itself.
 */
export function raisedPartsOf(tier: TierGeometry): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (const run of tier.runs) if (run.structures.length > 0) out.push(...run.surfaces, ...run.joints, ...run.structures);
  out.push(...tier.corridors);
  return out;
}

/** Everything of one tier that goes into a batch, surfaces and structures alike. */
export function partsOf(tier: TierGeometry): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (const run of tier.runs) out.push(...run.surfaces, ...run.joints, ...run.structures);
  out.push(...tier.junctions, ...tier.pavement, ...tier.corridors);
  return out;
}

/**
 * Draw calls one chunk spends on its roads: a batch of geometry in each of
 * `cells` cells and a batch of markings for each tier that runs through it. A
 * tier with no run, no junction, no pavement, no pier and no tram track in the
 * chunk costs nothing.
 * `chunk-cost.ts` adds this to what the rest of a chunk costs.
 */
export function roadDrawCalls(chunk: WorldChunk, cells = 1): number {
  let calls = 0;
  for (const tier of TIER_ORDER) {
    const drawn =
      chunk.roads.some((run) => run.tier === tier) ||
      chunk.junctions.some((junction) => pavesAs(junction, tier)) ||
      chunk.pavement.some((piece) => piece.tier === tier) ||
      chunk.piers.some((pier) => pier.tier === tier) ||
      chunk.tram.some((run) => run.tier === tier) ||
      chunk.tramCrossings.some((crossing) => crossing.tier === tier);
    if (!drawn) continue;
    calls += cells + (isMarked(tier) ? 1 : 0);
  }
  return calls;
}

/**
 * How thick the parapet that rims a deck is. The parapet stands
 * {@link PARAPET_HEIGHT} high, which `decks.ts` owns: the physics puts a wall of
 * that height on the deck, so the wall the car is held by and the wall the
 * player sees are one.
 */
const PARAPET_WIDTH = 0.4;

/** Metres of headroom in a tunnel bore, and the portal that frames its mouth. */
const BORE_RISE = 5.5;

const PORTAL_MARGIN = 1.6;

const PORTAL_DEPTH = 1.2;

/**
 * Build the road geometry of one chunk, one entry per tier that runs through it.
 * The entries come back in {@link TIER_ORDER}, so two chunks of a world batch
 * their tiers the same way. `surfaceAt` is the surface drawn at a place beside
 * a road, `RoadCarve.surfaceAt`, which the pavement stands on.
 */
export function buildChunkRoads(chunk: WorldChunk, ribbons: RoadRibbons, surfaceAt: SurfaceAt): TierGeometry[] {
  const out: TierGeometry[] = [];
  const junctions = new Map<RoadTier, BufferGeometry[]>();
  for (const junction of chunk.junctions) {
    for (const surface of junctionSurfaces(junction, ribbons, (x, y) => surfaceAt(x, y, junction.tier))) {
      const list = junctions.get(surface.tier);
      if (list === undefined) junctions.set(surface.tier, [surface.geometry]);
      else list.push(surface.geometry);
    }
  }
  const pavement = new Map<RoadTier, BufferGeometry[]>();
  for (const piece of chunk.pavement) {
    const geometry = pavementSurface(piece, chunk.bounds, surfaceAt);
    if (geometry === undefined) continue;
    const list = pavement.get(piece.tier);
    if (list === undefined) pavement.set(piece.tier, [geometry]);
    else list.push(geometry);
  }
  const corridors = new Map<RoadTier, BufferGeometry[]>();
  for (const part of buildChunkCorridors(chunk, ribbons, surfaceAt)) {
    const list = corridors.get(part.tier);
    if (list === undefined) corridors.set(part.tier, [part.geometry]);
    else list.push(part.geometry);
  }
  // The curve segments the tram runs down. No paint is laid on its lane there,
  // because the lane is the tram's and a line would show between the rails.
  const tracked = new Set<string>();
  for (const run of chunk.tram) for (let k = 0; k + 1 < run.points.length; k++) tracked.add(`${run.curve}:${run.from + k}`);
  for (const tier of TIER_ORDER) {
    const runs = chunk.roads.filter((run) => run.tier === tier).flatMap((run) => trimRun(run, ribbons));
    const paved = junctions.get(tier) ?? [];
    // Each piece of pavement is a part of its own, so it goes into the cell it
    // stands in rather than stretching one part over the whole chunk.
    const kerbside = pavement.get(tier) ?? [];
    const carried = corridors.get(tier) ?? [];
    if (runs.length === 0 && paved.length === 0 && kerbside.length === 0 && carried.length === 0) continue;
    const ground = roadSection(tier);
    const raised = structureSection(tier);
    const markings = markingsOf(tier);
    const built: RunGeometry[] = [];
    const paint: PaintBuffers = { positions: [], normals: [], tints: [] };
    for (const run of runs) {
      const pieces = piecesOf(run, ribbons);
      const off = (segment: number): boolean => run.bridges.includes(segment) || run.tunnels.includes(segment);
      // The joints are one part rather than one each: a bevel is a handful of
      // triangles, and a batch pays for every part it is filled from.
      const joints = jointsOf(pieces, (segment) => (off(segment) ? raised : ground));
      built.push({
        run,
        surfaces: pieces.flatMap((piece) =>
          stretchesOn(piece, off).map((stretch) => surfaceOf(stretch.piece, stretch.off ? raised : ground)),
        ),
        joints: joints.length > 0 ? [merge(joints)] : [],
        structures: structuresOf(run, pieces, ribbons, tier, raised),
      });
      const onTrack = (segment: number): boolean => tracked.has(`${run.curve}:${run.from + segment}`);
      for (const piece of pieces) {
        for (const marking of markings) {
          const inLane = Math.abs(marking.across) < TRAM_LANE.halfWidth;
          paintMarking(piece, marking, paint, (i) => inLane && onTrack(piece.from + i));
        }
      }
    }
    out.push({
      tier,
      runs: built,
      junctions: paved,
      pavement: kerbside,
      corridors: carried,
      markings: new Float32Array(paint.positions),
      markingNormals: new Float32Array(paint.normals),
      markingTints: new Float32Array(paint.tints),
    });
  }
  return out;
}


/**
 * A piece cut where it leaves the ground and where it lands again, so each
 * stretch is lofted in one section. `off` says whether a segment of the run
 * stands on a deck or in a bore. The two stretches either side of a cut share
 * the point and its frame.
 */
function stretchesOn(piece: Piece, off: (segment: number) => boolean): { piece: Piece; off: boolean }[] {
  const out: { piece: Piece; off: boolean }[] = [];
  const segments = piece.points.length - 1;
  let start = 0;
  for (let k = 1; k <= segments; k++) {
    if (k < segments && off(piece.from + k) === off(piece.from + start)) continue;
    out.push({
      piece: { from: piece.from + start, points: piece.points.slice(start, k + 1), frames: piece.frames.slice(start, k + 1) },
      off: off(piece.from + start),
    });
    start = k;
  }
  return out;
}

/** The piece covering a run segment, and where in that piece the segment starts. */
function pieceAt(pieces: readonly Piece[], segment: number): { piece: Piece; at: number } | undefined {
  for (const piece of pieces) {
    const at = segment - piece.from;
    if (at >= 0 && at < piece.points.length - 1) return { piece, at };
  }
  return undefined;
}

/** The road surface of one piece of a run: one section per point, skinned together. */
function surfaceOf(piece: Piece, section: readonly SectionPoint[]): BufferGeometry {
  const sections = piece.points.map((point, i) =>
    section.map((s) => place(point, piece.frames[i] as RoadFrame, s.across, s.rise)),
  );
  const geometry = new LoftGeometry(sections, { closed: false });
  const count = geometry.getAttribute('position').count;
  const across = new Float32Array(count);
  for (let v = 0; v < count; v++) across[v] = (section[v % section.length] as SectionPoint).across;
  return tag(geometry, across, SURFACE_ROAD);
}

/**
 * The bevel that closes the outside of a turn too sharp to mitre.
 *
 * The two pieces beside such a turn end and start at the same point on
 * different frames, so the road is cut open there: on the inside of the turn
 * the two surfaces overlap, and on the outside they leave a wedge of ground
 * showing through the road. The wedge is as long as the mitre would have moved
 * the outer corner, which is metres on an ordinary bend of an arterial.
 *
 * The bevel is the outer half of the cross section swung from the frame the
 * road arrived on to the frame it leaves on, at the point itself. It carries
 * the whole outer half of the section it is given, so the joint
 * matches the two pieces it fills between, band for band. The inner half is
 * left out, because the two pieces already cover it twice over.
 */
function jointOf(point: Point, before: RoadFrame, after: RoadFrame, section: readonly SectionPoint[]): BufferGeometry | undefined {
  // The two frames turn one way round the point. The road bends towards the
  // side the frames turn to, so the wedge stands on the other one.
  const turn = before.acrossX * after.acrossY - before.acrossY * after.acrossX;
  if (turn === 0) return undefined;
  const outer = turn > 0 ? -1 : 1;
  // The section from the centreline out to the outer edge. The carriageway is
  // flat between the kerbs, so the centreline point closes the wedge exactly.
  const half: SectionPoint[] = section.filter((s) => Math.sign(s.across) === outer);
  if (half.length === 0) return undefined;
  const middle: SectionPoint = { across: 0, rise: SURFACE_RAISE };
  const strip = outer < 0 ? [...half, middle] : [middle, ...half];

  const quads = strip.length - 1;
  const positions = new Float32Array(quads * 4 * 3);
  const normals = new Float32Array(quads * 4 * 3);
  const uvs = new Float32Array(quads * 4 * 2);
  const across = new Float32Array(quads * 4);
  const index = new Uint32Array(quads * 6);
  // The frame the joint is shaded in: the across axis of the road through the
  // turn, and up. A face keeps the normal its band has along the road, so the
  // bevel is lit as the surfaces each side of it are.
  const axisX = before.acrossX + after.acrossX;
  const axisY = before.acrossY + after.acrossY;
  const axis = Math.hypot(axisX, axisY);
  if (axis < 1e-9) return undefined;
  let v = 0;
  let at = 0;
  for (let k = 0; k + 1 < strip.length; k++) {
    const s = strip[k] as SectionPoint;
    const t = strip[k + 1] as SectionPoint;
    const corners = [
      { point: place(point, before, s.across, s.rise), across: s.across },
      { point: place(point, before, t.across, t.rise), across: t.across },
      { point: place(point, after, t.across, t.rise), across: t.across },
      { point: place(point, after, s.across, s.rise), across: s.across },
    ];
    // The band's own normal, taken across the section: level along the
    // carriageway and the pavement, and outwards up a kerb face or a skirt.
    const da = t.across - s.across;
    const dr = t.rise - s.rise;
    const length = Math.hypot(da, dr);
    if (length < 1e-9) continue;
    const nx = ((-dr / length) * axisX) / axis;
    const ny = da / length;
    const nz = ((-dr / length) * axisY) / axis;
    const base = v;
    for (const corner of corners) {
      positions[v * 3] = corner.point.x;
      positions[v * 3 + 1] = corner.point.y;
      positions[v * 3 + 2] = corner.point.z;
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;
      uvs[v * 2] = corner.point.x;
      uvs[v * 2 + 1] = corner.point.z;
      across[v] = corner.across;
      v++;
    }
    // Wound by the way the four corners turn about the band's own normal, so a
    // left turn and a right one both face outwards.
    const a = (corners[0] as { point: Vector3 }).point;
    const b = (corners[1] as { point: Vector3 }).point;
    const c = (corners[2] as { point: Vector3 }).point;
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const wx = c.x - a.x;
    const wy = c.y - a.y;
    const wz = c.z - a.z;
    const facing = (uy * wz - uz * wy) * nx + (uz * wx - ux * wz) * ny + (ux * wy - uy * wx) * nz;
    const order = facing >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    for (const step of order) index[at++] = base + step;
  }
  if (at === 0) return undefined;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions.subarray(0, v * 3), 3));
  geometry.setAttribute('normal', new BufferAttribute(normals.subarray(0, v * 3), 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs.subarray(0, v * 2), 2));
  geometry.setIndex(new BufferAttribute(index.subarray(0, at), 1));
  return tag(geometry, across.subarray(0, v), SURFACE_ROAD);
}

/**
 * The bevels of a run: one at each turn its pieces were cut at. Two pieces are
 * cut at the same turn only where the second carries on from the first, so a
 * run cut short by a junction takes no joint at the cut. A joint takes the
 * section of the segment it leaves on, which is the carriageway alone unless
 * that segment is on a deck or in a bore.
 */
function jointsOf(pieces: readonly Piece[], sectionOf: (segment: number) => readonly SectionPoint[]): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (let i = 0; i + 1 < pieces.length; i++) {
    const piece = pieces[i] as Piece;
    const next = pieces[i + 1] as Piece;
    if (next.from !== piece.from + piece.points.length - 1) continue;
    const before = piece.frames[piece.frames.length - 1] as RoadFrame;
    const after = next.frames[0] as RoadFrame;
    const joint = jointOf(next.points[0] as Point, before, after, sectionOf(next.from));
    if (joint !== undefined) out.push(joint);
  }
  return out;
}

/**
 * The structures a run needs: a deck under every stretch carried over the
 * ground, with a parapet each side of it, and a portal at every mouth of a bore.
 * A stretch cut by a chunk boundary gives a piece to each side, and the two meet
 * on the section they share.
 */
function structuresOf(
  run: ChunkRoad,
  pieces: readonly Piece[],
  ribbons: RoadRibbons,
  tier: RoadTier,
  section: readonly SectionPoint[],
): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const outer = footprintHalfWidth(tier);
  // A parapet stands on the outer edge of the surface, whatever height the
  // tier's section leaves it at: a pavement, a verge or the carriageway itself.
  const deckTop = (section[1] as SectionPoint).rise;
  for (const stretch of stretchesOf(run.bridges)) {
    // A deck is swept like the surface over it, so it is cut where the surface
    // is: at a chunk boundary, and at a turn too sharp to mitre.
    for (const piece of pieces) {
      const lo = Math.max(stretch.from, piece.from);
      const hi = Math.min(stretch.to, piece.from + piece.points.length - 2);
      if (lo > hi) continue;
      const points = piece.points.slice(lo - piece.from, hi - piece.from + 2);
      const span = piece.frames.slice(lo - piece.from, hi - piece.from + 2);
      out.push(beam(points, span, -outer, outer, -SKIRT - DECK_DEPTH, -SKIRT));
      out.push(beam(points, span, -outer, -outer + PARAPET_WIDTH, deckTop, deckTop + PARAPET_HEIGHT));
      out.push(beam(points, span, outer - PARAPET_WIDTH, outer, deckTop, deckTop + PARAPET_HEIGHT));
    }
  }
  for (const stretch of stretchesOf(run.tunnels)) {
    // A stretch that reaches the end of the run may carry on into the next
    // chunk, so the curve says where the bore really opens.
    if (!ribbons.isTunnel(run.curve, run.from + stretch.from - 1)) {
      const mouth = pieceAt(pieces, stretch.from);
      if (mouth !== undefined) out.push(portal(mouth.piece, mouth.at, tier, -1));
    }
    if (!ribbons.isTunnel(run.curve, run.from + stretch.to + 1)) {
      const mouth = pieceAt(pieces, stretch.to);
      if (mouth !== undefined) out.push(portal(mouth.piece, mouth.at + 1, tier, 1));
    }
  }
  return out;
}

/** The runs of consecutive indices in an ascending list, as first and last segment. */
function stretchesOf(indices: readonly number[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const i of indices) {
    const last = out[out.length - 1];
    if (last !== undefined && last.to === i - 1) last.to = i;
    else out.push({ from: i, to: i });
  }
  return out;
}

/**
 * The portal framing one mouth of a bore: two jambs and a lintel around the
 * opening, standing out of the hillside the road disappears into. `out` is -1
 * where the road enters the bore and 1 where it leaves it, so the portal always
 * stands on the open side of the mouth.
 */
function portal(piece: Piece, at: number, tier: RoadTier, out: number): BufferGeometry {
  const spec = TIERS[tier];
  const bore = spec.width / 2 + spec.verge;
  const edge = bore + PORTAL_MARGIN;
  const top = BORE_RISE + PORTAL_MARGIN;
  const mouth = piece.points[at] as Point;
  const frame = piece.frames[at] as RoadFrame;
  // Along the road is across it turned a quarter, and the portal stands on the
  // open side of the mouth. The sweep always runs the way the road does, so the
  // ring the beam is wound as still faces outward.
  const open: Point = { x: mouth.x + frame.acrossY * out * PORTAL_DEPTH, y: mouth.y - frame.acrossX * out * PORTAL_DEPTH };
  const face: Point[] = out > 0 ? [mouth, open] : [open, mouth];
  const frames = [frame, frame];
  // The jambs stop where the lintel starts, so no two faces of the frame stand
  // in the same plane for the camera to fight over.
  const parts = [
    beam(face, frames, -edge, -bore, 0, BORE_RISE),
    beam(face, frames, bore, edge, 0, BORE_RISE),
    beam(face, frames, -edge, edge, BORE_RISE, top),
  ];
  return merge(parts);
}

/**
 * Lay one painted line along a piece of a run, as a flat strip on the road: two
 * triangles per stretch of paint, six vertices of three numbers each. The
 * strip lies in the plane of the carriageway under it, which is straight
 * between two points of the curve, so it needs no more vertices than the road.
 * The dash pattern is measured from the start of the whole curve rather than of
 * the piece, so the dashes of a road that crosses a chunk boundary carry
 * straight on. A segment of the piece `bare` names is left unpainted.
 */
function paintMarking(piece: Piece, marking: Marking, out: PaintBuffers, bare: (segment: number) => boolean): void {
  const period = marking.dash + marking.gap;
  const [r, g, blue] = marking.colour;
  const half = (marking.width ?? PAINT_WIDTH) / 2;
  const rise = SURFACE_RAISE + MARK_RAISE;
  const normal = new Vector3();
  const paint = (a0: Vector3, a1: Vector3, b0: Vector3, b1: Vector3): void => {
    // Wound so the strip faces up, whichever way the road runs.
    normal.subVectors(a1, a0).cross(new Vector3().subVectors(b0, a0)).normalize();
    const up = normal.y >= 0;
    if (!up) normal.negate();
    const corners = up ? [a0, a1, b1, a0, b1, b0] : [a0, b0, b1, a0, b1, a1];
    for (const corner of corners) {
      out.positions.push(corner.x, corner.y, corner.z);
      out.normals.push(normal.x, normal.y, normal.z);
      out.tints.push(r, g, blue);
    }
  };
  for (let i = 0; i + 1 < piece.points.length; i++) {
    if (bare(i)) continue;
    const fa = piece.frames[i] as RoadFrame;
    const fb = piece.frames[i + 1] as RoadFrame;
    const from = fa.distance;
    const span = fb.distance - from;
    if (span <= 0) continue;
    const pa = piece.points[i] as Point;
    const pb = piece.points[i + 1] as Point;
    const a0 = place(pa, fa, marking.across - half, rise);
    const a1 = place(pa, fa, marking.across + half, rise);
    const b0 = place(pb, fb, marking.across - half, rise);
    const b1 = place(pb, fb, marking.across + half, rise);
    // `w0` and `w1` are the share of the full width the paint has at each end.
    const stretch = (t0: number, t1: number, w0 = 1, w1 = 1): void => {
      const narrow = (edge: Vector3, other: Vector3, w: number): Vector3 => between(other, edge, 0.5 + w / 2);
      const l0 = between(a0, b0, t0);
      const r0 = between(a1, b1, t0);
      const l1 = between(a0, b0, t1);
      const r1 = between(a1, b1, t1);
      paint(narrow(l0, r0, w0), narrow(r0, l0, w0), narrow(l1, r1, w1), narrow(r1, l1, w1));
    };
    if (marking.gap <= 0) {
      stretch(0, 1);
      continue;
    }
    const shift = marking.offset ?? 0;
    const first = Math.floor((from - shift) / period);
    const last = Math.floor((fb.distance - shift) / period);
    for (let k = first; k <= last; k++) {
      const dash = k * period + shift;
      const start = Math.max(dash, from);
      const end = Math.min(dash + marking.dash, fb.distance);
      if (end <= start) continue;
      // A tapered dash is as wide as the line at its start and a point at its end.
      const width = (at: number): number => (marking.taper === true ? 1 - (at - dash) / marking.dash : 1);
      stretch((start - from) / span, (end - from) / span, width(start), width(end));
    }
  }
}
