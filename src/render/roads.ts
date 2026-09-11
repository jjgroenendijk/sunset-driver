/**
 * The roads of one chunk, as meshes (spec sections 9.2, 10.2).
 *
 * Everything a chunk draws for one tier goes into one `BatchedMesh` — every run
 * of road, every bridge deck and every tunnel portal — and everything painted on
 * that tier goes into one `LineSegments2`. So a chunk costs two draw calls per
 * tier that runs through it and nothing for a tier that does not, which is what
 * keeps the visible city inside the budget of spec section 9.2.
 *
 * The materials belong to the world, not to the chunk: they are built once and
 * every chunk of that world shares them, so dropping a chunk frees its geometry
 * and nothing else.
 */
import { BatchedMesh, Object3D, type BufferGeometry } from 'three';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/examples/jsm/lines/webgpu/LineSegments2.js';
import type { Line2NodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import type { RoadTier } from '../world/types.ts';
import { fillOfPacked } from './batch.ts';
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
  private readonly paint: Line2NodeMaterial = createMarkingMaterial();

  constructor() {
    for (const tier of TIER_ORDER) this.surfaces[tier] = createRoadMaterial(tier);
  }

  /** Put one tier of one chunk's roads into the scene. */
  build(tier: PackedRoads): TilePart {
    const objects: Object3D[] = [];
    const geometries: BufferGeometry[] = [];
    const steps: (() => void)[] = [];
    const surface = this.surfaces[tier.tier] as MeshStandardNodeMaterial;
    if (tier.surface.parts.length > 0) {
      const fill = fillOfPacked(tier.surface, surface);
      objects.push(fill.mesh);
      steps.push(...fill.steps);
    }
    if (tier.markings.length > 0) {
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(tier.markings);
      geometry.setColors(tier.markingTints);
      geometries.push(geometry);
      objects.push(new LineSegments2(geometry, this.paint));
    }
    return {
      objects,
      drawCalls: objects.length,
      steps,
      dispose(): void {
        for (const object of objects) if (object instanceof BatchedMesh) object.dispose();
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

