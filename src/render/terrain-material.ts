/**
 * The ground's material (spec sections 10.1 and 10.2).
 *
 * The colour identity of every vertex is already on the geometry: the zone it
 * stands in, the cover the parcels carry, the sea bed under the water
 * (`terrain.ts`). What this adds is everything a shader can do without asking
 * the world, and it is all generated at runtime, because spec section 10.2
 * ships no binary assets:
 *
 * - grain, a few octaves of noise at the scale of a footstep, so a hillside is
 *   never a flat wash of one colour;
 * - patches, one octave at the scale of a field, which is what makes ground
 *   read as ground rather than as paint;
 * - roughness off the same patches, so the light catches the ground unevenly.
 *
 * One material serves every tile. It is a node material because
 * `ShaderMaterial` does nothing on `WebGPURenderer` (spec Appendix A), and all
 * of its maths goes through the loosely typed door in `tsl.ts`.
 */
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, float, fractalNoise, noise, positionWorld } from './tsl.ts';

/** Metres one period of the grain covers, and how much of the colour it moves. */
const GRAIN_METRES = 1.6;
const GRAIN_OCTAVES = 3;
const GRAIN_DEPTH = 0.16;
/** Metres one period of the patches covers, and how much of the colour they move. */
const PATCH_METRES = 34;
const PATCH_DEPTH = 0.13;
/** The ground is rough; the patches take a little off it where they are strongest. */
const ROUGHNESS = 0.94;
const ROUGHNESS_RANGE = 0.22;

/**
 * The material every terrain tile shares. It reads the `color` attribute
 * `buildTerrainTile` writes, so a tile carries its identity and the material
 * carries the detail.
 */
export function createTerrainMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  const identity = attribute('color', 'vec3');
  // World metres, not UVs: the noise then has the same scale on every tile and
  // does not repeat or stretch at a chunk boundary.
  const at = positionWorld.xz;
  const grain = fractalNoise(at.div(GRAIN_METRES), GRAIN_OCTAVES);
  const patch = noise(at.div(PATCH_METRES));

  material.colorNode = identity
    .mul(float(1).add(grain.mul(GRAIN_DEPTH)))
    .mul(float(1).add(patch.mul(PATCH_DEPTH)));
  material.roughnessNode = float(ROUGHNESS).sub(patch.abs().mul(ROUGHNESS_RANGE));
  material.metalnessNode = float(0);
  return material;
}
