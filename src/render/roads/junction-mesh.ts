/**
 * The carriageway of a junction, as geometry (spec section 6.2).
 *
 * `junctions.ts` cuts every road back to where its kerbs leave its neighbours';
 * this draws the carriageway left between the cuts as one polygon fanned from
 * the node. The pavement round the corners is cut out of the blocks by
 * `pavement.ts`. The ring comes from `junction-shape.ts`, which the carve levels
 * the ground under as well. Its mouth vertices are the very sections the lofts
 * of `road-mesh.ts` end on, so the two meet without a seam whichever chunk built
 * each of them.
 */
import { Vector3, type BufferGeometry } from 'three';
import { junctionShape, type JunctionVertex } from '../../world/junctions/junction-shape.ts';
import type { Junction } from '../../world/junctions/junctions.ts';
import type { RoadRibbons } from '../../world/carve/ribbon.ts';
import type { RoadTier } from '../../world/types.ts';
import { flatSurface, SURFACE_RAISE } from './road-section.ts';

/** The height of the surface at a place, for a surface to stand on where no bed is known. */
export type HeightAt = (x: number, y: number) => number;

/** True where a junction puts its surface into the batch of a tier. */
export function pavesAs(junction: Junction, tier: RoadTier): boolean {
  return junction.tier === tier;
}

/** One surface of a junction, and the tier whose batch it goes into. */
export interface JunctionSurface {
  tier: RoadTier;
  geometry: BufferGeometry;
}

/**
 * The surface of one junction: its carriageway, paved as the widest road that
 * meets there. Every vertex stands on the surface `junction-shape.ts` gives it:
 * along each mouth that is the road's own banked section, so the two meet
 * without a seam, and everywhere else the junction's plane, which is the ground
 * the carve levels under it.
 */
export function junctionSurfaces(junction: Junction, ribbons: RoadRibbons, heightAt: HeightAt): JunctionSurface[] {
  const shape = junctionShape(junction, ribbons);
  if (shape.carriageway.length === 0) return [];
  const lift = (v: JunctionVertex): Vector3 => new Vector3(v.x, (v.bed ?? heightAt(v.x, v.y)) + SURFACE_RAISE, v.y);

  // The carriageway is fanned from the node, which stands on the plane as the
  // corners do: the beds of the roads meet at the node, so a surface
  // stretched straight from one mouth to another would cut under a junction on
  // a ridge, and the ground would show through it.
  const centre = new Vector3(junction.x, (shape.centre ?? heightAt(junction.x, junction.y)) + SURFACE_RAISE, junction.y);
  const paved = flatSurface(shape.carriageway.map(lift), 0, centre);
  return paved === undefined ? [] : [{ tier: junction.tier, geometry: paved }];
}
