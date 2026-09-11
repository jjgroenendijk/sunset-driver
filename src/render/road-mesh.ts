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
 * where a run turns too sharply to sweep through, and the loft is cut there.
 *
 * Where roads meet they are not lofted through one another. A junction (spec
 * section 6.2, `junctions.ts`) cuts every road back to where its kerbs leave
 * its neighbours', and the ground between the cuts is drawn here as one
 * carriageway polygon with a piece of pavement in each corner. The cut points
 * are the junction's, so the polygon meets the lofts exactly, in whichever
 * chunk each of them was built.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import { BufferAttribute, BufferGeometry, Color, ShapeUtils, Vector2, Vector3 } from 'three';
import { LoftGeometry } from 'three/examples/jsm/geometries/LoftGeometry.js';
import type { ChunkRoad, WorldChunk } from '../world/chunks.ts';
import type { Junction, JunctionMouth, RoadGap } from '../world/junctions.ts';
import type { RoadFrame, RoadRibbons } from '../world/ribbon.ts';
import { footprintHalfWidth, TIERS } from '../world/tiers.ts';
import type { Point, RoadTier } from '../world/types.ts';

/** The tiers, in the order a chunk's batches are built. */
export const TIER_ORDER: readonly RoadTier[] = ['highway', 'arterial', 'street', 'alley', 'dirt'];

/** Metres the carriageway stands above the bed the carve cut for it. */
const SURFACE_RAISE = 0.06;

/** Metres a kerb stands above the carriageway, where the tier has one. */
const KERB_RISE = 0.14;

/**
 * Metres the outer edge of a road drops below its bed, burying the edge in the
 * ground beside it. The carve holds one bed per grid cell, so where two roads
 * crowd one cell a road can stand a little off the ground it drives on; the
 * skirt is deeper than that gap, so the ground never shows through the edge.
 */
const SKIRT = 0.8;

/** Metres of structure under a bridge deck, and the parapet that rims it. */
const DECK_DEPTH = 1.1;
const PARAPET_WIDTH = 0.4;
const PARAPET_RISE = 0.9;

/** Metres of headroom in a tunnel bore, and the portal that frames its mouth. */
const BORE_RISE = 5.5;
const PORTAL_MARGIN = 1.6;
const PORTAL_DEPTH = 1.2;

/** Metres the paint stands above the carriageway, so a marking is never buried in it. */
const MARK_RAISE = 0.012;

/** Metres of paint and of gap in a dashed line. */
const DASH = 3;
const DASH_GAP = 4.5;

/** Metres in from the kerb that an edge line is painted. */
const EDGE_INSET = 0.4;

/** Metres between the two lines of a solid double centre line. */
const DOUBLE_GAP = 0.5;

/** What a vertex belongs to: the cross section of a road, or a structure carrying one. */
export const SURFACE_ROAD = 0;
export const SURFACE_STRUCTURE = 1;

/** One point of a cross section: how far across the road it stands, and how high. */
export interface SectionPoint {
  /** Metres from the centreline, negative to the left of travel. */
  across: number;
  /** Metres above the road bed. */
  rise: number;
}

/** A colour as the renderer wants it: three floats in the working colour space. */
type Rgb = readonly [number, number, number];

function rgbOf(hex: number): Rgb {
  const colour = new Color(hex);
  return [colour.r, colour.g, colour.b];
}

/**
 * The two colours road paint comes in: yellow keeps the two directions apart,
 * white divides the lanes running the same way and marks the edges.
 */
const YELLOW = rgbOf(0xd8b43a);
const WHITE = rgbOf(0xd7d4cb);

/** One line painted along a road. */
export interface Marking {
  /** Metres from the centreline. */
  across: number;
  /** Metres of paint, then metres of gap. A gap of zero is a solid line. */
  dash: number;
  gap: number;
  colour: Rgb;
}

/** The geometry of one run of road. */
export interface RunGeometry {
  run: ChunkRoad;
  /**
   * The lofted surface, one section of `roadSection(run.tier)` per point. A run
   * that turns somewhere too sharply to mitre is cut there, so it comes back in
   * more than one piece.
   */
  surfaces: BufferGeometry[];
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
  for (const run of tier.runs) out.push(...run.surfaces, ...run.structures);
  out.push(...tier.junctions);
  return out;
}

/** Square metres below which a junction surface is a sliver of rounding and is not drawn. */
const MIN_SURFACE_AREA = 1e-3;

/** Metres two places may stand apart and still be one vertex of a polygon. */
const SAME_PLACE = 1e-6;

/**
 * The cross section of a tier, from its left edge to its right (spec section
 * 6.2). The carriageway is flat between the kerbs; a tier with a pavement takes
 * a kerb face up to it, and one without takes its verge down to the ground.
 * Both ends drop into the skirt that buries the edge.
 */
export function roadSection(tier: RoadTier): SectionPoint[] {
  const spec = TIERS[tier];
  const half = spec.width / 2;
  const outer = footprintHalfWidth(tier);
  const top = SURFACE_RAISE + KERB_RISE;
  const left: SectionPoint[] = [{ across: -outer, rise: -SKIRT }];
  if (spec.pavement > 0) {
    left.push({ across: -outer, rise: top }, { across: -half, rise: top }, { across: -half, rise: SURFACE_RAISE });
  } else if (spec.verge > 0) {
    left.push({ across: -outer, rise: 0 }, { across: -half, rise: SURFACE_RAISE });
  } else {
    left.push({ across: -half, rise: SURFACE_RAISE });
  }
  const right = left.map((point) => ({ across: -point.across, rise: point.rise })).reverse();
  return [...left, ...right];
}

/**
 * Metres above the road bed that the outer edge of a tier's surface stands: the
 * top of the kerb where the tier has a pavement, the verge where it has one, and
 * the carriageway itself where it has neither. Street furniture set beside a
 * road stands on this, so nothing is placed reading these numbers twice.
 */
export function vergeRise(tier: RoadTier): number {
  // The first point of a section is the skirt buried in the ground beside the
  // road; the second is the outer edge of the surface itself.
  return (roadSection(tier)[1] as SectionPoint).rise;
}

/**
 * The lines painted on a tier (spec section 6.2). An alley and a dirt road are
 * unmarked. Everything else takes a centre line, one dashed divider between each
 * pair of lanes, and — where the tier runs fast enough to need them — a solid
 * edge line inside each kerb.
 */
export function markingsOf(tier: RoadTier): Marking[] {
  const spec = TIERS[tier];
  if (tier === 'alley' || tier === 'dirt') return [];
  const half = spec.width / 2;
  const lane = half / spec.lanes;
  const out: Marking[] = [];
  if (spec.lanes === 1) {
    out.push({ across: 0, dash: DASH, gap: DASH_GAP, colour: YELLOW });
  } else {
    // Two directions kept apart by a solid double line, as a road this busy is.
    out.push(
      { across: -DOUBLE_GAP / 2, dash: 0, gap: 0, colour: YELLOW },
      { across: DOUBLE_GAP / 2, dash: 0, gap: 0, colour: YELLOW },
    );
  }
  for (let i = 1; i < spec.lanes; i++) {
    out.push(
      { across: -i * lane, dash: DASH, gap: DASH_GAP, colour: WHITE },
      { across: i * lane, dash: DASH, gap: DASH_GAP, colour: WHITE },
    );
  }
  if (spec.lanes > 1) {
    out.push(
      { across: -(half - EDGE_INSET), dash: 0, gap: 0, colour: WHITE },
      { across: half - EDGE_INSET, dash: 0, gap: 0, colour: WHITE },
    );
  }
  return out;
}

/** True where a tier carries painted markings, and so a batch to draw them in. */
export function isMarked(tier: RoadTier): boolean {
  return markingsOf(tier).length > 0;
}

/**
 * Draw calls one chunk spends on its roads: a batch of geometry and a batch of
 * markings for each tier that runs through it. A tier with no run in the chunk
 * costs nothing. `chunk-cost.ts` adds this to what the rest of a chunk costs.
 */
export function roadDrawCalls(chunk: WorldChunk): number {
  let calls = 0;
  for (const tier of TIER_ORDER) {
    if (!chunk.roads.some((run) => run.tier === tier) && !chunk.junctions.some((junction) => pavesAs(junction, tier))) {
      continue;
    }
    calls += isMarked(tier) ? 2 : 1;
  }
  return calls;
}

/** True where a junction puts any surface into the batch of a tier. */
function pavesAs(junction: Junction, tier: RoadTier): boolean {
  return junction.tier === tier || junction.corners.some((corner) => corner.tier === tier);
}

/** The ground under a place, for the corners of a junction to stand on. */
export type HeightAt = (x: number, y: number) => number;

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
      built.push({
        run,
        surfaces: pieces.map((piece) => surfaceOf(piece, section)),
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

/** One surface of a junction, and the tier whose batch it goes into. */
interface JunctionSurface {
  tier: RoadTier;
  geometry: BufferGeometry;
}

/**
 * The surfaces of one junction: its carriageway, paved as the widest road that
 * meets there, and a piece of pavement in each corner, paved as the wider of the
 * two roads beside it. The vertices along each mouth are the section the road's
 * own loft ends on, so the two meet without a seam; the corners stand on the
 * carved ground, which under a junction is the bench of the nearest road.
 */
function junctionSurfaces(junction: Junction, ribbons: RoadRibbons, heightAt: HeightAt): JunctionSurface[] {
  const out: JunctionSurface[] = [];
  const mouths = junction.mouths.map((mouth) => mouthSection(mouth, ribbons));
  if (mouths.length < 2) return out;

  const carriageway: Vector3[] = [];
  for (let i = 0; i < mouths.length; i++) {
    const mouth = mouths[i] as MouthSection;
    const corner = junction.corners[i] as Junction['corners'][number];
    carriageway.push(mouth.rightKerb, mouth.leftKerb);
    for (const p of corner.kerb) carriageway.push(new Vector3(p.x, heightAt(p.x, p.y) + SURFACE_RAISE, p.y));
  }
  // The carriageway is fanned from the node, which stands on the carved ground
  // as the corners do: the beds of the roads meet at the node, so a surface
  // stretched straight from one mouth to another would cut under a junction on
  // a ridge, and the ground would show through it.
  const centre = new Vector3(junction.x, heightAt(junction.x, junction.y) + SURFACE_RAISE, junction.y);
  const paved = flatSurface(carriageway, 0, centre);
  if (paved !== undefined) out.push({ tier: junction.tier, geometry: paved });

  for (let i = 0; i < mouths.length; i++) {
    const a = mouths[i] as MouthSection;
    const b = mouths[(i + 1) % mouths.length] as MouthSection;
    const corner = junction.corners[i] as Junction['corners'][number];
    const rise = vergeRise(corner.tier);
    const ring: Vector3[] = [a.leftKerb];
    for (const p of corner.kerb) ring.push(new Vector3(p.x, heightAt(p.x, p.y) + SURFACE_RAISE, p.y));
    ring.push(b.rightKerb, b.rightOuter);
    for (let k = corner.outer.length - 1; k >= 0; k--) {
      const p = corner.outer[k] as Point;
      ring.push(new Vector3(p.x, heightAt(p.x, p.y) + rise, p.y));
    }
    ring.push(a.leftOuter);
    const pavement = flatSurface(ring, cornerAcross(corner.tier));
    if (pavement !== undefined) out.push({ tier: corner.tier, geometry: pavement });
  }
  return out;
}

/** The four corners of the section a road's loft ends on at its mouth. */
interface MouthSection {
  leftKerb: Vector3;
  rightKerb: Vector3;
  leftOuter: Vector3;
  rightOuter: Vector3;
}

/**
 * Where a mouth's loft ends. Left is anticlockwise round the node, which is the
 * curve's own left where the road leaves along its curve and its right where
 * it leaves against it.
 */
function mouthSection(mouth: JunctionMouth, ribbons: RoadRibbons): MouthSection {
  const frame = ribbons.frameAt(mouth.curve, mouth.segment, mouth.at.x, mouth.at.y);
  const spec = TIERS[mouth.tier];
  const kerb = spec.width / 2;
  const outer = footprintHalfWidth(mouth.tier);
  const top = vergeRise(mouth.tier);
  const side = mouth.direction;
  return {
    leftKerb: place(mouth.at, frame, side * kerb, SURFACE_RAISE),
    rightKerb: place(mouth.at, frame, -side * kerb, SURFACE_RAISE),
    leftOuter: place(mouth.at, frame, side * outer, top),
    rightOuter: place(mouth.at, frame, -side * outer, top),
  };
}

/**
 * How far across a road the material reads a junction corner as: the pavement
 * band of the tier where it has one, its verge where it has that, and its
 * carriageway where it has neither.
 */
function cornerAcross(tier: RoadTier): number {
  const spec = TIERS[tier];
  if (spec.pavement > 0) return footprintHalfWidth(tier);
  return spec.width / 2 + spec.verge / 2;
}

/**
 * A flat polygon in the scene, wound to face up. Nothing where the ring has no
 * area to draw, which is a corner between two roads with no pavement. Given a
 * `centre` the ring is fanned from it rather than triangulated on its own,
 * which holds for a ring every point of which can be seen from the centre.
 */
function flatSurface(ring: readonly Vector3[], across: number, centre?: Vector3): BufferGeometry | undefined {
  const points: Vector3[] = [];
  for (const p of ring) {
    const last = points[points.length - 1];
    if (last !== undefined && last.distanceTo(p) < SAME_PLACE) continue;
    points.push(p);
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (first !== undefined && last !== undefined && points.length > 1 && first.distanceTo(last) < SAME_PLACE) points.pop();
  if (points.length < 3) return undefined;
  const flat = points.map((p) => new Vector2(p.x, p.z));
  if (Math.abs(ShapeUtils.area(flat)) < MIN_SURFACE_AREA) return undefined;
  let faces: number[][];
  if (centre === undefined) {
    faces = ShapeUtils.triangulateShape(flat, []);
  } else {
    const hub = points.length;
    points.push(centre);
    faces = points.slice(0, hub).map((_, i) => [hub, i, (i + 1) % hub]);
  }
  if (faces.length === 0) return undefined;

  const count = points.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let v = 0; v < count; v++) {
    const p = points[v] as Vector3;
    positions[v * 3] = p.x;
    positions[v * 3 + 1] = p.y;
    positions[v * 3 + 2] = p.z;
    normals[v * 3 + 1] = 1;
    uvs[v * 2] = p.x;
    uvs[v * 2 + 1] = p.z;
  }
  // The map's y runs into the scene's z, which turns the winding over: a face
  // anticlockwise on the map faces down in the scene, so every face is wound
  // by the way its own three corners turn.
  const index = new Uint32Array(faces.length * 3);
  let at = 0;
  for (const face of faces) {
    const [a, b, c] = face as [number, number, number];
    const pa = points[a] as Vector3;
    const pb = points[b] as Vector3;
    const pc = points[c] as Vector3;
    const up = (pb.x - pa.x) * (pc.z - pa.z) - (pb.z - pa.z) * (pc.x - pa.x);
    if (up < 0) {
      index[at++] = a;
      index[at++] = b;
      index[at++] = c;
    } else {
      index[at++] = a;
      index[at++] = c;
      index[at++] = b;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(index, 1));
  return tag(geometry, new Float32Array(count).fill(across), SURFACE_ROAD);
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

/** Where one point of a cross section stands in the scene. */
function place(point: Point, frame: RoadFrame, across: number, rise: number): Vector3 {
  const off = across * frame.mitre;
  return new Vector3(point.x + frame.acrossX * off, frame.height + rise, point.y + frame.acrossY * off);
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
      out.push(beam(points, span, -outer, -outer + PARAPET_WIDTH, deckTop, deckTop + PARAPET_RISE));
      out.push(beam(points, span, outer - PARAPET_WIDTH, outer, deckTop, deckTop + PARAPET_RISE));
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

function between(a: Vector3, b: Vector3, t: number): Vector3 {
  return new Vector3().lerpVectors(a, b, t);
}

/**
 * Give a geometry the two attributes every road part carries: how far across the
 * road each vertex stands, which the material reads the carriageway, the kerb
 * and the pavement off, and what kind of surface it is.
 */
function tag(geometry: BufferGeometry, across: Float32Array, kind: number): BufferGeometry {
  geometry.setAttribute('across', new BufferAttribute(across, 1));
  geometry.setAttribute('kind', new BufferAttribute(new Float32Array(across.length).fill(kind), 1));
  return geometry;
}

/** Join several geometries into one, so a portal costs one entry of a batch. */
function merge(parts: readonly BufferGeometry[]): BufferGeometry {
  const names = ['position', 'normal', 'uv', 'across', 'kind'];
  const sizes = [3, 3, 2, 1, 1];
  const vertices = parts.reduce((sum, part) => sum + part.getAttribute('position').count, 0);
  const indices = parts.reduce((sum, part) => sum + (part.getIndex()?.count ?? 0), 0);
  const geometry = new BufferGeometry();
  const index = new Uint32Array(indices);
  let base = 0;
  let at = 0;
  for (let a = 0; a < names.length; a++) {
    const name = names[a] as string;
    const size = sizes[a] as number;
    const array = new Float32Array(vertices * size);
    let offset = 0;
    for (const part of parts) {
      array.set((part.getAttribute(name) as BufferAttribute).array as Float32Array, offset);
      offset += part.getAttribute(name).count * size;
    }
    geometry.setAttribute(name, new BufferAttribute(array, size));
  }
  for (const part of parts) {
    const source = part.getIndex();
    if (source !== null) for (let i = 0; i < source.count; i++) index[at++] = source.getX(i) + base;
    base += part.getAttribute('position').count;
    part.dispose();
  }
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}
