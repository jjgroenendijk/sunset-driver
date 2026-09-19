/**
 * The shaders of a puff of smoke and a tongue of flame (`damage-fx.ts`).
 *
 * A puff is a square that faces the camera. The shader cuts a soft, ragged
 * shape out of it with noise, so no two puffs share an outline and none has
 * the hard edge of a disc. Each instance carries a `puff` attribute that the
 * batch writes every frame:
 *
 * - `x` — how much of the puff is left, 0 to 1. It fades the puff in and out.
 * - `y` — a number of its own, 0 to 1. It moves the puff to its own patch of
 *   noise.
 * - `z` — its age, 0 to 1. The noise rolls with it, so the shape churns.
 * - `w` — how much fire lights it from below. Only smoke reads it.
 *
 * Smoke is lit by the scene, so it is grey at noon and dark at night, where
 * only the fire under it shows it up. Flame is its own light: a colour ramp
 * from white at the core to red at the rim, added onto the frame and bright
 * enough to bloom.
 */
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { AdditiveBlending, DoubleSide, NormalBlending } from 'three';
import { attribute, clamp, float, fractalNoise, mix, smoothstep, uv, vec2, vec3, vec4, type TslNode } from './tsl.ts';

/** The colour fire casts onto the smoke over it. */
const GLOW = vec3(1, 0.34, 0.08);

/** The flame's ramp, from its rim to its core. */
const EMBER_RED = vec3(0.55, 0.06, 0.01);
const ORANGE = vec3(1, 0.42, 0.06);
const CORE = vec3(1, 0.86, 0.55);

/** How bright the core of a flame is, over 1 so the bloom picks it up. */
const FLAME_GAIN = 2.2;

interface Puff {
  fade: TslNode;
  variant: TslNode;
  age: TslNode;
  glow: TslNode;
  /** The point of the square, -0.5 to 0.5 each way, with up the top. */
  at: TslNode;
}

function puff(): Puff {
  const data = attribute('puff', 'vec4');
  return {
    fade: data.x,
    variant: data.y,
    age: data.z,
    glow: data.w,
    at: uv().sub(0.5),
  };
}

/** Smoke: a soft, lumpy ball, darker underneath, fading at its ragged rim. */
export function smokeMaterial(): MeshStandardNodeMaterial {
  const p = puff();
  const place = vec3(p.at.mul(2.4).add(p.variant.mul(19)), p.age.mul(1.3).add(p.variant.mul(7)));
  const noise = fractalNoise(place, 3);
  const reach = p.at.length().mul(2);
  const shape = float(1).sub(smoothstep(0.1, 1, reach.add(noise.mul(0.35))));
  const density = clamp(shape.mul(noise.mul(0.3).add(1.2)), 0, 1);
  const material = new MeshStandardNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
    roughness: 1,
    metalness: 0,
  });
  // Lighter on its lumps and darker underneath, which is what gives a puff a body.
  const shade = noise
    .mul(0.18)
    .add(0.9)
    .mul(mix(float(0.72), float(1.08), p.at.y.add(0.5)));
  material.colorNode = vec4(vec3(shade, shade, shade), 1);
  material.opacityNode = density.mul(p.fade);
  material.emissiveNode = GLOW.mul(p.glow).mul(density).mul(float(0.5).sub(p.at.y).clamp(0, 1));
  return material;
}

/** Flame: a tongue that licks upward, white at the core and red at the rim. */
export function flameMaterial(): MeshBasicNodeMaterial {
  const p = puff();
  // The noise runs downward through the flame as it ages, so the licks rise.
  const place = vec3(p.at.x.mul(3).add(p.variant.mul(23)), p.at.y.mul(2.2).sub(p.age.mul(3)), p.variant.mul(11));
  const noise = fractalNoise(place, 3);
  // Narrower at the top than the bottom: a tongue, not a ball.
  const at = vec2(p.at.x.mul(p.at.y.add(0.5).mul(1.1).add(1)), p.at.y);
  const reach = at.length().mul(2);
  const heat = clamp(float(1).sub(smoothstep(0.05, 1, reach.add(noise.mul(0.5)))), 0, 1);
  const hot = heat.mul(float(1).sub(p.age.mul(0.55)));
  const ramp = mix(mix(EMBER_RED, ORANGE, smoothstep(0, 0.45, hot)), CORE, smoothstep(0.45, 0.95, hot));
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    fog: false,
  });
  material.colorNode = vec4(ramp.mul(FLAME_GAIN), 1);
  material.opacityNode = heat.mul(p.fade);
  return material;
}
