/**
 * The overhead line the tram draws its power from (spec section 13.2): the
 * masts down the middle of the reserved lane, the arms across their tops, and
 * the contact wire over each of the two tracks.
 *
 * A tram with no wire over it reads as a bus on rails, so the line is drawn
 * wherever the track is. The masts stand between the two tracks rather than at
 * the kerb: the gap between the near rails of the two tracks is 1.7 m of
 * ground no wheel ever touches, and a mast there is clear of the traffic lanes
 * on both sides of the reserved lane. Each carries an arm that reaches out to
 * both wires, which is what a real centre pole does.
 *
 * A mast is placed at a whole multiple of {@link MAST_SPACING} of the curve's
 * own distance, so the same masts stand in the same places however the run is
 * cut into chunks and pieces.
 *
 * Like the track (`corridor-mesh.ts`), none of this is a batch of its own: the
 * parts go into the batch of the road the wire hangs over, so the line costs no
 * draw call. Nothing here touches the renderer or TSL, so it runs headless.
 */
import type { BufferGeometry } from 'three';
import type { RoadFrame } from '../world/ribbon.ts';
import type { Piece } from '../world/road-pieces.ts';
import { TRAM_LANE } from '../world/tiers.ts';
import type { Point } from '../world/types.ts';
import { beam, SURFACE_CATENARY, SURFACE_RAISE, SURFACE_WIRE } from './road-section.ts';

/** Metres along the track from one mast to the next. */
export const MAST_SPACING = 28;

/** Metres above the road bed the contact wire hangs. A tram is 3.3 m tall, so its pantograph reaches. */
export const WIRE_HEIGHT = 5.6;

/** Metres each side of a wire's centre, and how deep it hangs. A wire is a line; this one reads. */
const WIRE_HALF = 0.03;
const WIRE_DEEP = 0.05;

/** Metres each side of a mast's centre, and how far it reaches over the wire. */
const MAST_HALF = 0.11;
const MAST_OVER = 0.55;

/** The arm across a mast's top: how far out it reaches past the wires, and how deep it is. */
const ARM_REACH = 0.3;
const ARM_DEEP = 0.14;
/** Metres of track one mast or one arm takes up, so a box can be swept along it. */
const MAST_ALONG = 0.11;
const ARM_ALONG = 0.07;

/** The overhead line over one piece of a run: the two wires and every mast under them. */
export function catenaryOf(piece: Piece): BufferGeometry[] {
  const base = SURFACE_RAISE;
  const track = TRAM_LANE.trackSpacing / 2;
  const parts: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const centre = side * track;
    parts.push(beam(piece.points, piece.frames, centre - WIRE_HALF, centre + WIRE_HALF, base + WIRE_HEIGHT, base + WIRE_HEIGHT + WIRE_DEEP, SURFACE_WIRE));
  }
  for (const at of mastPlaces(piece)) {
    const points = sweep(at.point, at.frame, MAST_ALONG);
    const frames = [at.frame, at.frame];
    parts.push(beam(points, frames, -MAST_HALF, MAST_HALF, base, base + WIRE_HEIGHT + MAST_OVER, SURFACE_CATENARY));
    const arm = sweep(at.point, at.frame, ARM_ALONG);
    const reach = track + ARM_REACH;
    const top = base + WIRE_HEIGHT + MAST_OVER;
    parts.push(beam(arm, frames, -reach, reach, top - ARM_DEEP, top, SURFACE_CATENARY));
  }
  return parts;
}

/** Where a mast stands and the frame it stands in. */
interface MastPlace {
  point: Point;
  frame: RoadFrame;
}

/**
 * Every place along a piece where the curve's own distance passes a multiple of
 * {@link MAST_SPACING}. The distance is the curve's, not the piece's, so a run
 * cut at a chunk boundary puts its masts where the whole run would have.
 */
function mastPlaces(piece: Piece): MastPlace[] {
  const out: MastPlace[] = [];
  for (let i = 0; i + 1 < piece.points.length; i++) {
    const from = piece.frames[i] as RoadFrame;
    const to = piece.frames[i + 1] as RoadFrame;
    const span = to.distance - from.distance;
    if (span <= 0) continue;
    const first = Math.ceil(from.distance / MAST_SPACING);
    const last = Math.floor(to.distance / MAST_SPACING);
    for (let k = first; k <= last; k++) {
      // A mast on the seam between two segments belongs to the first of them.
      const into = (k * MAST_SPACING - from.distance) / span;
      if (into >= 1 && i + 2 < piece.points.length) continue;
      out.push({
        point: between(piece.points[i] as Point, piece.points[i + 1] as Point, into),
        frame: blend(from, to, into),
      });
    }
  }
  return out;
}

/** Two points a short way apart along the track, so a box can be swept between them. */
function sweep(at: Point, frame: RoadFrame, length: number): Point[] {
  // Along the road is across it turned a quarter.
  const alongX = frame.acrossY;
  const alongY = -frame.acrossX;
  return [
    { x: at.x - alongX * (length / 2), y: at.y - alongY * (length / 2) },
    { x: at.x + alongX * (length / 2), y: at.y + alongY * (length / 2) },
  ];
}

function between(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** The frame part way between two, for a mast that stands between two points of a run. */
function blend(a: RoadFrame, b: RoadFrame, t: number): RoadFrame {
  const lerp = (from: number, to: number): number => from + (to - from) * t;
  return {
    height: lerp(a.height, b.height),
    bank: lerp(a.bank, b.bank),
    acrossX: lerp(a.acrossX, b.acrossX),
    acrossY: lerp(a.acrossY, b.acrossY),
    // A mast is a box at one place, so it takes the width of the section it
    // stands in rather than a corner's stretch.
    mitre: 1,
    distance: lerp(a.distance, b.distance),
  };
}
