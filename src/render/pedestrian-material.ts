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
 * `pedBlend` holds the gait they are leaving — its first row and how far
 * through it — and how much of it is left, so a change of gait fades over a
 * few frames, and last the turn of the head against the body. `pedStyle`
 * holds how far the upper body stoops and which prop, if any, the person
 * holds: every prop is part of the one body, and folds to a point on anyone
 * not holding it.
 *
 * The four colours of a person are instance attributes too, and a vertex's
 * `part` picks one. The fourth value of `pedMotion` is 1 on a patrol officer
 * (`uniform.ts`), whose shoulders are painted hi-vis: the faces of the top
 * that look up. Only this file, the other `*-material.ts` files and
 * `tsl.ts` know about shader nodes.
 */
import type { DataTexture } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  FRAMES,
  HIP_HEIGHT,
  PART_GUITAR,
  PART_HAIR,
  PART_LEGS,
  PART_PHONE,
  PART_PROP,
  PART_SHOES,
  PART_SMOKE,
  PART_TOP,
  PART_UMBRELLA,
} from './pedestrian-rig.ts';
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

/** The props: a dark phone, a white cigarette, a wooden guitar. */
const PHONE = vec3(0.02, 0.02, 0.025);
const SMOKE = vec3(0.85, 0.83, 0.78);
const GUITAR = vec3(0.42, 0.22, 0.08);

/** The hi-vis yellow on a patrol officer's shoulders. */
const HI_VIS = vec3(0.78, 0.9, 0.12);

/** The bones whose boxes a lean tips forward: the torso, the head, and both arms and forearms. */
const UPPER = [1, 2, 7, 8, 9, 10];

/** The material every person of the crowd is drawn with, reading bones from the baked walks. */
export function createPedestrianMaterial(bones: DataTexture): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  const place = attribute('pedPlace', 'vec4');
  const motion = attribute('pedMotion', 'vec4');
  const blend = attribute('pedBlend', 'vec4');
  const style = attribute('pedStyle', 'vec4');
  const rig = attribute('rig', 'vec2');

  material.positionNode = Fn(() => {
    const bone = rig.x;
    const column = bone.mul(4);
    // The head turns about the neck before the bones move it: a turn of the
    // head against the body, towards the right of the way they face.
    const head = step(1.5, bone).mul(step(bone, 2.5));
    const look = blend.w.mul(head);
    const lc = cos(look);
    const ls = sin(look);
    const yaw = (v: TslNode): TslNode => vec3(v.x.mul(lc).sub(v.z.mul(ls)), v.y, v.x.mul(ls).add(v.z.mul(lc)));
    const bindP = yaw(positionGeometry);
    const bindN = yaw(normalGeometry);
    const texel = (c: number, row: TslNode): TslNode => textureLoad(bones, ivec2(column.add(c), row));
    const skin = (row: TslNode): { p: TslNode; n: TslNode } => {
      const c0 = texel(0, row).xyz;
      const c1 = texel(1, row).xyz;
      const c2 = texel(2, row).xyz;
      const c3 = texel(3, row).xyz;
      const p = c0.mul(bindP.x).add(c1.mul(bindP.y)).add(c2.mul(bindP.z)).add(c3);
      const n = c0.mul(bindN.x).add(c1.mul(bindN.y)).add(c2.mul(bindN.z));
      return { p, n };
    };
    // A gait at a point of its cycle: the two frames either side, blended.
    const cycle = (first: TslNode, at: TslNode): { p: TslNode; n: TslNode } => {
      const frames = at.mul(FRAMES);
      const whole = floor(frames);
      const part = frames.sub(whole);
      // The frame after the last is the first again.
      const next = whole.add(1).sub(step(FRAMES - 0.5, whole.add(1)).mul(FRAMES));
      const a = skin(first.add(whole));
      const b = skin(first.add(next));
      return { p: mix(a.p, b.p, part), n: mix(a.n, b.n, part) };
    };
    const now = cycle(motion.x, motion.y);
    // The gait they are leaving, faded out over the first moments of the new one.
    const was = cycle(blend.x, blend.y);
    const skinned = mix(now.p, was.p, blend.z);
    const skinnedN = mix(now.n, was.n, blend.z);
    // A stoop: the upper body tipped forward about the hips.
    let upper: TslNode = float(0);
    for (const b of UPPER) upper = upper.add(step(b - 0.5, bone).mul(step(bone, b + 0.5)));
    const lean = style.x.mul(upper);
    const c = cos(lean);
    const s = sin(lean);
    const tip = (v: TslNode, pivot: number): TslNode => {
      const y = v.y.sub(pivot);
      return vec3(v.x.mul(c).add(y.mul(s)), y.mul(c).sub(v.x.mul(s)).add(pivot), v.z);
    };
    // A prop is drawn only on the person holding it: anyone else folds it to a point.
    const prop = step(PART_PROP - 0.5, rig.y);
    const held = step(style.y.sub(0.5), rig.y).mul(step(rig.y, style.y.add(0.5)));
    const shown = float(1).sub(prop.mul(float(1).sub(held)));
    const body = tip(skinned, HIP_HEIGHT).mul(motion.z).mul(shown);
    const normal = tip(skinnedN, 0).normalize();
    // The yaw of -heading, as `rotation.y = -heading` turns the player's model.
    const hc = cos(place.w.negate());
    const hs = sin(place.w.negate());
    const turn = (v: TslNode): TslNode => vec3(v.x.mul(hc).add(v.z.mul(hs)), v.y, v.z.mul(hc).sub(v.x.mul(hs)));
    normalLocal.assign(turn(normal));
    return turn(body).add(place.xyz);
  })();

  const part = rig.y;
  let colour = attribute('pedSkin', 'vec3');
  colour = mix(colour, attribute('pedHair', 'vec3'), step(PART_HAIR - 0.5, part));
  colour = mix(colour, attribute('pedTop', 'vec3'), step(PART_TOP - 0.5, part));
  colour = mix(colour, attribute('pedLegs', 'vec3'), step(PART_LEGS - 0.5, part));
  colour = mix(colour, SHOE, step(PART_SHOES - 0.5, part));
  colour = mix(colour, PHONE, step(PART_PHONE - 0.5, part));
  colour = mix(colour, SMOKE, step(PART_SMOKE - 0.5, part));
  // An umbrella in the colour of their trousers, so no two are alike.
  colour = mix(colour, attribute('pedLegs', 'vec3').mul(0.8), step(PART_UMBRELLA - 0.5, part));
  colour = mix(colour, GUITAR, step(PART_GUITAR - 0.5, part));
  // A patrol officer's shoulders: the top, facing up, on a body flagged 1.
  const top = step(PART_TOP - 0.5, part).mul(step(part, PART_TOP + 0.5));
  const patrol = step(0.5, motion.w).mul(step(motion.w, 1.5));
  colour = mix(colour, HI_VIS, top.mul(patrol).mul(step(0.5, normalGeometry.y)));
  material.colorNode = colour;
  material.roughnessNode = float(0.8);
  return material;
}
