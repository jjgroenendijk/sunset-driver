/**
 * Where the buildings of a chunk stand, as boxes (spec section 10.7).
 *
 * The camera stands about 30 m over the street and a tower stands up to 150 m,
 * so in the core the camera is often inside a building. The camera and the
 * cutaway of `cutaway.ts` both need to know which building that is. The meshes
 * cannot tell them: a chunk's buildings are merged into a few batches. So the
 * worker writes one box per building beside the batches, and the frame reads
 * the boxes.
 *
 * A box is the building's outline hull, turned with the lot. It is eight
 * numbers: the middle on the ground, the lot's own x axis, the half width
 * along that axis and across it, and the bottom and the top. A lot on a bend
 * leans its side edges; the box is drawn around the leaned hull, so it covers
 * the lean rather than follows it.
 */
import { Box3, Vector3, type BufferAttribute, type BufferGeometry, type Matrix4 } from 'three';

/** Numbers one box takes in a packed array. */
export const ROOF_STRIDE = 8;

/** One building's box, read out of a packed array. */
export interface RoofBox {
  /** The middle of the box on the ground. */
  x: number;
  z: number;
  /** The lot's own x axis on the ground, a unit vector. */
  ux: number;
  uz: number;
  /** Half the box along that axis, and across it. */
  halfAlong: number;
  halfAcross: number;
  /** World heights of the bottom and the top. */
  bottom: number;
  top: number;
}

const box = new Box3();
const middle = new Vector3();
const size = new Vector3();

/**
 * Write the box of one building into `out` at `at`. `hull` is in the
 * building's own frame and `matrix` puts it in the world, as
 * `building-mesh.ts` builds both. The frame is a turn about the up axis and a
 * scale, so its first column is the lot's x axis times the scale along it.
 */
export function writeRoof(out: Float32Array, at: number, hull: BufferGeometry, matrix: Matrix4): void {
  box.setFromBufferAttribute(hull.getAttribute('position') as BufferAttribute);
  box.getCenter(middle);
  box.getSize(size);
  const e = matrix.elements;
  const along = Math.hypot(e[0] as number, e[2] as number) || 1;
  const across = Math.hypot(e[8] as number, e[10] as number) || 1;
  const up = Math.hypot(e[4] as number, e[5] as number, e[6] as number) || 1;
  middle.applyMatrix4(matrix);
  out[at] = middle.x;
  out[at + 1] = middle.z;
  out[at + 2] = (e[0] as number) / along;
  out[at + 3] = (e[2] as number) / along;
  out[at + 4] = (size.x / 2) * along;
  out[at + 5] = (size.z / 2) * across;
  out[at + 6] = middle.y - (size.y / 2) * up;
  out[at + 7] = middle.y + (size.y / 2) * up;
}

/** The box at index `i` of a packed array. */
export function roofAt(roofs: Float32Array, i: number): RoofBox {
  const at = i * ROOF_STRIDE;
  return {
    x: roofs[at] as number,
    z: roofs[at + 1] as number,
    ux: roofs[at + 2] as number,
    uz: roofs[at + 3] as number,
    halfAlong: roofs[at + 4] as number,
    halfAcross: roofs[at + 5] as number,
    bottom: roofs[at + 6] as number,
    top: roofs[at + 7] as number,
  };
}

/**
 * The tallest building whose footprint holds the ground point `(x, z)`, grown
 * by `margin` metres on every side, or undefined over open ground. Each array
 * is the packed boxes of one chunk.
 */
export function roofOver(chunks: readonly Float32Array[], x: number, z: number, margin = 0): RoofBox | undefined {
  let best: RoofBox | undefined;
  for (const roofs of chunks) {
    const count = roofs.length / ROOF_STRIDE;
    for (let i = 0; i < count; i++) {
      const at = i * ROOF_STRIDE;
      const top = roofs[at + 7] as number;
      if (best !== undefined && top <= best.top) continue;
      const dx = x - (roofs[at] as number);
      const dz = z - (roofs[at + 1] as number);
      const ux = roofs[at + 2] as number;
      const uz = roofs[at + 3] as number;
      // The lot's z axis on the ground is its x axis turned a quarter.
      const along = dx * ux + dz * uz;
      const acrossAt = dz * ux - dx * uz;
      if (Math.abs(along) > (roofs[at + 4] as number) + margin) continue;
      if (Math.abs(acrossAt) > (roofs[at + 5] as number) + margin) continue;
      best = roofAt(roofs, i);
    }
  }
  return best;
}
