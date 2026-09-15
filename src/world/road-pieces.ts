/**
 * A chunk's road runs cut into the stretches one loft each can cover (spec
 * sections 6.1, 6.2): short of every junction the run meets, and at every turn
 * too sharp to mitre.
 *
 * `road-mesh.ts` lofts the pieces, and `pavement.ts` reads the same pieces to
 * know the carriageway as it is drawn. Both cut the same way because the curve
 * decides every cut and the chunk decides none.
 */
import type { ChunkRoad } from './chunks.ts';
import type { RoadFrame, RoadRibbons } from './ribbon.ts';
import type { Point } from './types.ts';

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
export interface Piece {
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
export function piecesOf(run: ChunkRoad, ribbons: RoadRibbons): Piece[] {
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
