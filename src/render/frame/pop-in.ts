/**
 * Where a frame shows things pop in, in metres from the camera (spec section
 * 9.2, `docs/performance-budget.md`).
 *
 * Two kinds of edge show. An edge by design is where a rule stops drawing
 * something: the square the traffic is drawn in, the ring of chunks that carry
 * facades. It moves with the player and the camera, and the budget says how
 * near it may stand in sight. A hole is streaming that is late: a chunk in
 * sight that is not in the scene yet, or has only some of its batches. Every
 * hole is a pop the player sees, so the budget allows none near.
 *
 * `sightline.ts` finds the ground in sight; this names the edges and reads the chunks.
 */
import type { PerspectiveCamera } from 'three';
import { PEDESTRIAN_VIEW } from '../people/pedestrians.ts';
import type { ChunkDrawn } from '../streaming/chunk-tiles.ts';
import { FACADE_RADIUS } from '../streaming/streaming.ts';
import { PARKED_VIEW } from '../vehicles/parked.ts';
import { TRAFFIC_VIEW } from '../vehicles/traffic.ts';
import { entityDistance, type QualityTier } from './quality.ts';
import { edgeInSight, groundInSight, pastCircle, pastRing, pastSquare } from './sightline.ts';

/** The edges a frame can show, in the order a report lists them. */
export const EDGES = ['facades', 'streets', 'city', 'traffic', 'parked', 'crowd', 'plants'] as const;
export type Edge = (typeof EDGES)[number];

/** Metres from the camera to where each thing pops in, `Infinity` where it does not show. */
export interface PopIn {
  /** A chunk in sight that is missing, or has only some of its batches. */
  hole: number;
  /** A chunk in sight drawn at another detail than its ring asks for, while the right one is built. */
  late: number;
  /** Each edge by design. */
  edges: Record<Edge, number>;
}

/** What `popIn` reads of the world: the chunks, the tier, and where the haze closes. */
export interface PopInWorld {
  drawnAt(x: number, y: number): ChunkDrawn;
  quality: QualityTier;
  hazeFar: number;
}

/**
 * Where the frame the camera draws shows things pop in, for a player at
 * `(x, y)` standing on ground at `groundY`.
 */
export function popIn(camera: PerspectiveCamera, world: PopInWorld, x: number, y: number, groundY: number): PopIn {
  const sight = groundInSight(camera, groundY, world.hazeFar);
  const rings = world.quality.rings;
  const drawn = (want: ChunkDrawn) => (gx: number, gy: number) => world.drawnAt(gx, gy) === want;
  return {
    hole: Math.min(edgeInSight(sight, drawn('missing')), edgeInSight(sight, drawn('partial'))),
    late: edgeInSight(sight, drawn('late')),
    edges: {
      facades: edgeInSight(sight, pastRing(x, y, Math.min(FACADE_RADIUS, rings.near))),
      streets: edgeInSight(sight, pastRing(x, y, rings.near)),
      city: edgeInSight(sight, pastRing(x, y, rings.far)),
      traffic: edgeInSight(sight, pastSquare(x, y, TRAFFIC_VIEW)),
      parked: edgeInSight(sight, pastSquare(x, y, PARKED_VIEW)),
      crowd: edgeInSight(sight, pastSquare(x, y, PEDESTRIAN_VIEW)),
      plants: edgeInSight(sight, pastCircle(x, y, entityDistance(world.quality))),
    },
  };
}
