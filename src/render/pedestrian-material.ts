/**
 * The material the crowd is drawn with (spec sections 9.2, 13.1): instanced
 * skinning in the vertex shader.
 *
 * Each instance carries four values in `pedPlace` — where it stands and which
 * way it faces — and three in `pedMotion`: the first row of its gait in the
 * baked texture of `pedestrian-rig.ts`, how far through the cycle it is, and
 * how tall it is against the rig. The shader reads the matrix of each vertex's
 * bone at the two frames either side of the cycle, blends the two places,
 * scales, turns and moves the body into the world. The mesh stands at the
 * origin, so its own matrix does nothing.
 *
 * The four colours of a person are instance attributes too, and a vertex's
 * `part` picks one. The fourth value of `pedMotion` is 1 on a patrol officer
 * (`uniform.ts`), whose shoulders are painted hi-vis: the faces of the top
 * that look up. Only this file, the other `*-material.ts` files and
 * `tsl.ts` know about shader nodes.
 */
import type { DataTexture } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { FRAMES, PART_HAIR, PART_LEGS, PART_SHOES, PART_TOP } from './pedestrian-rig.ts';
import {
  attribute,
  cos,
  float,
  floor,
  Fn,
  ivec2,
  mix,
  normalGeometry,
  normalLocal,
  positionGeometry,
  sin,
  step,
  textureLoad,
  vec3,
  type TslNode,
} from './tsl.ts';

/** The colour of every shoe: the camera sees little of it, and dark reads as a foot. */
const SHOE = vec3(0.03, 0.03, 0.035);

/** The hi-vis yellow on a patrol officer's shoulders. */
const HI_VIS = vec3(0.78, 0.9, 0.12);

/** The material every person of the crowd is drawn with, reading bones from the baked walks. */
export function createPedestrianMaterial(bones: DataTexture): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  const place = attribute('pedPlace', 'vec4');
  const motion = attribute('pedMotion', 'vec4');

  material.positionNode = Fn(() => {
    const bone = attribute('rig', 'vec2').x;
    const column = bone.mul(4);
    const frames = motion.y.mul(FRAMES);
    const first = floor(frames);
    const blend = frames.sub(first);
    // The frame after the last is the first again.
    const second = first.add(1).sub(step(FRAMES - 0.5, first.add(1)).mul(FRAMES));
    const texel = (c: number, row: TslNode): TslNode => textureLoad(bones, ivec2(column.add(c), motion.x.add(row)));
    const skin = (row: TslNode): { p: TslNode; n: TslNode } => {
      const c0 = texel(0, row).xyz;
      const c1 = texel(1, row).xyz;
      const c2 = texel(2, row).xyz;
      const c3 = texel(3, row).xyz;
      const p = c0.mul(positionGeometry.x).add(c1.mul(positionGeometry.y)).add(c2.mul(positionGeometry.z)).add(c3);
      const n = c0.mul(normalGeometry.x).add(c1.mul(normalGeometry.y)).add(c2.mul(normalGeometry.z));
      return { p, n };
    };
    const a = skin(first);
    const b = skin(second);
    const body = mix(a.p, b.p, blend).mul(motion.z);
    const normal = mix(a.n, b.n, blend).normalize();
    // The yaw of -heading, as `rotation.y = -heading` turns the player's model.
    const c = cos(place.w.negate());
    const s = sin(place.w.negate());
    const turn = (v: TslNode): TslNode => vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));
    normalLocal.assign(turn(normal));
    return turn(body).add(place.xyz);
  })();

  const part = attribute('rig', 'vec2').y;
  let colour = attribute('pedSkin', 'vec3');
  colour = mix(colour, attribute('pedHair', 'vec3'), step(PART_HAIR - 0.5, part));
  colour = mix(colour, attribute('pedTop', 'vec3'), step(PART_TOP - 0.5, part));
  colour = mix(colour, attribute('pedLegs', 'vec3'), step(PART_LEGS - 0.5, part));
  colour = mix(colour, SHOE, step(PART_SHOES - 0.5, part));
  // A patrol officer's shoulders: the top, facing up, on a body flagged 1.
  const top = step(PART_TOP - 0.5, part).mul(step(part, PART_TOP + 0.5));
  const patrol = step(0.5, motion.w).mul(step(motion.w, 1.5));
  colour = mix(colour, HI_VIS, top.mul(patrol).mul(step(0.5, normalGeometry.y)));
  material.colorNode = colour;
  material.roughnessNode = float(0.8);
  return material;
}
