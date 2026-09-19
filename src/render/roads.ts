/**
 * The roads of one chunk, as meshes (spec sections 9.2, 10.2).
 *
 * Everything a chunk draws for one tier goes into one batch per cell
 * (`batch.ts`) — every run of road, every bridge deck and every tunnel portal —
 * and everything painted on that tier goes into one flat mesh. So a chunk
 * costs a draw call per cell and one for the paint for each tier that runs
 * through it, and nothing for a tier that does not, which is what keeps the
 * visible city inside the budget of spec section 9.2.
 *
 * The materials belong to the world, not to the chunk: they are built once and
 * every chunk of that world shares them, so dropping a chunk frees its geometry
 * and nothing else.
 */
import { BufferAttribute, BufferGeometry, Mesh, Object3D } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { RoadTier } from '../world/types.ts';
import { Batch, fillOfPacked } from './batch.ts';
import type { PackedRoads } from './chunk-payload.ts';
import { createMarkingMaterial, createRoadMaterial } from './road-material.ts';
import { TIER_ORDER } from './road-mesh.ts';
import type { TilePart } from './streaming.ts';

/**
 * The materials a world's roads are drawn with, and the chunks built from them.
 * One instance serves a whole world.
 */
export class RoadScenery {
  private readonly surfaces: Partial<Record<RoadTier, MeshStandardNodeMaterial>> = {};
  private readonly paint: MeshStandardNodeMaterial = createMarkingMaterial();

  constructor() {
    for (const tier of TIER_ORDER) this.surfaces[tier] = createRoadMaterial(tier);
  }

  /** Put one tier of one chunk's roads into the scene. */
  build(tier: PackedRoads): TilePart {
    const objects: Object3D[] = [];
    const geometries: BufferGeometry[] = [];
    const steps: (() => void)[] = [];
    const shadowless: Object3D[] = [];
    const surface = this.surfaces[tier.tier] as MeshStandardNodeMaterial;
    for (const cell of tier.surface) {
      const fill = fillOfPacked(cell, surface);
      objects.push(fill.mesh);
      steps.push(...fill.steps);
      // A cell of paving on the ground could shade only itself, and the
      // shadow pass would draw it for nothing. A deck, a portal or a pier in
      // the cell makes it cast.
      if (cell.raised !== true) shadowless.push(fill.mesh);
    }
    if (tier.markings.length > 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(tier.markings, 3));
      geometry.setAttribute('normal', new BufferAttribute(tier.markingNormals, 3));
      geometry.setAttribute('color', new BufferAttribute(tier.markingTints, 3));
      geometries.push(geometry);
      // Paint lies flat on the road: it takes the shadow falling on the road
      // and casts none of its own.
      const paint = new Mesh(geometry, this.paint);
      paint.receiveShadow = true;
      objects.push(paint);
    }
    return {
      objects,
      drawCalls: objects.length,
      steps,
      shadowless,
      dispose(): void {
        for (const object of objects) if (object instanceof Batch) object.dispose();
        for (const geometry of geometries) geometry.dispose();
      },
    };
  }

  /** Release the materials every chunk shared. */
  dispose(): void {
    for (const tier of TIER_ORDER) this.surfaces[tier]?.dispose();
    this.paint.dispose();
  }
}

