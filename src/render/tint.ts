/**
 * Instance colours that exist from the start.
 *
 * `InstancedMesh.setColorAt` makes the `instanceColor` buffer on its first
 * call. three.js keys a program on the mesh, not on whether the mesh has that
 * buffer, so a program built before the first call never reads the colours.
 * The warm-up (`warm.ts`) draws every empty pool once behind the loading
 * screen, so a pool whose first instance comes later is drawn white for the
 * whole session. Every pool that colours its instances passes through here.
 */
import { InstancedBufferAttribute, type InstancedMesh } from 'three';

/** Give a pool white instance colours for its whole capacity, and return it. */
export function tinted(mesh: InstancedMesh): InstancedMesh {
  const cap = mesh.instanceMatrix.count;
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
  return mesh;
}
