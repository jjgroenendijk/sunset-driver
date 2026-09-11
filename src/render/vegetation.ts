/**
 * The plants of one chunk, as meshes (spec sections 9.2, 10.4).
 *
 * A chunk draws its plants in one batch and no more. Every species shares one
 * material, and a batch holds one copy of each model however many plants stand
 * on it, so a chunk of forest costs the same draw call as a street with three
 * trees on it.
 *
 * The models and the material belong to the world, not to the chunk: they are
 * built once and every chunk of that world copies from them, so dropping a chunk
 * frees its batch and nothing else.
 */
import { BatchedMesh, Matrix4, Object3D, type BufferGeometry } from 'three';
import { fillOf, type BatchPart } from './batch.ts';
import type { PackedPlants } from './chunk-payload.ts';
import type { EntityFade } from './fade.ts';
import { createPlantMaterial } from './plant-material.ts';
import { buildPlantModels } from './plant-mesh.ts';
import { keptAt } from './quality.ts';
import type { TilePart } from './streaming.ts';

/**
 * The models a world's plants are built from and the material they are drawn
 * with. One instance serves a whole world.
 */
export class PlantScenery {
  private readonly material = createPlantMaterial();
  private readonly models = buildPlantModels();

  /**
   * The material is dressed with the world's fade, so a plant near the draw
   * distance dithers away rather than popping (spec section 9.2).
   */
  constructor(fade: EntityFade) {
    fade.dress(this.material);
  }

  /**
   * Put one chunk's plants into the scene. A placement names one of the
   * world's models rather than carrying geometry, so a chunk of forest crosses
   * the worker boundary as a matrix per tree.
   *
   * `limit` is what the quality tier allows the chunk (spec section 9.2). The
   * plants kept are spread over the whole chunk rather than taken off the
   * front, so a thinned wood is a thinner wood and not half a wood.
   */
  build(plants: PackedPlants, limit = plants.models.length): TilePart {
    const parts: BatchPart[] = [];
    // One copy of a model serves every plant that takes it: the batch adds the
    // geometry once and stands an instance on it for each placement.
    const copies = new Map<number, BufferGeometry>();
    const count = plants.models.length;
    const kept = Math.min(count, limit);
    for (let k = 0; k < kept; k++) {
      const i = keptAt(k, count, kept);
      const model = plants.models[i] as number;
      let geometry = copies.get(model);
      if (geometry === undefined) {
        geometry = (this.models[model] as BufferGeometry).clone();
        copies.set(model, geometry);
      }
      parts.push({ geometry, matrix: new Matrix4().fromArray(plants.matrices, i * 16) });
    }
    const fill = fillOf(parts, this.material);
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

  /** Release the models and the material every chunk shared. */
  dispose(): void {
    for (const model of this.models) model.dispose();
    this.material.dispose();
  }
}
