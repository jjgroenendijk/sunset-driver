/**
 * The buildings of one chunk, as meshes (spec sections 9.2, 10.1, 10.3).
 *
 * A chunk draws its buildings in three kinds of batch and no more: the
 * generated facades, the blocks, and the inverted hulls that outline both of
 * them. Each kind is one batch per cell of the chunk (`cells.ts`). So a cell of
 * houses costs two draw calls and a cell of the core costs three, whether it
 * holds five buildings or fifty, which is what keeps the visible city inside
 * the budget of spec section 9.2.
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
import { fillOfPacked, tilePartOf } from './batch.ts';
import type { PackedBatch } from './chunk-payload.ts';
import { createBuildingMaterials, type BuildingMaterials } from './building-material.ts';
import type { BuildingCutaway } from './cutaway.ts';
import type { TilePart } from './streaming.ts';

/** Which of a chunk's three batches of buildings is meant. */
export type BuildingBatchKind = 'outline' | 'facade' | 'block';

/**
 * The materials a world's buildings are drawn with, and the chunks built from
 * them. One instance serves a whole world.
 */
export class BuildingScenery {
  private readonly materials: BuildingMaterials;

  constructor(cutaway: BuildingCutaway) {
    this.materials = createBuildingMaterials(cutaway);
  }

  /** How far into the night it is, 0 by day and 1 at midnight (spec section 10.5). */
  get night(): number {
    return this.materials.night.value;
  }

  set night(amount: number) {
    this.materials.night.value = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  }

  /**
   * Put one kind of one chunk's buildings into the scene, a batch per cell. The three are
   * uploaded one at a time, so a chunk of the core spreads over more frames
   * than a chunk of houses rather than stalling one of them.
   *
   * A chunk's outlines are read first, because that is the order they are
   * listed in; which of the batches the renderer draws first does not matter,
   * since a hull stands behind the building that covers it and the depth test
   * is what leaves the rim.
   *
   * The outlines cast no shadow. A hull's top cap stands `OUTLINE_WIDTH`
   * (0.35 m, `building-hull.ts`) over the roof it rims, so a shadow it cast
   * would land on that roof. Where the shadow bias does not cover 0.35 m the
   * roof comes out black. The building inside the hull already casts the
   * shadow the hull would, to within the width of the rim.
   *
   * The shells are drawn in the water's mirror (`mirror.ts`): a building is
   * what a grazing eye sees in the sea. The outlines are not. A hull is a rim
   * 0.35 m wide around a shell the mirror draws anyway, and the mirror is
   * rendered at a third of the size of the frame and read through moving water,
   * which is where a rim that wide disappears. They are a third of a chunk's
   * building batches and almost none of its triangles, so leaving them out of
   * the second pass is draw calls saved and nothing given up.
   */
  build(batch: BuildingBatchKind, cells: readonly PackedBatch[]): TilePart {
    const fills = cells.map((cell) => fillOfPacked(cell, this.materials[batch]));
    const shell = batch !== 'outline';
    return tilePartOf(fills, { castsShadow: shell, mirrored: shell });
  }

  /** Release the materials every chunk shared. */
  dispose(): void {
    this.materials.dispose();
  }
}
