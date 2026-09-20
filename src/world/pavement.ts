/**
 * The pavement and the verges of one chunk (spec sections 6.2, 6.4).
 *
 * The blocks are the faces of the planar road graph. A block's pavement is the
 * inset of its face: the ground between the kerb and the edge of the footprint.
 * So the pavement is cut here, as the ground the roads claim less the
 * carriageway as it is drawn, and never lofted along a road. Two faults of a
 * pavement lofted with its road cannot happen this way: a pavement laid over
 * another road's carriageway, and a corner whose pavement crosses itself. A
 * corner with no room for pavement leaves nothing.
 *
 * The carriageway is read off the same pieces `road-mesh.ts` lofts and the
 * same junction rings `junction-mesh.ts` fans, so a pavement meets the road at
 * its kerb exactly. The ground claimed is the footprint without its corridors:
 * each run on the ground offset by `footprintHalfWidth`, and an apron over each
 * junction of three roads or more. Each tier is cut in turn, the widest first,
 * and a tier takes only ground no wider tier took, so a corner between two roads
 * is paved as the wider of them.
 *
 * A chunk cuts its pavement from every road that reaches it, gathered from a
 * window wider than the chunk, and keeps what falls inside the chunk. Two
 * neighbours cut the same edges on the line they share, so they meet exactly.
 * Pure: the same pieces give the same pavement.
 */
import { difference, offsetSides, regionOf, ringArea, split, strip, type Point, type Region } from '../core/geom.ts';
import type { ChunkBounds, ChunkRoad } from './chunks.ts';
import { junctionShape } from './junction-shape.ts';
import type { Junction } from './junctions.ts';
import type { RoadFrame, RoadRibbons } from './ribbon.ts';
import { piecesOf, trimRun } from './road-pieces.ts';
import { footprintHalfWidth, TIERS } from './tiers.ts';
import type { RoadTier } from './types.ts';

/**
 * Metres past a chunk that roads and junctions are gathered from. The widest
 * footprint is 17 m each side and a mitre reaches half as far again, so nothing
 * further out can claim ground inside the chunk.
 */
export const PAVEMENT_WINDOW = 40;

/**
 * Metres from the kerb that the depth of a vertex is measured to. The widest
 * verge is 4 m, and past the verge the material draws pavement however deep
 * the vertex stands.
 */
const DEPTH_REACH = 5;

/** Square metres below which a carriageway piece is a sliver and adds nothing. */
const MIN_PIECE_AREA = 1e-4;

/** The tiers in the order they claim pavement: the widest first. */
const CLAIM_ORDER: readonly RoadTier[] = ['highway', 'arterial', 'street', 'dirt', 'alley'];

/** One piece of pavement or verge inside a chunk. */
export interface ChunkPavement {
  /** The tier whose material the piece is drawn in. */
  tier: RoadTier;
  /** The ground it covers, inside the chunk. */
  region: Region;
  /**
   * Metres from each vertex to the nearest kerb, up to {@link DEPTH_REACH}:
   * `outer[i]` for `region.outer[i]`, and `holes[h][i]` for each hole.
   */
  depth: { outer: number[]; holes: number[][] };
}

/** An apron over a junction of three roads or more: the ring, and the tier it is claimed by. */
export interface PavementApron {
  ring: Point[];
  tier: RoadTier;
}

/** Everything near a chunk that its pavement is cut from. */
export interface PavementWindow {
  /** The road runs inside the window, cut at its edge. */
  roads: readonly ChunkRoad[];
  /** Every junction whose surface reaches the window. */
  junctions: readonly Junction[];
  aprons: readonly PavementApron[];
}

/** Cut the pavement of the chunk inside `bounds`. */
export function pavementIn(bounds: ChunkBounds, window: PavementWindow, ribbons: RoadRibbons): ChunkPavement[] {
  const carriageway = carriagewayOf(window, ribbons);
  const claims = new Map<RoadTier, Region[]>();
  const stretches = window.roads.map((run) => groundStretches(run));
  for (const tier of CLAIM_ORDER) {
    const reach = footprintHalfWidth(tier);
    if (reach <= TIERS[tier].width / 2) continue;
    const claimed: Region[] = [];
    window.roads.forEach((run, r) => {
      if (run.tier !== tier) return;
      for (const stretch of stretches[r] as Stretch[]) claimed.push(regionOf(claimOf(run, stretch, reach, ribbons)));
    });
    for (const apron of window.aprons) if (apron.tier === tier) claimed.push(regionOf(apron.ring));
    if (claimed.length > 0) claims.set(tier, claimed);
  }
  const tiers = CLAIM_ORDER.filter((tier) => claims.has(tier));
  if (tiers.length === 0) return [];
  // One pass takes the carriageway and everything outside the chunk away from
  // the ground every tier claims. The pieces may overlap: the arithmetic counts
  // how many wind round a place, so none of them needs a union first.
  let rest = difference(
    tiers.flatMap((tier) => claims.get(tier) as Region[]),
    [...carriageway, frameAround(bounds)],
  );
  const kerbs = new KerbIndex(carriageway, bounds);
  const out: ChunkPavement[] = [];
  for (let t = 0; t < tiers.length && rest.length > 0; t++) {
    const tier = tiers[t] as RoadTier;
    // The widest tier takes the ground it claims, and a narrower one only what
    // is left. The last tier present takes the rest, which is all its own.
    let mine = rest;
    if (t + 1 < tiers.length) {
      const cut = split(rest, claims.get(tier) as Region[]);
      mine = cut.inside;
      rest = cut.outside;
    }
    for (const region of mine) {
      out.push({
        tier,
        region,
        depth: { outer: region.outer.map((p) => kerbs.depth(p)), holes: region.holes.map((h) => h.map((p) => kerbs.depth(p))) },
      });
    }
  }
  return out;
}

/**
 * The carriageway as it is drawn: a ring along every stretch of a run on the
 * ground, cut short of its junctions as `road-mesh.ts` lofts it, and the fan of
 * every junction.
 */
function carriagewayOf(window: PavementWindow, ribbons: RoadRibbons): Region[] {
  const out: Region[] = [];
  const add = (ring: Point[]): void => {
    if (ring.length >= 3 && Math.abs(ringArea(ring)) >= MIN_PIECE_AREA) out.push(regionOf(ring));
  };
  for (const run of window.roads) {
    const half = TIERS[run.tier].width / 2;
    const off = (segment: number): boolean => run.bridges.includes(segment) || run.tunnels.includes(segment);
    for (const sub of trimRun(run, ribbons)) {
      // One ring per stretch on the ground: the left kerb out and the right one
      // back. A stretch carries on through a turn too sharp to mitre, taking the
      // frame it arrives on and the one it leaves on, so the outer kerb runs
      // along the bevel `road-mesh.ts` lays there. The inner kerb loops over
      // itself at the turn, and that loop is ground the carriageway covers.
      const offSub = (segment: number): boolean => sub.bridges.includes(segment) || sub.tunnels.includes(segment);
      let left: Point[] = [];
      let right: Point[] = [];
      let end = -1;
      const close = (): void => {
        if (left.length > 1) add([...left, ...right.reverse()]);
        left = [];
        right = [];
      };
      for (const piece of piecesOf(sub, ribbons)) {
        if (piece.from !== end) close();
        for (let k = 0; k + 1 < piece.points.length; k++) {
          if (offSub(piece.from + k)) {
            close();
            continue;
          }
          for (const i of k === 0 || left.length === 0 ? [k, k + 1] : [k + 1]) {
            left.push(side(piece.points[i] as Point, piece.frames[i] as RoadFrame, -half));
            right.push(side(piece.points[i] as Point, piece.frames[i] as RoadFrame, half));
          }
        }
        end = piece.from + piece.points.length - 1;
      }
      close();
    }
    // A junction's fan still leaves some of a road's own carriageway between
    // its cut and the node, where the ring is not the outline of what the
    // mouths cover (issue #542), and that is no place for a pavement. So every
    // stretch of segments a junction takes is added whole.
    if (run.gaps.length === 0) continue;
    let taken: Point[] = [];
    for (let k = 0; k + 1 < run.points.length; k++) {
      const a = run.points[k] as Point;
      const b = run.points[k + 1] as Point;
      const from = ribbons.frameAt(run.curve, run.from + k, a.x, a.y).distance;
      const to = ribbons.frameAt(run.curve, run.from + k, b.x, b.y).distance;
      const inGap = run.gaps.some((gap) => gap.from.distance < Math.max(from, to) && gap.to.distance > Math.min(from, to));
      if (!off(k) && inGap) {
        if (taken.length === 0) taken.push(a);
        taken.push(b);
        continue;
      }
      if (taken.length > 1) add(strip(taken, half));
      taken = [];
    }
    if (taken.length > 1) add(strip(taken, half));
  }
  for (const junction of window.junctions) {
    const ring: Point[] = junctionShape(junction, ribbons).carriageway.map((v) => ({ x: v.x, y: v.y }));
    // The carriageway is fanned from the node, and where the node cannot see
    // the whole ring the fan reaches past it. A place covered only by triangles
    // that turn the way the ring does is inside the ring, so the fan is the ring
    // and the triangles that turn the other way.
    add(ring);
    const node: Point = { x: junction.x, y: junction.y };
    const way = Math.sign(ringArea(ring));
    for (let i = 0; i < ring.length; i++) {
      const triangle = [node, ring[i] as Point, ring[(i + 1) % ring.length] as Point];
      // A ring with no area of its own says nothing, and every triangle counts.
      if (way === 0 || Math.sign(ringArea(triangle)) === -way) add(triangle);
    }
  }
  return out;
}

/** Where a place `across` metres off a piece's centreline stands, as the loft puts it. */
function side(point: Point, frame: RoadFrame, across: number): Point {
  const off = across * frame.mitre;
  return { x: point.x + frame.acrossX * off, y: point.y + frame.acrossY * off };
}

/** A stretch of a run on the ground: its points, and the run segment it starts on. */
interface Stretch {
  from: number;
  points: Point[];
}

/** The stretches of a run that lie on the ground. */
function groundStretches(run: ChunkRoad): Stretch[] {
  const segments = run.points.length - 1;
  const out: Stretch[] = [];
  let start = -1;
  for (let i = 0; i <= segments; i++) {
    const onGround = i < segments && !run.bridges.includes(i) && !run.tunnels.includes(i);
    if (onGround && start === -1) start = i;
    if (!onGround && start !== -1) {
      out.push({ from: start, points: run.points.slice(start, i + 1) });
      start = -1;
    }
  }
  return out;
}

/**
 * The ground a stretch claims, `reach` metres each side: the footprint's strip,
 * with each end cut on the frame the road's loft ends on there. Where a road
 * leaves the ground onto a deck, the loft of the deck ends on the mitre of the
 * point it leaves from, and a strip cut square would lay a sliver of pavement
 * over the deck.
 */
function claimOf(run: ChunkRoad, stretch: Stretch, reach: number, ribbons: RoadRibbons): Point[] {
  const { left, right } = offsetSides(stretch.points, reach);
  const last = stretch.points.length - 1;
  const first = stretch.points[0] as Point;
  const end = stretch.points[last] as Point;
  const start = ribbons.frameAt(run.curve, run.from + stretch.from, first.x, first.y);
  const finish = ribbons.frameAt(run.curve, run.from + stretch.from + last - 1, end.x, end.y);
  left[0] = side(first, start, reach);
  right[0] = side(first, start, -reach);
  left[last] = side(end, finish, reach);
  right[last] = side(end, finish, -reach);
  return [...left, ...right.reverse()];
}

/**
 * The ground outside a chunk, out past the window: a square ring with the
 * chunk as its hole. Taken away with the carriageway, it leaves the ground
 * inside the chunk.
 */
function frameAround(box: ChunkBounds): Region {
  const far = 2 * PAVEMENT_WINDOW;
  return {
    outer: [
      { x: box.minX - far, y: box.minY - far },
      { x: box.maxX + far, y: box.minY - far },
      { x: box.maxX + far, y: box.maxY + far },
      { x: box.minX - far, y: box.maxY + far },
    ],
    holes: [
      [
        { x: box.minX, y: box.minY },
        { x: box.minX, y: box.maxY },
        { x: box.maxX, y: box.maxY },
        { x: box.maxX, y: box.minY },
      ],
    ],
  };
}

/**
 * The edges of the carriageway pieces near a chunk, filed in a grid of cells
 * {@link DEPTH_REACH} across, so the depth of a vertex asks the nine cells
 * around it and nothing else.
 */
class KerbIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly ends: number[] = [];
  private readonly originX: number;
  private readonly originY: number;
  private readonly columns: number;

  constructor(carriageway: readonly Region[], bounds: ChunkBounds) {
    this.originX = bounds.minX - 2 * DEPTH_REACH;
    this.originY = bounds.minY - 2 * DEPTH_REACH;
    this.columns = Math.ceil((bounds.maxX - bounds.minX) / DEPTH_REACH) + 4;
    for (const region of carriageway) {
      for (const ring of [region.outer, ...region.holes]) {
        for (let i = 0; i < ring.length; i++) this.file(ring[i] as Point, ring[(i + 1) % ring.length] as Point);
      }
    }
  }

  /** Metres from a place to the nearest kerb, or {@link DEPTH_REACH} where none is nearer. */
  depth(p: Point): number {
    const cx = Math.floor((p.x - this.originX) / DEPTH_REACH);
    const cy = Math.floor((p.y - this.originY) / DEPTH_REACH);
    let best = DEPTH_REACH * DEPTH_REACH;
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (x < 0 || y < 0 || x >= this.columns || y >= this.columns) continue;
        for (const e of this.cells.get(y * this.columns + x) ?? []) {
          const ends = this.ends;
          best = Math.min(best, segmentDistanceSquared(ends[e] as number, ends[e + 1] as number, ends[e + 2] as number, ends[e + 3] as number, p));
        }
      }
    }
    return Math.sqrt(best);
  }

  /** File an edge in every cell its box touches, where that is inside the grid. */
  private file(a: Point, b: Point): void {
    const x0 = Math.floor((Math.min(a.x, b.x) - this.originX) / DEPTH_REACH);
    const x1 = Math.floor((Math.max(a.x, b.x) - this.originX) / DEPTH_REACH);
    const y0 = Math.floor((Math.min(a.y, b.y) - this.originY) / DEPTH_REACH);
    const y1 = Math.floor((Math.max(a.y, b.y) - this.originY) / DEPTH_REACH);
    if (x1 < 0 || y1 < 0 || x0 >= this.columns || y0 >= this.columns) return;
    const at = this.ends.length;
    this.ends.push(a.x, a.y, b.x, b.y);
    for (let y = Math.max(0, y0); y <= Math.min(this.columns - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(this.columns - 1, x1); x++) {
        const key = y * this.columns + x;
        const list = this.cells.get(key);
        if (list === undefined) this.cells.set(key, [at]);
        else list.push(at);
      }
    }
  }
}

function segmentDistanceSquared(ax: number, ay: number, bx: number, by: number, p: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const squared = dx * dx + dy * dy;
  let t = squared === 0 ? 0 : ((p.x - ax) * dx + (p.y - ay) * dy) / squared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ox = p.x - (ax + dx * t);
  const oy = p.y - (ay + dy * t);
  return ox * ox + oy * oy;
}
