/**
 * The pool of `src/render/look/pool.ts`: an `InstancedMesh`'s API over a plain
 * mesh whose instances are geometry attributes.
 *
 * Pinned here is what keeps the shader shared: the mesh three.js draws keeps
 * `count` at 1, so no `uuid` enters the key of its program, and the number of
 * instances lives on the geometry. The rest is that a matrix and a tint land
 * where the vertex stage reads them.
 */
import { BoxGeometry, Color, Matrix4, Mesh, type InstancedBufferGeometry } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { Pool } from '../../../src/render/look/pool.ts';

function drawnOf(pool: Pool): Mesh {
  const mesh = pool.children[0];
  if (!(mesh instanceof Mesh)) throw new Error('a pool draws one mesh');
  return mesh;
}

describe('Pool', () => {
  it('counts its instances on the geometry and keeps the mesh at one', () => {
    const pool = new Pool(new BoxGeometry(), new MeshStandardNodeMaterial(), 8, true);
    const mesh = drawnOf(pool);
    expect(pool.count).toBe(0);
    pool.count = 5;
    expect((mesh.geometry as InstancedBufferGeometry).instanceCount).toBe(5);
    expect(mesh.count).toBe(1);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.frustumCulled).toBe(false);
  });

  it('writes each matrix and tint into the one buffer the rows and the tint read', () => {
    const pool = new Pool(new BoxGeometry(), new MeshStandardNodeMaterial(), 4, false);
    const geometry = drawnOf(pool).geometry;
    pool.setMatrixAt(2, new Matrix4().makeTranslation(7, 8, 9));
    pool.setColorAt(2, new Color(0.25, 0.5, 0.75));
    const row = geometry.getAttribute('poolRow3');
    expect([row.getX(2), row.getY(2), row.getZ(2), row.getW(2)]).toEqual([7, 8, 9, 1]);
    const tint = geometry.getAttribute('poolTint');
    expect([tint.getX(2), tint.getY(2), tint.getZ(2)]).toEqual([0.25, 0.5, 0.75]);
    expect([tint.getX(1), tint.getY(1), tint.getZ(1)]).toEqual([1, 1, 1]);
    expect(pool.instanceMatrix.count).toBe(4);
  });

  it('keeps the geometry the view made, and sets the pool nodes on a material once', () => {
    const material = new MeshStandardNodeMaterial();
    const box = new BoxGeometry();
    const first = new Pool(box, material, 2, false);
    const position = material.positionNode;
    const second = new Pool(new BoxGeometry(), material, 2, false);
    expect(second.material).toBe(material);
    expect(first.geometry).toBe(box);
    expect(drawnOf(first).geometry.getAttribute('position')).toBe(box.getAttribute('position'));
    expect(position).not.toBeNull();
    expect(material.positionNode).toBe(position);
  });
});
