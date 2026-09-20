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
import { LoftGeometry } from 'three/examples/jsm/geometries/LoftGeometry.js';
import type { ChunkPier, WorldChunk } from '../world/chunks.ts';
import { PIER_HALF } from '../world/piers.ts';
import type { RoadFrame, RoadRibbons } from '../world/ribbon.ts';
import { piecesOf, type Piece } from '../world/road-pieces.ts';
import { TRAM_LANE } from '../world/tiers.ts';
import type { TramCrossing } from '../world/tram-track.ts';
import type { Point, RoadTier } from '../world/types.ts';
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
  SURFACE_RAIL,
  SURFACE_RAISE,
  SURFACE_STRUCTURE,
  SURFACE_TRAM_LANE,
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
/** Metres each side of a rail's centre. A real rail head is 7 cm across; this one reads from the camera. */
const RAIL_HALF = 0.06;
/** Metres a crossing panel reaches along the track each side of the node. */
const CROSSING_REACH = 4;

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
    const parts = piecesOf(run, ribbons).flatMap(trackOf);
    if (parts.length > 0) out.push({ tier: run.tier, geometry: merge(parts) });
  }
  for (const crossing of chunk.tramCrossings) {
    const geometry = crossingPanel(crossing, surfaceAt);
    if (geometry !== undefined) out.push({ tier: crossing.tier, geometry });
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
 * The track along one piece of a run: the reserved lane, and the four rails of
 * the two tracks on it.
 */
function trackOf(piece: Piece): BufferGeometry[] {
  const half = TRAM_LANE.halfWidth;
  const lane: SectionPoint[] = [
    { across: -half, rise: SURFACE_RAISE + LANE_RAISE },
    { across: half, rise: SURFACE_RAISE + LANE_RAISE },
  ];
  const sections = piece.points.map((point, i) => lane.map((s) => place(point, piece.frames[i] as RoadFrame, s.across, s.rise)));
  const surface = new LoftGeometry(sections, { closed: false });
  const count = surface.getAttribute('position').count;
  const across = new Float32Array(count);
  for (let v = 0; v < count; v++) across[v] = (lane[v % lane.length] as SectionPoint).across;
  const parts: BufferGeometry[] = [tag(surface, across, SURFACE_TRAM_LANE)];

  // The rails stand on the lane rather than over it, so none of their length
  // floats. They reach RAIL_RISE up, which clears a crossing panel by the 2 cm
  // of rail head a crossing shows.
  const base = SURFACE_RAISE + LANE_RAISE;
  for (const track of [-1, 1]) {
    for (const rail of [-1, 1]) {
      const centre = (track * TRAM_LANE.trackSpacing) / 2 + (rail * TRAM_LANE.gauge) / 2;
      parts.push(beam(piece.points, piece.frames, centre - RAIL_HALF, centre + RAIL_HALF, base, base + RAIL_RISE, SURFACE_RAIL));
    }
  }
  return parts;
}

/**
 * The panel of a level crossing: a square of the lane's width laid over the
 * junction the tram crosses, on the junction's own surface.
 */
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
