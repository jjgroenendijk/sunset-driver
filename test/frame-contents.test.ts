/**
 * What a preview frame holds (`frame-contents.ts`): a thing inside the camera's
 * view counts, and one behind it or off to the side does not.
 */
import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { frameContents } from '../src/render/frame-contents.ts';
import type { Lamp } from '../src/render/lamp-mesh.ts';
import type { Poster } from '../src/render/poster-mesh.ts';
import { ROOF_STRIDE } from '../src/render/roofs.ts';

/** Packed boxes 10 m square and 20 m tall, one at each place on the ground. */
function roofs(...at: [number, number][]): Float32Array {
  const out = new Float32Array(at.length * ROOF_STRIDE);
  at.forEach(([x, z], i) => out.set([x, z, 1, 0, 5, 5, 0, 20], i * ROOF_STRIDE));
  return out;
}

const lamp = (x: number, y: number): Lamp => ({ headX: x, headY: y, headHeight: 6 }) as Lamp;
const poster = (x: number, y: number): Poster => ({ x, y, height: 2 }) as Poster;

describe('frameContents', () => {
  it('counts what stands in view and nothing behind the camera or beside the picture', () => {
    const camera = new PerspectiveCamera(45, 16 / 9, 1, 1000);
    camera.position.set(0, 60, 40);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    const holds = frameContents(camera, [
      { roofs: roofs([0, 0], [10, -10], [0, 200], [400, 0]), lamps: [lamp(0, 0), lamp(0, 300)], posters: [poster(5, 5)] },
      { roofs: roofs(), lamps: [], posters: [poster(-500, 0)] },
    ]);
    expect(holds).toEqual({ buildings: 2, lamps: 1, posters: 1 });
  });
});
