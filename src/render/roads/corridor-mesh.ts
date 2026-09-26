/**
 * The geometry of the corridors in one chunk (spec sections 6.3, 13.2): the
 * piers that carry the decks, and the tram's reserved lane, its rails and its
 * level crossings.
 *
 * None of it is a batch of its own. A pier is drawn in the batch of the tier it
 * carries and the track in the batch of the road it runs down, so the corridors
 * add parts to a chunk and no draw call. The material tells a pier, a lane, a
 * rail and a crossing apart by the `kind` each vertex carries.
 *
 * A pier stands from the carved ground under its foot up into the underside of
 * its deck, which is where `road-mesh.ts` sweeps it: the deck frame at the foot,
 * less the skirt and the depth of the deck. The track is swept in the frames of
 * the road under it (`road-pieces.ts`), so it lies on the road on the ground,
 * through a junction and over a deck alike, and a run cut at a chunk boundary
 * meets its other half on the same section.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import { BufferGeometry, Vector3 } from 'three';
import { hypot } from '../../core/libm.ts';
import { catenaryOf } from '../transit/catenary-mesh.ts';
import { LoftGeometry } from 'three/examples/jsm/geometries/LoftGeometry.js';
import type { ChunkPier, WorldChunk } from '../../world/chunks.ts';
import { PIER_HALF } from '../../world/decks/piers.ts';
import type { RoadFrame, RoadRibbons } from '../../world/carve/ribbon.ts';
import { piecesOf, type Piece } from '../../world/roads/road-pieces.ts';
import { TRAM_LANE } from '../../world/roads/tiers.ts';
import { MIN_GREEN, PAVED_REACH, type TramCrossing } from '../../world/transit/tram-track.ts';
import type { Point, RoadTier } from '../../world/types.ts';
import type { SurfaceAt } from './pavement-mesh.ts';
import {
  beam,
  DECK_DEPTH,
  flatSurface,
  MARK_RAISE,
  merge,
  place,
  SKIRT,
  SURFACE_CROSSING,
  SURFACE_CROSSING_MARK,
  SURFACE_GROOVE,
  SURFACE_RAIL,
  SURFACE_RAISE,
  SURFACE_SETTS,
  SURFACE_STRUCTURE,
  SURFACE_TRACK_GRASS,
  tag,
  type SectionPoint,
} from './road-section.ts';

/** Metres a pier is sunk into the ground under it, so no gap shows where the ground slopes. */
const PIER_FOOTING = 0.6;
/** Metres a pier reaches up into its deck, so no gap shows under the soffit. */
const PIER_OVERLAP = 0.1;
/** The shortest pier worth drawing, in metres. A deck lower than this is on its ramp. */
const MIN_PIER = 0.5;
/**
 * Metres the lane stands above the carriageway. It is over the paint, so the
 * centre line of the road it runs down does not show between the rails.
 *
 * The lane, the panel and the rails go into the tier batch with the carriageway
 * they are laid on (`docs/corridors.md`), so they cannot take a depth offset of
 * their own the way the paint does: a batch carries one material. The lift is
 * what keeps them in front of it, and a lift of g metres wins to about
 * √(g × 1.7e6) metres from the chase camera. Six centimetres reaches about
 * 320 m, which is the far side of the near ring, and reads as the kerbed step a
 * reserved lane has.
 */
const LANE_RAISE = 5 * MARK_RAISE;
/** Metres a crossing panel stands above the lane, and how far a rail head stands over the lane. */
const CROSSING_RAISE = 0.03;
const RAIL_RISE = 0.05;
/**
 * A street rail is a grooved rail: a head the wheel runs on, and a slot beside
 * it the flange drops into. Both are drawn, because the dark slot is what tells
 * a rail from a painted line at the distance the camera looks from. A real head
 * is 7 cm across; this one is wider so it reads.
 */
const RAIL_HALF = 0.075;
const GROOVE_NEAR = 0.012;
const GROOVE_FAR = 0.055;
/** Metres a crossing panel reaches along the track each side of the node. */
const CROSSING_REACH = 4;
/** Metres apart two paved places have to stand to count as two rather than one. */
const SAME_PLACE = 0.5;
/** Metres of paint and of gap in the line that outlines a crossing panel. */
const MARK_DASH = 0.9;
const MARK_GAP = 0.7;
/** Metres a crossing's outline is wide, and how far it stands over the panel. */
const MARK_WIDTH = 0.14;
const MARK_RISE = 0.004;

/** One part of a chunk's corridors and the tier batch it goes into. */
export interface CorridorPart {
  tier: RoadTier;
  geometry: BufferGeometry;
}

/** Every pier, lane, rail and crossing of a chunk, each with the tier it is batched with. */
export function buildChunkCorridors(chunk: WorldChunk, ribbons: RoadRibbons, surfaceAt: SurfaceAt): CorridorPart[] {
  const out: CorridorPart[] = [];
  for (const pier of chunk.piers) {
    const geometry = pierGeometry(pier, ribbons);
    if (geometry !== undefined) out.push({ tier: pier.tier, geometry });
  }
  for (const run of chunk.tram) {
    const parts = piecesOf(run, ribbons).flatMap((piece) => [...trackOf(piece, chunk.tramPaved), ...catenaryOf(piece)]);
    if (parts.length > 0) out.push({ tier: run.tier, geometry: merge(parts) });
  }
  for (const crossing of chunk.tramCrossings) {
    const parts = crossingParts(crossing, surfaceAt);
    if (parts.length > 0) out.push({ tier: crossing.tier, geometry: merge(parts) });
  }
  return out;
}

/**
 * One pier: a column from below the ground up into the deck, square to the
 * road it carries. Nothing where the deck stands too low over the ground for a
 * column, which is the foot of a ramp.
 */
export function pierGeometry(pier: ChunkPier, ribbons: RoadRibbons): BufferGeometry | undefined {
  const frame = ribbons.frameAt(pier.curve, pier.segment, pier.x, pier.y);
  const soffit = frame.height + frame.bank * pier.across - SKIRT - DECK_DEPTH;
  if (soffit - pier.ground < MIN_PIER) return undefined;
  const half = PIER_HALF[pier.tier];
  // Along the road is across it turned a quarter.
  const alongX = frame.acrossY;
  const alongY = -frame.acrossX;
  const level: RoadFrame = { ...frame, height: 0, bank: 0, mitre: 1 };
  const ends: Point[] = [
    { x: pier.x - alongX * half, y: pier.y - alongY * half },
    { x: pier.x + alongX * half, y: pier.y + alongY * half },
  ];
  return beam(ends, [level, level], -half, half, pier.ground - PIER_FOOTING, soffit + PIER_OVERLAP, SURFACE_STRUCTURE);
}

/**
 * The track along one piece of a run: the ground the rails are laid in, and
 * the four grooved rails of the two tracks on it.
 *
 * The ground is stone setts within {@link PAVED_REACH} of a junction, a level
 * crossing or a stop, and grass on the open run between two of them. The switch
 * is decided point by point, and the piece is cut into one loft per stretch, so
 * a run that leaves a junction turns green part way along rather than at
 * whichever end its loft happens to have.
 */
function trackOf(piece: Piece, paved: readonly Point[]): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  for (const stretch of stretchesOf(piece, paved)) parts.push(lane(stretch.points, stretch.frames, stretch.paved));

  // The rails stand on the lane rather than over it, so none of their length
  // floats. They reach RAIL_RISE up, which clears a crossing panel by the 2 cm
  // of rail head a crossing shows.
  const base = SURFACE_RAISE + LANE_RAISE;
  for (const track of [-1, 1]) {
    for (const rail of [-1, 1]) {
      const centre = (track * TRAM_LANE.trackSpacing) / 2 + (rail * TRAM_LANE.gauge) / 2;
      parts.push(beam(piece.points, piece.frames, centre - RAIL_HALF, centre + RAIL_HALF, base, base + RAIL_RISE, SURFACE_RAIL));
      // The groove is on the gauge side of the head, which is the side the
      // other rail of the same track stands on.
      const groove = centre - rail * GROOVE_NEAR;
      const lip = centre - rail * GROOVE_FAR;
      parts.push(beam(piece.points, piece.frames, Math.min(groove, lip), Math.max(groove, lip), base, base + RAIL_RISE + 0.002, SURFACE_GROOVE));
    }
  }
  return parts;
}

/** The lane surface over one stretch of a piece, paved in setts or laid to grass. */
function lane(points: readonly Point[], frames: readonly RoadFrame[], paved: boolean): BufferGeometry {
  const half = TRAM_LANE.halfWidth;
  const section: SectionPoint[] = [
    { across: -half, rise: SURFACE_RAISE + LANE_RAISE },
    { across: half, rise: SURFACE_RAISE + LANE_RAISE },
  ];
  const sections = points.map((point, i) => section.map((s) => place(point, frames[i] as RoadFrame, s.across, s.rise)));
  const surface = new LoftGeometry(sections, { closed: false });
  const count = surface.getAttribute('position').count;
  const across = new Float32Array(count);
  for (let v = 0; v < count; v++) across[v] = (section[v % section.length] as SectionPoint).across;
  return tag(surface, across, paved ? SURFACE_SETTS : SURFACE_TRACK_GRASS);
}

/** One run of points of a piece that take the same surface. */
interface Stretch {
  points: Point[];
  frames: RoadFrame[];
  paved: boolean;
}

/**
 * Cut a piece into stretches of one surface. Two neighbouring stretches share
 * the point between them, so the grass meets the setts with no gap.
 */
function stretchesOf(piece: Piece, paved: readonly Point[]): Stretch[] {
  const flags = piece.points.map((point) => nearPaved(point, paved));
  const out: Stretch[] = [];
  let open: Stretch | undefined;
  for (let i = 0; i < piece.points.length; i++) {
    // A segment is paved when either of its ends is; the point between two
    // segments of different surfaces closes one stretch and opens the next.
    const segment = i === 0 ? (flags[0] as boolean) : (flags[i] as boolean) || (flags[i - 1] as boolean);
    if (open === undefined || (i > 0 && open.paved !== segment)) {
      const last = open;
      open = { points: [], frames: [], paved: segment };
      if (last !== undefined) {
        open.points.push(last.points[last.points.length - 1] as Point);
        open.frames.push(last.frames[last.frames.length - 1] as RoadFrame);
      }
      out.push(open);
    }
    open.points.push(piece.points[i] as Point);
    open.frames.push(piece.frames[i] as RoadFrame);
  }
  return out.filter((stretch) => stretch.points.length > 1);
}

/**
 * Whether a point of the track is paved: within {@link PAVED_REACH} of a paved
 * place, or between two of them that stand closer together than
 * {@link MIN_GREEN} of open run apart. The second rule keeps a sliver of grass
 * from being laid between two junctions close together.
 *
 * It reads only the point and the places, never the run it lies on, so two
 * chunks either side of a boundary pave the same ground.
 */
function nearPaved(point: Point, paved: readonly Point[]): boolean {
  let nearest = Infinity;
  let second = Infinity;
  for (const place of paved) {
    const away = hypot(place.x - point.x, place.y - point.y);
    if (away < nearest) {
      second = nearest;
      nearest = away;
    } else if (away < second && away > nearest + SAME_PLACE) {
      second = away;
    }
  }
  return nearest <= PAVED_REACH || nearest + second <= 2 * PAVED_REACH + MIN_GREEN;
}

/**
 * The panel of a level crossing: a square of the lane's width laid over the
 * junction the tram crosses, on the junction's own surface.
 */
function crossingParts(crossing: TramCrossing, surfaceAt: SurfaceAt): BufferGeometry[] {
  const panel = crossingPanel(crossing, surfaceAt);
  if (panel === undefined) return [];
  return [panel, ...crossingMarks(crossing, surfaceAt)];
}

/**
 * The white line down each side of a crossing panel: a dashed outline of the
 * ground the tram takes, so a driver waiting at the junction reads where it
 * will come from. It stands over the panel as paint stands over a road.
 */
function crossingMarks(crossing: TramCrossing, surfaceAt: SurfaceAt): BufferGeometry[] {
  const half = TRAM_LANE.halfWidth;
  const rise = SURFACE_RAISE + LANE_RAISE + CROSSING_RAISE + MARK_RISE;
  const out: BufferGeometry[] = [];
  const step = MARK_DASH + MARK_GAP;
  const dashes = Math.floor((2 * CROSSING_REACH) / step);
  const start = -CROSSING_REACH + (2 * CROSSING_REACH - (dashes * step - MARK_GAP)) / 2;
  for (const side of [-1, 1]) {
    for (let d = 0; d < dashes; d++) {
      const from = start + d * step;
      const ring = [
        [from, side * half],
        [from + MARK_DASH, side * half],
        [from + MARK_DASH, side * (half - MARK_WIDTH)],
        [from, side * (half - MARK_WIDTH)],
      ].map(([along, across]) => {
        const x = crossing.x + crossing.alongX * (along as number) - crossing.alongY * (across as number);
        const y = crossing.y + crossing.alongY * (along as number) + crossing.alongX * (across as number);
        return new Vector3(x, surfaceAt(x, y, crossing.tier) + rise, y);
      });
      const dash = flatSurface(ring, 0);
      if (dash !== undefined) out.push(tag(dash, new Float32Array(dash.getAttribute('position').count), SURFACE_CROSSING_MARK));
    }
  }
  return out;
}

function crossingPanel(crossing: TramCrossing, surfaceAt: SurfaceAt): BufferGeometry | undefined {
  const half = TRAM_LANE.halfWidth;
  const corners: [number, number][] = [
    [-CROSSING_REACH, -half],
    [CROSSING_REACH, -half],
    [CROSSING_REACH, half],
    [-CROSSING_REACH, half],
  ];
  const rise = SURFACE_RAISE + LANE_RAISE + CROSSING_RAISE;
  const ring = corners.map(([along, across]) => {
    const x = crossing.x + crossing.alongX * along - crossing.alongY * across;
    const y = crossing.y + crossing.alongY * along + crossing.alongX * across;
    return new Vector3(x, surfaceAt(x, y, crossing.tier) + rise, y);
  });
  const panel = flatSurface(ring, 0);
  if (panel === undefined) return undefined;
  return tag(panel, new Float32Array(panel.getAttribute('position').count), SURFACE_CROSSING);
}
