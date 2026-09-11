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
import type { WorldChunk } from '../world/chunks.ts';
import { batchOf, type BatchPart } from './batch.ts';
import { buildChunkBuildings, type BuildingLookup } from './building-mesh.ts';
import { createBuildingMaterials, type BuildingMaterials } from './building-material.ts';

/** One chunk's buildings, as the scene holds them. */
export interface BuildingTile {
  /** What to add to the scene: the outlines, then the batches they rim. */
  objects: Object3D[];
  /** Draw calls these objects cost. */
  drawCalls: number;
  /** Release the geometry. The materials are the world's and are left alone. */
  dispose(): void;
}

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

  /** Build the buildings of one chunk. */
  build(chunk: WorldChunk, lookup: BuildingLookup): BuildingTile {
    const facades: BatchPart[] = [];
    const blocks: BatchPart[] = [];
    const hulls: BatchPart[] = [];
    for (const placed of buildChunkBuildings(chunk, lookup)) {
      const into = placed.batch === 'facade' ? facades : blocks;
      into.push({ geometry: placed.shell, matrix: placed.matrix });
      hulls.push({ geometry: placed.hull, matrix: placed.matrix });
    }
    const objects: Object3D[] = [];
    // The hulls first, because that is the order they are read in; which of the
    // two the renderer draws first does not matter, since a hull stands behind
    // the building that covers it and the depth test is what leaves the rim.
    if (hulls.length > 0) objects.push(batchOf(hulls, this.materials.outline));
    if (facades.length > 0) objects.push(batchOf(facades, this.materials.facade));
    if (blocks.length > 0) objects.push(batchOf(blocks, this.materials.block));
    return {
      objects,
      drawCalls: objects.length,
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
