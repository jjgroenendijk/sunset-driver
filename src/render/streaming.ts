/**
 * What the streamer asks for, and what it may spend on it (spec sections 9.1,
 * 2.4).
 *
 * Two rings of chunks stand around the player. The near ring is the city as the
 * game draws it: every road, every building, every plant. The far ring is the
 * same ground at a simpler detail, so the skyline holds where the near ring
 * ends instead of stopping at a wall of haze. A chunk that leaves the far ring
 * is dropped.
 *
 * The near ring has a middle detail of its own for the buildings (spec section
 * 9.2). Only the chunks within {@link FACADE_RADIUS} carry generated facades;
 * past it, a tower is an outlined block, and everything else is as near.
 *
 * Nothing here builds or draws anything: it says which chunks are wanted, in
 * which order, and how much of a frame their upload may take. That keeps the
 * policy readable on its own and testable without a renderer.
 */
import type { Object3D } from 'three';

/**
 * How much detail a chunk is built and drawn at: `near` in full, `mid` in full
 * but with every building a block, and `far` as the massing.
 */
export type ChunkDetail = 'near' | 'mid' | 'far';

/**
 * One piece of a chunk in the scene: what it adds, what it costs to draw and
 * how to take it away. The ground of a chunk is one piece, each tier of road
 * over it another, and each batch of buildings another, so the queue is cut
 * into pieces a frame can afford.
 */
export interface TilePart {
  objects: Object3D[];
  /** Draw calls these objects cost. */
  drawCalls: number;
  /** What is left to copy into their batches, one step of the fill each. */
  steps: (() => void)[];
  /**
   * Whether the batches of this piece cast the sun's shadow. Left out, they
   * do: a piece is solid geometry standing on the ground. The outline hulls of
   * `buildings.ts` are the one piece that says otherwise.
   */
  castsShadow?: boolean;
  /** Release the geometry. The materials belong to the world and are left alone. */
  dispose(): void;
}

/**
 * Chunks each way of the player drawn at full detail. One chunk is 250 m.
 *
 * This is the draw distance at full quality. The quality tiers of spec section
 * 9.2 pull both radii in on a machine that cannot hold the frame, which is why
 * everything below takes them rather than reading them.
 */
export const NEAR_RADIUS = 2;

/**
 * Chunks each way of the player whose towers carry their generated facades.
 * A core chunk costs about a million vertices that way and about thirty
 * thousand as blocks.
 *
 * One ring is what the camera of spec section 10.7 sees: at the top speed of
 * the roster the far edge of its view stands about 130 m from it, and a chunk
 * two rings out starts 250 m from the player. A tier that pulls the near ring
 * in pulls this with it, never out past the near ring.
 */
export const FACADE_RADIUS = 1;

/**
 * Chunks each way of the player drawn at all. Past the near ring the ground,
 * the major roads and the massing of the buildings are kept and the rest is
 * dropped, so the city fades in detail rather than in extent.
 *
 * One ring past the near one is what the camera of spec section 10.7 can see:
 * it looks down from 60 m, and the haze closes over the ground the near ring
 * ends at. A second far ring would be geometry nobody ever looks at.
 */
export const FAR_RADIUS = 3;

/**
 * Milliseconds of a frame the main thread may spend putting chunks into the
 * scene. This is the streaming slice of spec section 2.4 in full: the work in
 * the workers costs the frame nothing, so the upload is all that is left of it.
 */
export const STREAM_BUDGET_MS = 2;

/**
 * How far the two rings reach, in chunks. A quality tier of spec section 9.2
 * is what sets them; {@link FULL_RINGS} is the game at full quality.
 */
export interface ChunkRings {
  near: number;
  far: number;
}

/** The rings at full quality: {@link NEAR_RADIUS} and {@link FAR_RADIUS}. */
export const FULL_RINGS: ChunkRings = { near: NEAR_RADIUS, far: FAR_RADIUS };

/** One chunk the streamer wants, and the detail it wants it at. */
export interface ChunkWant {
  cx: number;
  cy: number;
  detail: ChunkDetail;
}

/**
 * Every chunk wanted around a player standing in chunk `(cx, cy)`, nearest
 * first. The order is what a worker takes its next job from, so the ground the
 * player is about to drive over is built before the ground behind them.
 *
 * Distance is measured to the middle of a chunk, so the ring is round rather
 * than square: a corner of the far ring is farther away than its edge and is
 * asked for last.
 */
export function wantedChunks(cx: number, cy: number, rings: ChunkRings = FULL_RINGS): ChunkWant[] {
  const wants: { want: ChunkWant; distance: number }[] = [];
  for (let dy = -rings.far; dy <= rings.far; dy++) {
    for (let dx = -rings.far; dx <= rings.far; dx++) {
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      if (ring > rings.far) continue;
      const detail = detailOfRing(ring, rings) as ChunkDetail;
      wants.push({ want: { cx: cx + dx, cy: cy + dy, detail }, distance: dx * dx + dy * dy });
    }
  }
  wants.sort((a, b) => a.distance - b.distance);
  return wants.map((entry) => entry.want);
}

/** True when a chunk stands inside the ring the detail it was built at belongs to. */
export function detailAt(
  cx: number,
  cy: number,
  atX: number,
  atY: number,
  rings: ChunkRings = FULL_RINGS,
): ChunkDetail | undefined {
  return detailOfRing(Math.max(Math.abs(cx - atX), Math.abs(cy - atY)), rings);
}

/** The detail of a chunk that many rings out from the player, or nothing past the far ring. */
function detailOfRing(ring: number, rings: ChunkRings): ChunkDetail | undefined {
  if (ring > rings.far) return undefined;
  if (ring <= Math.min(FACADE_RADIUS, rings.near)) return 'near';
  return ring <= rings.near ? 'mid' : 'far';
}

/**
 * Run jobs from the front of `queue` until the budget is spent, and leave the
 * rest for the next frame. The jobs that ran are taken off the queue.
 *
 * One job always runs, however long it takes: a job dearer than the whole
 * budget would otherwise never run at all and the queue would stand still. The
 * work is therefore cut into jobs small enough that overrunning by one of them
 * costs a frame rather than a stall.
 */
export function spendBudget(queue: (() => void)[], budgetMs: number, now: () => number): number {
  if (queue.length === 0) return 0;
  const started = now();
  let ran = 0;
  while (queue.length > 0) {
    const job = queue.shift() as () => void;
    job();
    ran++;
    if (now() - started >= budgetMs) break;
  }
  return ran;
}
