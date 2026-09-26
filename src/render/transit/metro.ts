/**
 * The metro entrances of a world, drawn (spec section 13.3).
 *
 * `metro-mesh.ts` is the stairwell and where it stands; this is the one
 * material a world's entrances share and the batch a chunk puts them in. There
 * are a dozen or so stations in a city, so a chunk's entrances go into one
 * batch for the whole chunk rather than one per cell (`cells.ts`): cutting a single
 * small object into quarters buys no culling and costs a draw call.
 *
 * The sign on the mast is the one surface that lights up (`metro-material.ts`),
 * off the same switch the street lamps and the vehicle lamps read, so the city
 * lights together at dusk. Its colour is the roundel the map draws the station
 * with, which is how a player reads the two as one thing.
 */
import type { ChunkBounds } from '../../world/chunks.ts';
import { fillsOf, tilePartOf, type BatchPart } from '../streaming/batch.ts';
import type { EntityFade } from '../camera/fade.ts';
import { createMetroMaterials, type MetroMaterials } from './metro-material.ts';
import { metroStairGeometry, stairPlace, type MetroStair } from './metro-mesh.ts';
import type { TilePart } from '../streaming/streaming.ts';

/** The entrances of a world: one material, and the switch every chunk shares. */
export class MetroScenery {
  private readonly materials: MetroMaterials = createMetroMaterials();

  /**
   * The material is dressed with the world's fade, so an entrance near the
   * draw distance dithers away rather than popping (spec section 9.2).
   */
  constructor(fade: EntityFade) {
    fade.dress(this.materials.entrance);
  }

  /**
   * Put one chunk's entrances into the scene. The places come from the worker
   * that built the chunk (spec section 9.1); the stairwell is grown here, one
   * copy for the chunk however many stations stand in it.
   */
  build(bounds: ChunkBounds, stairs: readonly MetroStair[]): TilePart {
    const geometry = metroStairGeometry();
    const parts: BatchPart[] = stairs.map((stair) => ({ geometry, matrix: stairPlace(stair) }));
    // A lit sign is a bright point in the water at night, and a stairwell is a
    // few hundred triangles, so the entrances are drawn in the mirror too.
    return tilePartOf(fillsOf({ bounds, perSide: 1 }, parts, this.materials.entrance), { mirrored: true });
  }

  /** How far on the sign is, 0 by day and 1 after dark. */
  set lamps(amount: number) {
    this.materials.lamps.value = amount;
  }

  get lamps(): number {
    return this.materials.lamps.value;
  }

  /** Release the material every chunk shared. */
  dispose(): void {
    this.materials.dispose();
  }
}
