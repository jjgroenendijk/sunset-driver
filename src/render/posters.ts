/**
 * The harm-reduction posters of a world, in the scene (spec section 19).
 *
 * Every poster of a chunk goes into one batch per cell (`batch.ts`), so a cell
 * full of them costs one draw call, and the boards of a whole city share the
 * one material and the one generated texture of `poster-material.ts`.
 *
 * Where the boards hang is `poster-mesh.ts`, and what they say is
 * `poster-art.ts`. Nothing here decides either: this puts them in the scene and
 * takes them out again.
 */
import { fillsOf, tilePartOf } from './batch.ts';
import type { CellGrid } from './cells.ts';
import type { EntityFade } from './fade.ts';
import { createPosterMaterials, type PosterMaterials } from './poster-material.ts';
import { posterParts, type Poster } from './poster-mesh.ts';
import type { TilePart } from './streaming.ts';

/** The boards of a world's posters: one material, and a batch for each cell of a chunk. */
export class PosterScenery {
  private readonly materials: PosterMaterials = createPosterMaterials();

  /**
   * The material is dressed with the world's fade, so a board near the draw
   * distance dithers away rather than popping (spec section 9.2).
   */
  constructor(fade: EntityFade) {
    fade.dress(this.materials.poster);
  }

  /**
   * Put one chunk's posters into the scene. They come from the worker that
   * built the chunk (spec section 9.1), already in the places the scene works
   * in; the quads are grown here, one per board.
   */
  build(grid: CellGrid, posters: readonly Poster[]): TilePart {
    return tilePartOf(fillsOf(grid, posterParts(posters), this.materials.poster));
  }

  /** Release the material and the texture every chunk shared. */
  dispose(): void {
    this.materials.dispose();
  }
}
