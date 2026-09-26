/**
 * The material the ground is drawn with (spec sections 10.1, 10.2).
 *
 * The build ships no image files, so every surface detail is generated in the
 * shader: two bands of fractal noise, one broad and one fine, stand in for the
 * grain of soil, grass and rock. The vertex attributes `ground.ts` writes carry
 * the rest — the colour of the zone the ground stands in, and the ground cover
 * of the parcel it belongs to.
 *
 * Only this file and `tsl.ts` know about shader nodes.
 */
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  attribute,
  float,
  fractalNoise,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
  vec3,
  type TslNode,
} from '../tsl.ts';

/** Metres of one period of the fine grain, and of the broad patches over it. */
const GRAIN_METRES = 3.5;
const PATCH_METRES = 70;

/** Bare rock, which every slope too steep to hold soil shows. */
const ROCK_DARK = vec3(0.24, 0.22, 0.21);
const ROCK_LIGHT = vec3(0.42, 0.4, 0.38);

/** The bed of the sea and the straits, under whatever water rendering lands on top. */
const SEABED = vec3(0.05, 0.11, 0.13);

/** Metres below the waterline over which the ground darkens into the seabed. */
const SHALLOWS = 5;

/**
 * The ground material, shared by every chunk of a world. `seaLevel` comes from
 * the world description, so a shore reads the same wherever it is.
 */
export function createGroundMaterial(seaLevel: number): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ metalness: 0 });

  const tint = attribute('tint', 'vec3');
  const cover = attribute('cover', 'float');
  const coverTint = attribute('coverTint', 'vec3');

  const grain = noise01(GRAIN_METRES, 3);
  const patch = noise01(PATCH_METRES, 3);

  // A slope steep enough sheds its soil, so the zone's ground gives way to rock.
  const level = smoothstep(0.6, 0.9, normalWorld.y);
  const rock = mix(ROCK_DARK, ROCK_LIGHT, grain);
  const soil = tint.mul(float(0.76).add(patch.mul(0.34)).add(grain.mul(0.18)));
  const bare = mix(rock, soil, level);

  // Ground cover, only where a parcel carries it (spec section 7.1). The broad
  // noise thins it in patches so a park does not read as flat paint.
  const covered = coverTint.mul(float(0.82).add(grain.mul(0.36)));
  const amount = cover.mul(level).mul(float(0.62).add(patch.mul(0.38)));
  const dry = mix(bare, covered, amount);

  const depth = float(seaLevel).sub(positionWorld.y);
  const wet = smoothstep(-0.4, 0.5, depth);
  const drowned = smoothstep(0.5, SHALLOWS, depth);
  const shore = mix(dry, dry.mul(0.55), wet);

  material.colorNode = mix(shore, SEABED, drowned);
  // Wet ground is smoother than dry; fine grain varies the rest.
  material.roughnessNode = mix(float(0.96), float(0.72), grain).mul(float(1).sub(wet.mul(0.4)));
  return material;
}

/**
 * Fractal noise over the ground plane, in 0..1. The place is the world one, so
 * the pattern is continuous across a chunk boundary and does not move with the
 * mesh it is drawn on.
 */
function noise01(metres: number, octaves: number): TslNode {
  const place = vec3(positionWorld.x.div(metres), positionWorld.z.div(metres), 0);
  return fractalNoise(place, octaves).mul(0.5).add(0.5);
}
