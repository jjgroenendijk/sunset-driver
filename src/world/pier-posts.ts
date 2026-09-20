/**
 * The piers under the decks as a solid the physics can meet (spec sections
 * 11.3, 6.3).
 *
 * `piers.ts` says where a foot stands and `corridor-mesh.ts` draws the column
 * over it, so the piers were something to look at and nothing else: a car on
 * the under-structure parcel below an elevated highway, and a boat under a
 * bridge, drove straight through them (issue #304). This is the same column as
 * a plain description — a box from the ground up into the underside of the
 * deck, square to the road it carries — which `ground-bodies.ts` lays as a
 * cuboid.
 *
 * No pier foot stands on a road, so this is never what a car on the road meets;
 * it is what a driver who left the road meets.
 *
 * Built once for a world and asked about a window at a time, the way the decks
 * are. Pure: the same world gives the same posts, in the same order.
 */
import { atan2 } from '../core/libm.ts';
import { DECK_SOFFIT } from './decks.ts';
import { buildRoadGraph } from './graph.ts';
import { Heightfield } from './heightfield.ts';
import { buildJunctions } from './junctions.ts';
import { deckPiers, PIER_HALF } from './piers.ts';
import { RoadRibbons } from './ribbon.ts';
import type { RoadCurve, WorldDescription } from './types.ts';

/** Metres a post is sunk into the ground under it, so a wheel on a slope meets no gap beside it. */
const FOOTING = 0.6;

/** The shortest post worth standing, in metres. A deck lower than this over the ground is on its ramp. */
const MIN_POST = 0.5;

/** One pier standing in the world: a box on the ground, turned the way its deck runs. */
export interface PierPost {
  /** The middle of the foot. */
  x: number;
  y: number;
  /** Metres each side of the middle, across the deck and along it. */
  half: number;
  /** The way the deck runs there, as radians about the vertical. */
  angle: number;
  /** The underside of the box and the top of it: the ground under the foot, and the deck's soffit. */
  base: number;
  top: number;
}

/**
 * Every pier of a world as a post. A pier whose deck stands too low over the
 * ground for a column is left out, as it is left undrawn: there is nothing
 * there to drive into.
 */
export function pierPosts(world: WorldDescription): PierPost[] {
  const roads = world.roads;
  const junctions = buildJunctions(roads, buildRoadGraph(roads));
  const ribbons = new RoadRibbons(world.terrain, roads, junctions);
  const hf = new Heightfield(world.terrain);
  const out: PierPost[] = [];
  for (const pier of deckPiers(world)) {
    const frame = ribbons.frameAt(pier.curve, pier.segment, pier.x, pier.y);
    const top = frame.height + frame.bank * pier.across - DECK_SOFFIT;
    const base = hf.sample(pier.x, pier.y);
    if (top - base < MIN_POST) continue;
    // Along the road is across it turned a quarter, and the box is square to both.
    out.push({
      x: pier.x,
      y: pier.y,
      half: PIER_HALF[(roads[pier.curve] as RoadCurve).tier],
      angle: atan2(frame.acrossX, frame.acrossY),
      base: base - FOOTING,
      top,
    });
  }
  return out;
}
