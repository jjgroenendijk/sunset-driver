/**
 * What a frame holds: the buildings, street lamps and posters inside the
 * camera's view. `render-preview.ts` prints the counts, because a thing missing
 * from a picture looks exactly like a thing that was never built, and a count
 * of zero tells the two apart without a picture.
 */
import { Box3, Frustum, Matrix4, Vector3, type Camera } from 'three';
import type { Lamp } from './lamp-mesh.ts';
import type { Poster } from './poster-mesh.ts';
import { ROOF_STRIDE, roofAt } from './roofs.ts';

/** What one chunk in the scene holds, as `ChunkTiles.contents` answers it. */
export interface ChunkContents {
  roofs: Float32Array;
  lamps: readonly Lamp[];
  posters: readonly Poster[];
}

/** How many of each the frame holds. */
export interface FrameContents {
  buildings: number;
  lamps: number;
  posters: number;
}

/**
 * Count what of `chunks` stands inside the view of `camera`. A building counts
 * when any of its box is in view, so one cut by the edge of the picture counts.
 * A lamp counts by its lantern and a poster by the middle of its board.
 */
export function frameContents(camera: Camera, chunks: readonly ChunkContents[]): FrameContents {
  camera.updateMatrixWorld();
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const box = new Box3();
  const point = new Vector3();
  const counts: FrameContents = { buildings: 0, lamps: 0, posters: 0 };
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.roofs.length / ROOF_STRIDE; i++) {
      const roof = roofAt(chunk.roofs, i);
      // The box turns with its lot; the square round it is close enough to count by.
      const reach = Math.abs(roof.ux) * roof.halfAlong + Math.abs(roof.uz) * roof.halfAcross;
      const deep = Math.abs(roof.uz) * roof.halfAlong + Math.abs(roof.ux) * roof.halfAcross;
      box.min.set(roof.x - reach, roof.bottom, roof.z - deep);
      box.max.set(roof.x + reach, roof.top, roof.z + deep);
      if (frustum.intersectsBox(box)) counts.buildings++;
    }
    for (const lamp of chunk.lamps) {
      if (frustum.containsPoint(point.set(lamp.headX, lamp.headHeight, lamp.headY))) counts.lamps++;
    }
    for (const poster of chunk.posters) {
      if (frustum.containsPoint(point.set(poster.x, poster.height, poster.y))) counts.posters++;
    }
  }
  return counts;
}
