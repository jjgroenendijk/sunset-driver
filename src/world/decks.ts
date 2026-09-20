/**
 * The decks the roads are carried on, as a solid the physics can stand on
 * (spec sections 6.1, 11.3).
 *
 * A segment listed in `RoadCurve.bridges` carves nothing, so the ground under
 * it is the water or the valley floor the road spans. The surface over it is
 * drawn by `road-mesh.ts` and the physics knew nothing about it, so a car
 * driving onto a bridge fell through it. This is the same deck as a plain
 * description: the strip the road drives on, at the bed height, with the
 * parapet each side of it.
 *
 * The strip is built once for a world and asked about a window at a time, the
 * way the chunks are. Pure: the same world gives the same decks.
 */
import { hypot } from '../core/libm.ts';
import { RoadBeds, surfaceHeight } from './bed.ts';
import { buildRoadGraph } from './graph.ts';
import { buildJunctions } from './junctions.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { Point, RoadCurve, RoadTier, WorldDescription } from './types.ts';

/** Metres a parapet stands above the deck. The car is kept on the bridge by it, as a driver is. */
export const PARAPET_HEIGHT = 0.9;

/**
 * Metres of structure under the surface a deck is driven on: the skirt the edge
 * of the carriageway drops into, and the depth of the deck under that.
 * `road-section.ts` sweeps the structure down to it and `pier-posts.ts` stands
 * the piers up into it, so this is how low a bridge reaches and how high a pier
 * stands.
 */
export const DECK_SOFFIT = 1.9;

/** One point of a deck: where it stands on the map, and how high the road drives there. */
export interface DeckPoint {
  x: number;
  y: number;
  height: number;
  /**
   * Metres the surface rises per metre along `across`, as `RoadFrame.bank` in
   * `ribbon.ts`. Zero away from a junction; inside a mouth the deck tilts as
   * the junction's plane does, so a place `off` metres across stands at
   * `height + bank * off`.
   */
  bank: number;
  /** Unit vector across the road, which the width is measured along. */
  acrossX: number;
  acrossY: number;
}

/** One stretch of road carried on a deck, from where it leaves the ground to where it lands again. */
export interface DeckSpan {
  curve: number;
  tier: RoadTier;
  /** Metres each side of the centreline the deck reaches: what `road-mesh.ts` lofts. */
  halfWidth: number;
  points: DeckPoint[];
  /** The box around the whole span, so a caller can skip one that is far away. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Every deck of a world, in the order the curves are listed. */
export function roadDecks(world: WorldDescription): DeckSpan[] {
  const roads = world.roads;
  const graph = buildRoadGraph(roads);
  const beds = new RoadBeds(world.terrain, roads, buildJunctions(roads, graph));
  const out: DeckSpan[] = [];
  for (const road of roads) {
    for (const stretch of stretchesOf(road.bridges)) out.push(spanOf(road, stretch, beds));
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
 * One stretch as a deck. A point inside the stretch takes the mean of the two
 * segments it joins, so the strip is one surface with no step in it; the two
 * ends take the segment they are on, which is the way the road leaves the
 * ground.
 */
function spanOf(road: RoadCurve, stretch: { from: number; to: number }, beds: RoadBeds): DeckSpan {
  const points: DeckPoint[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = stretch.from; i <= stretch.to + 1; i++) {
    const p = road.points[i] as Point;
    const before = i > stretch.from ? direction(road, i - 1) : undefined;
    const after = i <= stretch.to ? direction(road, i) : undefined;
    const dx = (before?.x ?? 0) + (after?.x ?? 0);
    const dy = (before?.y ?? 0) + (after?.y ?? 0);
    const length = hypot(dx, dy) || 1;
    // Across the road is along it turned a quarter.
    const acrossX = -dy / length;
    const acrossY = dx / length;
    const profile = beds.pointProfile(road.id, i);
    points.push({ x: p.x, y: p.y, height: profile.h, bank: surfaceHeight(0, profile.gx, profile.gy, acrossX, acrossY), acrossX, acrossY });
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const halfWidth = footprintHalfWidth(road.tier);
  return {
    curve: road.id,
    tier: road.tier,
    halfWidth,
    points,
    minX: minX - halfWidth,
    minY: minY - halfWidth,
    maxX: maxX + halfWidth,
    maxY: maxY + halfWidth,
  };
}

/** The unit direction of one segment of a curve. */
function direction(road: RoadCurve, segment: number): Point {
  const a = road.points[segment] as Point;
  const b = road.points[segment + 1] as Point;
  const length = hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
}
