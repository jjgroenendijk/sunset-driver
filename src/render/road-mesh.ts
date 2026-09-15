/**
 * The geometry of the roads in one chunk (spec sections 6.1, 6.2, 10.2).
 *
 * A road is a curve, so its surface is lofted along it: a cross section is
 * placed at every point of the run and `LoftGeometry` skins the sections
 * together. The section carries the whole width the tier claims — carriageway,
 * verge, kerb and pavement — so one loft draws all of it, and the material tells
 * the parts apart by how far across the road each vertex stands.
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
import type { Junction, JunctionMouth, RoadGap } from '../world/junctions.ts';
import type { RoadFrame, RoadRibbons } from '../world/ribbon.ts';
import { PARAPET_HEIGHT } from '../world/decks.ts';
import { footprintHalfWidth, TIERS } from '../world/tiers.ts';
import type { Point, RoadTier } from '../world/types.ts';
import { junctionSurfaces, pavesAs, type HeightAt } from './junction-mesh.ts';
import {
  between,
  isMarked,
  markingsOf,
  merge,
  MARK_RAISE,
  place,
  roadSection,
  SKIRT,
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
export {
  isMarked,
  markingsOf,
  roadSection,
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
   * The lofted surface, one section of `roadSection(run.tier)` per point. A run
   * that turns somewhere too sharply to mitre is cut there, so it comes back in
   * more than one piece.
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
   * whose widest road is this tier, and every corner whose wider road is.
   */
  junctions: BufferGeometry[];
  /** Marking segment ends, six numbers each. Empty where the tier is unmarked. */
  markings: Float32Array;
  /** The colour of each of those ends, six numbers each. */
  markingTints: Float32Array;
}

/** Everything of one tier that goes into a batch, surfaces and structures alike. */
export function partsOf(tier: TierGeometry): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (const run of tier.runs) out.push(...run.surfaces, ...run.joints, ...run.structures);
  out.push(...tier.junctions);
  return out;
}

/**
 * Draw calls one chunk spends on its roads: a batch of geometry in each of
 * `cells` cells and a batch of markings for each tier that runs through it. A
 * tier with no run in the chunk costs nothing. `chunk-cost.ts` adds this to what the rest of a chunk costs.
 */
export function roadDrawCalls(chunk: WorldChunk, cells = 1): number {
  let calls = 0;
  for (const tier of TIER_ORDER) {
    if (!chunk.roads.some((run) => run.tier === tier) && !chunk.junctions.some((junction) => pavesAs(junction, tier))) {
      continue;
    }
    calls += cells + (isMarked(tier) ? 1 : 0);
  }
  return calls;
}

/**
 * Metres of structure under a bridge deck, and how thick the parapet that rims
 * it is. The parapet stands {@link PARAPET_HEIGHT} high, which `decks.ts` owns:
 * the physics puts a wall of that height on the deck, so the wall the car is
 * held by and the wall the player sees are one.
 */
const DECK_DEPTH = 1.1;

const PARAPET_WIDTH = 0.4;

/** Metres of headroom in a tunnel bore, and the portal that frames its mouth. */
const BORE_RISE = 5.5;

const PORTAL_MARGIN = 1.6;

const PORTAL_DEPTH = 1.2;

/**
 * Build the road geometry of one chunk, one entry per tier that runs through it.
 * The entries come back in {@link TIER_ORDER}, so two chunks of a world batch
 * their tiers the same way.
 */
export function buildChunkRoads(chunk: WorldChunk, ribbons: RoadRibbons, heightAt: HeightAt): TierGeometry[] {
  const out: TierGeometry[] = [];
  const junctions = new Map<RoadTier, BufferGeometry[]>();
  for (const junction of chunk.junctions) {
    for (const surface of junctionSurfaces(junction, ribbons, heightAt)) {
      const list = junctions.get(surface.tier);
      if (list === undefined) junctions.set(surface.tier, [surface.geometry]);
      else list.push(surface.geometry);
    }
  }
  for (const tier of TIER_ORDER) {
    const runs = chunk.roads.filter((run) => run.tier === tier).flatMap((run) => trimRun(run, ribbons));
    const paved = junctions.get(tier) ?? [];
    if (runs.length === 0 && paved.length === 0) continue;
    const section = roadSection(tier);
    const markings = markingsOf(tier);
    const built: RunGeometry[] = [];
    const paint: number[] = [];
    const tints: number[] = [];
    for (const run of runs) {
      const pieces = piecesOf(run, ribbons);
      // The joints are one part rather than one each: a bevel is a handful of
      // triangles, and a batch pays for every part it is filled from.
      const joints = jointsOf(pieces, section);
      built.push({
        run,
        surfaces: pieces.map((piece) => surfaceOf(piece, section)),
        joints: joints.length > 0 ? [merge(joints)] : [],
        structures: structuresOf(run, pieces, ribbons, tier, section),
      });
      for (const piece of pieces) {
        for (const marking of markings) paintMarking(piece, marking, paint, tints);
      }
    }
    out.push({ tier, runs: built, junctions: paved, markings: new Float32Array(paint), markingTints: new Float32Array(tints) });
  }
  return out;
}

/**
 * Cut a run short of the junctions it meets: the stretches of its curve the
 * gaps cover are left out, and what remains comes back as runs of its own.
 * The ends are the gaps' own points, so a run cut here ends exactly where the
 * junction polygon starts, whichever chunk draws the junction.
 */
export function trimRun(run: ChunkRoad, ribbons: RoadRibbons): ChunkRoad[] {
  if (run.gaps.length === 0) return [run];
  const count = run.points.length;
  const distances: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = run.points[i] as Point;
    distances.push(ribbons.frameAt(run.curve, run.from + Math.max(0, i - 1), p.x, p.y).distance);
  }
  const out: ChunkRoad[] = [];
  let open: { from: number; points: Point[] } | undefined;
  const close = (): void => {
    if (open !== undefined && open.points.length > 1) out.push(subRun(run, open.from, open.points));
    open = undefined;
  };
  for (let i = 0; i + 1 < count; i++) {
    const d0 = distances[i] as number;
    const d1 = distances[i + 1] as number;
    // The stretches of this segment no gap covers, in order.
    let at = d0;
    let atPoint = run.points[i] as Point;
    const pieces: { a: number; aAt: Point; b: number; bAt: Point }[] = [];
    for (const gap of run.gaps) {
      if (gap.to.distance <= at || gap.from.distance >= d1) {
        if (gap.from.distance >= d1) break;
        continue;
      }
      if (gap.from.distance > at) pieces.push({ a: at, aAt: atPoint, b: gap.from.distance, bAt: gap.from.at });
      at = gap.to.distance;
      atPoint = gap.to.at;
      if (at >= d1) break;
    }
    if (at < d1) pieces.push({ a: at, aAt: atPoint, b: d1, bAt: run.points[i + 1] as Point });
    for (const piece of pieces) {
      if (piece.a !== d0 || open === undefined) {
        close();
        open = { from: run.from + i, points: [piece.aAt] };
      }
      open.points.push(piece.bAt);
      if (piece.b !== d1) close();
    }
    if (pieces.length === 0) close();
  }
  close();
  return out;
}

/** A stretch of a run as a run of its own, starting on curve segment `from`. */
function subRun(run: ChunkRoad, from: number, points: Point[]): ChunkRoad {
  const first = from - run.from;
  const segments = points.length - 1;
  const within = (i: number): boolean => i >= first && i < first + segments;
  return {
    curve: run.curve,
    tier: run.tier,
    from,
    points,
    bridges: run.bridges.filter(within).map((i) => i - first),
    tunnels: run.tunnels.filter(within).map((i) => i - first),
    gaps: [],
  };
}

/** A stretch of a run one loft can cover: a frame for each of its points. */
interface Piece {
  /** Index in the run of the segment this piece starts at. */
  from: number;
  points: Point[];
  frames: RoadFrame[];
}

/**
 * Cut a run into the pieces one loft each can cover.
 *
 * Point `i` of a run stands at the end of segment `from + i - 1` of the curve
 * and at the start of segment `from + i`. Where the curve mitres the point, the
 * two answers are the same frame and the loft runs straight through it. Where
 * the turn is too sharp to mitre they differ, and the surface is cut there: one
 * piece ends on the frame it arrived with, the next starts on the frame it
 * leaves with. Both chunks of a run cut at a boundary make the same cuts,
 * because the curve decides them and not the run.
 */
function piecesOf(run: ChunkRoad, ribbons: RoadRibbons): Piece[] {
  const last = run.points.length - 1;
  const out: Piece[] = [];
  let from = 0;
  let points: Point[] = [];
  let frames: RoadFrame[] = [];
  for (let i = 0; i <= last; i++) {
    const p = run.points[i] as Point;
    const before = i > 0 ? ribbons.frameAt(run.curve, run.from + i - 1, p.x, p.y) : undefined;
    const after = i < last ? ribbons.frameAt(run.curve, run.from + i, p.x, p.y) : undefined;
    points.push(p);
    frames.push(before ?? (after as RoadFrame));
    if (before === undefined || after === undefined) continue;
    if (before.acrossX === after.acrossX && before.acrossY === after.acrossY) continue;
    out.push({ from, points, frames });
    from = i;
    points = [p];
    frames = [after];
  }
  out.push({ from, points, frames });
  // A piece of one point is the far side of a turn at the very end of a run,
  // and there is nothing left of the run to loft it along.
  return out.filter((piece) => piece.points.length > 1);
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
 * the whole outer half — carriageway, kerb face and pavement — so the joint
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
 * run cut short by a junction takes no joint at the cut.
 */
function jointsOf(pieces: readonly Piece[], section: readonly SectionPoint[]): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (let i = 0; i + 1 < pieces.length; i++) {
    const piece = pieces[i] as Piece;
    const next = pieces[i + 1] as Piece;
    if (next.from !== piece.from + piece.points.length - 1) continue;
    const before = piece.frames[piece.frames.length - 1] as RoadFrame;
    const after = next.frames[0] as RoadFrame;
    const joint = jointOf(next.points[0] as Point, before, after, section);
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
 * A rectangular beam swept along a stretch of a run: the deck under a bridge,
 * or the parapet along its edge. Closed and capped, so it is solid from every
 * side the top-down camera can reach.
 */
function beam(
  points: readonly Point[],
  frames: readonly RoadFrame[],
  low: number,
  high: number,
  bottom: number,
  top: number,
): BufferGeometry {
  // Wound so the loft faces outward: seen from the far end, the ring runs
  // clockwise from the top of the right side.
  const ring: SectionPoint[] = [
    { across: high, rise: top },
    { across: high, rise: bottom },
    { across: low, rise: bottom },
    { across: low, rise: top },
  ];
  const sections = points.map((point, i) =>
    ring.map((s) => place(point, frames[i] as RoadFrame, s.across, s.rise)),
  );
  const geometry = new LoftGeometry(sections, { closed: true, capStart: true, capEnd: true });
  return tag(geometry, new Float32Array(geometry.getAttribute('position').count), SURFACE_STRUCTURE);
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
 * Lay one painted line along a piece of a run, six numbers per segment of paint.
 * The dash pattern is measured from the start of the whole curve rather than of
 * the piece, so the dashes of a road that crosses a chunk boundary carry
 * straight on.
 */
function paintMarking(piece: Piece, marking: Marking, out: number[], tints: number[]): void {
  const period = marking.dash + marking.gap;
  const paint = (a: Vector3, b: Vector3): void => {
    out.push(a.x, a.y, a.z, b.x, b.y, b.z);
    const [r, g, blue] = marking.colour;
    tints.push(r, g, blue, r, g, blue);
  };
  for (let i = 0; i + 1 < piece.points.length; i++) {
    const fa = piece.frames[i] as RoadFrame;
    const fb = piece.frames[i + 1] as RoadFrame;
    const from = fa.distance;
    const span = fb.distance - from;
    if (span <= 0) continue;
    const a = place(piece.points[i] as Point, fa, marking.across, SURFACE_RAISE + MARK_RAISE);
    const b = place(piece.points[i + 1] as Point, fb, marking.across, SURFACE_RAISE + MARK_RAISE);
    if (marking.gap <= 0) {
      paint(a, b);
      continue;
    }
    const first = Math.floor(from / period);
    const last = Math.floor(fb.distance / period);
    for (let k = first; k <= last; k++) {
      const start = Math.max(k * period, from);
      const end = Math.min(k * period + marking.dash, fb.distance);
      if (end <= start) continue;
      paint(between(a, b, (start - from) / span), between(a, b, (end - from) / span));
    }
  }
}
