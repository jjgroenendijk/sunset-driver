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
import { BatchedMesh, Object3D, type BufferGeometry } from 'three';
import type { WorldChunk } from '../world/chunks.ts';
import { batchOf, type BatchPart } from './batch.ts';
import { createPlantMaterial } from './plant-material.ts';
import { buildChunkVegetation, buildPlantModels, type PlantLookup } from './plant-mesh.ts';

/** One chunk's plants, as the scene holds them. */
export interface VegetationTile {
  /** What to add to the scene: the one batch, or nothing where nothing grows. */
  objects: Object3D[];
  /** Draw calls these objects cost. */
  drawCalls: number;
  /** Release the geometry. The models and the material are the world's. */
  dispose(): void;
}

/**
 * The models a world's plants are built from and the material they are drawn
 * with. One instance serves a whole world.
 */
export class PlantScenery {
  private readonly material = createPlantMaterial();
  private readonly models = buildPlantModels();

  /** Build the plants of one chunk. */
  build(chunk: WorldChunk, lookup: PlantLookup): VegetationTile {
    const parts: BatchPart[] = [];
    // One copy of a model serves every plant that takes it: the batch adds the
    // geometry once and stands an instance on it for each placement.
    const copies = new Map<number, BufferGeometry>();
    for (const placement of buildChunkVegetation(chunk, lookup)) {
      let geometry = copies.get(placement.model);
      if (geometry === undefined) {
        geometry = (this.models[placement.model] as BufferGeometry).clone();
        copies.set(placement.model, geometry);
      }
      parts.push({ geometry, matrix: placement.matrix });
    }
    const objects: Object3D[] = parts.length > 0 ? [batchOf(parts, this.material)] : [];
    return {
      objects,
      drawCalls: objects.length,
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
