/**
 * The ground a junction covers, as geometry (spec section 6.2).
 *
 * `junctions.ts` cuts every road back to where its kerbs leave its neighbours';
 * this draws what is left between the cuts: one carriageway polygon fanned from
 * the node, and a piece of pavement in each corner. The rings come from
 * `junction-shape.ts`, which the carve levels the ground under as well. Their
 * mouth vertices are the very sections the lofts of `road-mesh.ts` end on, so
 * the two meet without a seam whichever chunk built each of them.
 */
import { Vector3, type BufferGeometry } from 'three';
import { junctionShape, type JunctionVertex } from '../world/junction-shape.ts';
import type { Junction } from '../world/junctions.ts';
import type { RoadRibbons } from '../world/ribbon.ts';
import { footprintHalfWidth, TIERS } from '../world/tiers.ts';
import type { RoadTier } from '../world/types.ts';
import { flatSurface, SURFACE_RAISE, vergeRise } from './road-section.ts';

/** The ground under a place, for the corners of a junction to stand on. */
export type HeightAt = (x: number, y: number) => number;

/** True where a junction puts any surface into the batch of a tier. */
export function pavesAs(junction: Junction, tier: RoadTier): boolean {
  return junction.tier === tier || junction.corners.some((corner) => corner.tier === tier);
}

/** One surface of a junction, and the tier whose batch it goes into. */
export interface JunctionSurface {
  tier: RoadTier;
  geometry: BufferGeometry;
}

/**
 * The surfaces of one junction: its carriageway, paved as the widest road that
 * meets there, and a piece of pavement in each corner, paved as the wider of the
 * two roads beside it. Every vertex stands on the surface `junction-shape.ts`
 * gives it: along each mouth that is the road's own banked section, so the two
 * meet without a seam, and everywhere else the junction's plane, which is the
 * ground the carve levels under it.
 */
export function junctionSurfaces(junction: Junction, ribbons: RoadRibbons, heightAt: HeightAt): JunctionSurface[] {
  const out: JunctionSurface[] = [];
  const shape = junctionShape(junction, ribbons);
  if (shape.carriageway.length === 0) return out;
  const lift = (v: JunctionVertex): Vector3 =>
    new Vector3(v.x, (v.bed ?? heightAt(v.x, v.y)) + (v.edge === 'kerb' ? SURFACE_RAISE : vergeRise(v.tier)), v.y);

  // The carriageway is fanned from the node, which stands on the plane as the
  // corners do: the beds of the roads meet at the node, so a surface
  // stretched straight from one mouth to another would cut under a junction on
  // a ridge, and the ground would show through it.
  const centre = new Vector3(junction.x, (shape.centre ?? heightAt(junction.x, junction.y)) + SURFACE_RAISE, junction.y);
  const paved = flatSurface(shape.carriageway.map(lift), 0, centre);
  if (paved !== undefined) out.push({ tier: junction.tier, geometry: paved });

  for (let i = 0; i < shape.corners.length; i++) {
    const tier = (junction.corners[i] as Junction['corners'][number]).tier;
    const pavement = flatSurface((shape.corners[i] as JunctionVertex[]).map(lift), cornerAcross(tier));
    if (pavement !== undefined) out.push({ tier, geometry: pavement });
  }
  return out;
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
