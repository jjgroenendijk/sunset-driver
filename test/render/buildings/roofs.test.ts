/** A building between the camera and the player (spec section 10.7): the roof boxes the chunks carry. */
import { BoxGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { roofOver, ROOF_STRIDE, writeRoof } from '../../../src/render/buildings/roofs.ts';

/** The packed box of a building `width` by `depth` by `height`, turned `angle` about the up axis. */
function roofOf(x: number, z: number, width: number, depth: number, height: number, angle = 0): Float32Array {
  // A shell stands on its own origin, as `building-mesh.ts` builds it.
  const shell = new BoxGeometry(width, height, depth).translate(0, height / 2, 0);
  const matrix = new Matrix4().compose(
    new Vector3(x, 0, z),
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle),
    new Vector3(1, 1, 1),
  );
  const out = new Float32Array(ROOF_STRIDE);
  writeRoof(out, 0, shell, matrix);
  return out;
}

describe('roof boxes', () => {
  it('find the tallest building over a point, and nothing over open ground', () => {
    const low = roofOf(0, 0, 20, 20, 10);
    const tall = roofOf(5, 0, 6, 6, 90);
    expect(roofOver([low, tall], 5, 0)?.top).toBeCloseTo(90, 4);
    expect(roofOver([low, tall], -8, 0)?.top).toBeCloseTo(10, 4);
    expect(roofOver([low, tall], 30, 0)).toBeUndefined();
    // The margin grows every footprint.
    expect(roofOver([low], 11, 0)).toBeUndefined();
    expect(roofOver([low], 11, 0, 1.5)?.top).toBeCloseTo(10, 4);
  });

  it('follow the turn of the lot', () => {
    // A long thin building turned a quarter lies along z rather than x.
    const turned = roofOf(0, 0, 40, 4, 20, Math.PI / 2);
    expect(roofOver([turned], 0, 15)).toBeDefined();
    expect(roofOver([turned], 15, 0)).toBeUndefined();
  });
});
