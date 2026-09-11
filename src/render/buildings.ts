/**
 * The buildings of one chunk, as meshes (spec sections 9.2, 10.1, 10.3).
 *
 * A chunk draws its buildings in three batches and no more: the generated
 * facades, the blocks, and the inverted hulls that outline both of them. So a
 * chunk of houses costs two draw calls and a chunk of the core costs three,
 * whether it holds five buildings or fifty, which is what keeps the visible city
 * inside the budget of spec section 9.2.
 *
 * The outlines are drawn as one batch of their own rather than as a shell behind
 * each building, because a hull needs the opposite face and so the opposite
 * material. Drawing them first, back faces only, leaves the rim of each hull
 * standing outside the building that covers the rest of it.
 *
 * The materials belong to the world, not to the chunk: they are built once and
 * every chunk of that world shares them, so dropping a chunk frees its geometry
 * and nothing else.
 */
import { BatchedMesh, Object3D } from 'three';
import { fillOfPacked } from './batch.ts';
import type { PackedPart } from './chunk-payload.ts';
import { createBuildingMaterials, type BuildingMaterials } from './building-material.ts';
import type { TilePart } from './streaming.ts';

/** Which of a chunk's three batches of buildings is meant. */
export type BuildingBatchKind = 'outline' | 'facade' | 'block';

/**
 * The materials a world's buildings are drawn with, and the chunks built from
 * them. One instance serves a whole world.
 */
export class BuildingScenery {
  private readonly materials: BuildingMaterials = createBuildingMaterials();

  /** How far into the night it is, 0 by day and 1 at midnight (spec section 10.5). */
  get night(): number {
    return this.materials.night.value;
  }

  set night(amount: number) {
    this.materials.night.value = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  }

  /**
   * Put one batch of one chunk's buildings into the scene. The three are
   * uploaded one at a time, so a chunk of the core spreads over more frames
   * than a chunk of houses rather than stalling one of them.
   *
   * A chunk's outlines are read first, because that is the order they are
   * listed in; which of the batches the renderer draws first does not matter,
   * since a hull stands behind the building that covers it and the depth test
   * is what leaves the rim.
   */
  build(batch: BuildingBatchKind, parts: readonly PackedPart[]): TilePart {
    const fill = fillOfPacked(parts, this.materials[batch]);
    const objects: Object3D[] = [fill.mesh];
    return {
      objects,
      drawCalls: 1,
      steps: fill.steps,
      dispose(): void {
        for (const object of objects) if (object instanceof BatchedMesh) object.dispose();
      },
    };
  }

  /** Release the materials every chunk shared. */
  dispose(): void {
    this.materials.dispose();
  }
}
