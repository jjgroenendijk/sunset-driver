/**
 * The ground a junction covers, as geometry (spec section 6.2).
 *
 * `junctions.ts` cuts every road back to where its kerbs leave its neighbours';
 * this draws what is left between the cuts: one carriageway polygon fanned from
 * the node, and a piece of pavement in each corner. The polygon's mouth
 * vertices are the very sections the lofts of `road-mesh.ts` end on, so the two
 * meet without a seam whichever chunk built each of them.
 */
import { Vector3, type BufferGeometry } from 'three';
import type { Junction, JunctionMouth } from '../world/junctions.ts';
import type { RoadRibbons } from '../world/ribbon.ts';
import { footprintHalfWidth, TIERS } from '../world/tiers.ts';
import type { Point, RoadTier } from '../world/types.ts';
import { flatSurface, place, SURFACE_RAISE, vergeRise } from './road-section.ts';

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
 * two roads beside it. The vertices along each mouth are the section the road's
 * own loft ends on, so the two meet without a seam; the corners stand on the
 * carved ground, which under a junction is the bench of the nearest road.
 */
export function junctionSurfaces(junction: Junction, ribbons: RoadRibbons, heightAt: HeightAt): JunctionSurface[] {
  const out: JunctionSurface[] = [];
  const mouths = junction.mouths.map((mouth) => mouthSection(mouth, ribbons));
  if (mouths.length < 2) return out;

  const carriageway: Vector3[] = [];
  for (let i = 0; i < mouths.length; i++) {
    const mouth = mouths[i] as MouthSection;
    const corner = junction.corners[i] as Junction['corners'][number];
    carriageway.push(mouth.rightKerb, mouth.leftKerb);
    for (const p of corner.kerb) carriageway.push(new Vector3(p.x, heightAt(p.x, p.y) + SURFACE_RAISE, p.y));
  }
  // The carriageway is fanned from the node, which stands on the carved ground
  // as the corners do: the beds of the roads meet at the node, so a surface
  // stretched straight from one mouth to another would cut under a junction on
  // a ridge, and the ground would show through it.
  const centre = new Vector3(junction.x, heightAt(junction.x, junction.y) + SURFACE_RAISE, junction.y);
  const paved = flatSurface(carriageway, 0, centre);
  if (paved !== undefined) out.push({ tier: junction.tier, geometry: paved });

  for (let i = 0; i < mouths.length; i++) {
    const a = mouths[i] as MouthSection;
    const b = mouths[(i + 1) % mouths.length] as MouthSection;
    const corner = junction.corners[i] as Junction['corners'][number];
    const rise = vergeRise(corner.tier);
    const ring: Vector3[] = [a.leftKerb];
    for (const p of corner.kerb) ring.push(new Vector3(p.x, heightAt(p.x, p.y) + SURFACE_RAISE, p.y));
    ring.push(b.rightKerb, b.rightOuter);
    for (let k = corner.outer.length - 1; k >= 0; k--) {
      const p = corner.outer[k] as Point;
      ring.push(new Vector3(p.x, heightAt(p.x, p.y) + rise, p.y));
    }
    ring.push(a.leftOuter);
    const pavement = flatSurface(ring, cornerAcross(corner.tier));
    if (pavement !== undefined) out.push({ tier: corner.tier, geometry: pavement });
  }
  return out;
}

/** The four corners of the section a road's loft ends on at its mouth. */
interface MouthSection {
  leftKerb: Vector3;
  rightKerb: Vector3;
  leftOuter: Vector3;
  rightOuter: Vector3;
}

/**
 * Where a mouth's loft ends. Left is anticlockwise round the node, which is the
 * curve's own left where the road leaves along its curve and its right where
 * it leaves against it.
 */
function mouthSection(mouth: JunctionMouth, ribbons: RoadRibbons): MouthSection {
  const frame = ribbons.frameAt(mouth.curve, mouth.segment, mouth.at.x, mouth.at.y);
  const spec = TIERS[mouth.tier];
  const kerb = spec.width / 2;
  const outer = footprintHalfWidth(mouth.tier);
  const top = vergeRise(mouth.tier);
  const side = mouth.direction;
  return {
    leftKerb: place(mouth.at, frame, side * kerb, SURFACE_RAISE),
    rightKerb: place(mouth.at, frame, -side * kerb, SURFACE_RAISE),
    leftOuter: place(mouth.at, frame, side * outer, top),
    rightOuter: place(mouth.at, frame, -side * outer, top),
  };
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
