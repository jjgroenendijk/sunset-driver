/**
 * The material the plants are drawn with (spec sections 10.2, 10.4).
 *
 * One material dresses every species: the models carry the colour of their own
 * leaf or bark in a `tint` attribute, and a `part` attribute says which of the
 * two a vertex belongs to. So a chunk of woodland is one batch and one material
 * however many species stand in it.
 *
 * The build ships no image files, so the mottling of a canopy and the grain of a
 * trunk are fractal noise, as the ground's and the buildings' are. The noise is
 * taken in world places, which is what stops a stand of one model from reading
 * as the same tree stamped over and over.
 *
 * Only this file, the other `*-material.ts` files and `tsl.ts` know about shader
 * nodes.
 */
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { PLANT_LEAF } from './plant-mesh.ts';
import { attribute, float, fractalNoise, mix, positionWorld, step, vec3, type TslNode } from './tsl.ts';

/** Metres of one period of the mottling of a canopy, and of the patches over it. */
const LEAF_METRES = 0.9;
const STAND_METRES = 40;

/** How far the mottling and the patches move a leaf colour. */
const LEAF_SPREAD = 0.3;
const STAND_SPREAD = 0.22;

/** Metres of one period of the grain of bark, which runs up a trunk rather than round it. */
const BARK_METRES = 0.35;

/** The material every plant of a world is drawn with. */
export function createPlantMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ metalness: 0 });

  const tint = attribute('tint', 'vec3');
  const leaf = step(PLANT_LEAF - 0.5, attribute('part', 'float'));

  // A canopy is mottled close up and drifts in colour from one stand of trees
  // to the next, so a wood is not one flat green.
  const close = positionWorld.div(LEAF_METRES);
  const mottle = noise01(vec3(close.x, close.y, close.z), 3);
  const stand = noise01(vec3(positionWorld.x.div(STAND_METRES), positionWorld.z.div(STAND_METRES), 0), 2);
  const foliage = tint.mul(
    float(1 - LEAF_SPREAD / 2 - STAND_SPREAD / 2)
      .add(mottle.mul(LEAF_SPREAD))
      .add(stand.mul(STAND_SPREAD)),
  );

  // Bark: a grain that runs up the trunk, so the rings of a tube read as wood.
  const grain = noise01(
    vec3(positionWorld.x.div(BARK_METRES), positionWorld.y.div(BARK_METRES * 4), positionWorld.z.div(BARK_METRES)),
    2,
  );
  const bark = tint.mul(float(0.8).add(grain.mul(0.4)));

  material.colorNode = mix(bark, foliage, leaf);
  material.roughnessNode = mix(float(0.94), float(0.82).sub(mottle.mul(0.1)), leaf);
  return material;
}

/** Fractal noise at a place, in 0..1. */
function noise01(place: TslNode, octaves: number): TslNode {
  return fractalNoise(place, octaves).mul(0.5).add(0.5);
}
