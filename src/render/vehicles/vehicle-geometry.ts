/**
 * One part of a vehicle's model as a geometry (`vehicle-parts.ts`).
 *
 * A box is a `BoxGeometry`. A lofted part (`vehicle-hull.ts`) is its polygons,
 * each fanned into triangles from its first corner and shaded flat, which is
 * the faceted look of the low-poly bodies. Both come back about the part's own
 * middle, so a dent (`vehicle.ts`) reads each vertex against the same centre.
 */
import { BoxGeometry, BufferGeometry, Float32BufferAttribute } from 'three';
import type { VehicleBox } from './vehicle-parts.ts';

/** Twice the area under which a triangle is a fold of the loft and not a face. */
const SLIVER = 1e-8;

export function partGeometry(part: Omit<VehicleBox, 'panel'>): BufferGeometry {
  if (part.faces === undefined) return new BoxGeometry(part.length, part.height, part.width);
  const out: number[] = [];
  for (const face of part.faces) {
    for (let i = 3; i + 5 < face.length; i += 3) {
      const tri = [0, 1, 2, i, i + 1, i + 2, i + 3, i + 4, i + 5].map((k) => face[k] as number);
      if (area(tri) > SLIVER) out.push(...tri);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(out, 3));
  // A box carries texture coordinates, so a lofted part carries them too and
  // the two merge into one geometry (`traffic.ts`).
  geometry.setAttribute('uv', new Float32BufferAttribute(new Float32Array((out.length / 3) * 2), 2));
  geometry.computeVertexNormals();
  return geometry;
}

/** Twice the area of a triangle given as nine numbers. */
function area(t: number[]): number {
  const ux = (t[3] as number) - (t[0] as number);
  const uy = (t[4] as number) - (t[1] as number);
  const uz = (t[5] as number) - (t[2] as number);
  const vx = (t[6] as number) - (t[0] as number);
  const vy = (t[7] as number) - (t[1] as number);
  const vz = (t[8] as number) - (t[2] as number);
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}
