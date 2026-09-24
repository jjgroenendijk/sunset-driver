/**
 * The buildings of one chunk, as meshes (spec sections 9.2, 10.1, 10.3).
 *
 * A chunk draws its buildings in two kinds of batch and no more: the
 * generated facades and the blocks. Each kind is one batch per cell of the
 * chunk (`cells.ts`). So a cell of houses costs one draw call and a cell of the
 * core costs two, whether it holds five buildings or fifty, which is what keeps
 * the visible city inside the budget of spec section 9.2. The ink lines around
 * them come from the screen-space edge pass of `edges.ts`, not from geometry.
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

/** Which of a chunk's two batches of buildings is meant. */
export type BuildingBatchKind = 'facade' | 'block';

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
    this.materials.night.value = held(amount);
  }

  /**
   * How deep into the night it is, 0 at dusk and 1 in the small hours. An
   * office empties as it rises and a shop stays lit (spec section 10.5).
   */
  get late(): number {
    return this.materials.late.value;
  }

  set late(amount: number) {
    this.materials.late.value = held(amount);
  }

  /** Where the aircraft beacons of the tallest towers are in their blink, 0 to 1. */
  get beacon(): number {
    return this.materials.beacon.value;
  }

  set beacon(phase: number) {
    this.materials.beacon.value = held(phase);
  }

  /**
   * Put one kind of one chunk's buildings into the scene, a batch per cell. The two are
   * uploaded one at a time, so a chunk of the core spreads over more frames
   * than a chunk of houses rather than stalling one of them.
   *
   * Both kinds cast a shadow, and both are drawn in the water's mirror
   * (`mirror.ts`): a building is what a grazing eye sees in the sea.
   */
  build(batch: BuildingBatchKind, cells: readonly PackedBatch[]): TilePart {
    const fills = cells.map((cell) => fillOfPacked(cell, this.materials[batch]));
    return tilePartOf(fills, { castsShadow: true, mirrored: true });
  }

  /** Release the materials every chunk shared. */
  dispose(): void {
    this.materials.dispose();
  }
}

/** A share held inside 0..1, whatever the caller hands over. */
function held(amount: number): number {
  return amount < 0 ? 0 : amount > 1 ? 1 : amount;
}
