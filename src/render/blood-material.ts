/**
 * The shader of a mark of blood on the ground (`blood.ts`).
 *
 * A mark is a flat square. The shader cuts an irregular blot out of it with
 * noise, so no two marks share an outline and none has the edge of a disc. No
 * texture is read: spec section 1.2 allows no asset files. Each instance
 * carries a `blood` attribute that the batch writes every frame:
 *
 * - `x` — how much of the mark shows, 0 to 1.
 * - `y` — a number of its own, 0 to 1, which moves it to its own patch of noise.
 * - `z` — 0 for a round blot, 1 for a streak along the square's length.
 * - `w` — how dry it is, 0 to 1. Fresh blood is red and glossy; dry blood is
 *   near black and dull.
 *
 * It is lit by the scene, so the gloss catches the sun and the street lamps.
 */
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { NormalBlending } from 'three';
import { attribute, float, fractalNoise, max, mix, smoothstep, uv, vec3, vec4 } from './tsl.ts';

const FRESH = vec3(0.3, 0.012, 0.01);
const DRIED = vec3(0.09, 0.012, 0.008);

/** The reach from the middle, on a scale of 1 at the square's edge, past which nothing is drawn. */
const EDGE_LOW = 0.6;
const EDGE_HIGH = 0.78;

export function bloodMaterial(): MeshStandardNodeMaterial {
  const data = attribute('blood', 'vec4');
  const fade = data.x;
  const variant = data.y;
  const streak = data.z;
  const age = data.w;
  // The point of the square, -1 to 1 each way, with x along its length.
  const at = uv().sub(0.5).mul(2);
  // A blot: round, with a lumpy rim.
  const blotNoise = fractalNoise(vec3(at.mul(1.4).add(variant.mul(31)), variant.mul(7)), 3);
  const blot = at.length().add(blotNoise.mul(0.35));
  // A streak: noise stretched along the length, which reads as the lines a
  // sliding body drags, thicker where it came down and thinner where it stopped.
  const lineNoise = fractalNoise(vec3(at.x.mul(0.8).add(variant.mul(13)), at.y.mul(5), variant.mul(3)), 3);
  const taper = mix(float(1), float(0.5), at.x.mul(0.5).add(0.5));
  const line = max(at.y.abs().div(taper), at.x.mul(at.x)).add(lineNoise.mul(0.4));
  const reach = mix(blot, line, streak);
  const shape = float(1).sub(smoothstep(EDGE_LOW, EDGE_HIGH, reach));
  // Thin at the rim, where it has spread furthest, and deep in the middle.
  const depth = float(1).sub(smoothstep(0.1, EDGE_HIGH, reach));
  const material = new MeshStandardNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    metalness: 0,
    // Laid on the road, and pulled toward the camera so the road never shows through.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  material.colorNode = vec4(mix(FRESH, DRIED, age).mul(mix(float(0.8), float(1.05), depth)), 1);
  material.opacityNode = shape.mul(mix(float(0.7), float(0.95), depth)).mul(fade);
  // Wet is glossy, and the gloss goes as it dries.
  material.roughnessNode = mix(float(0.12), float(0.6), age).add(blotNoise.mul(0.08));
  return material;
}
