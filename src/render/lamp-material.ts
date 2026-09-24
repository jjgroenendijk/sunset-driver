/**
 * The material the street lamps are drawn with (spec sections 10.5, 13.4).
 *
 * One material for a whole world. The `part` attribute `lamp-mesh.ts` writes
 * tells the mast and its arm from the lens under the lantern: the mast is
 * painted metal, and the lens is the one surface that glows. How far on the
 * lamps are is one uniform, shared by every chunk, so a whole city lights up
 * together at dusk.
 *
 * The lens glows rather than being lit. The light it throws is the projector
 * cone of `lamps.ts`, and only a few lamps get one; painting the lens on all of
 * them is what makes the rest read as lit from the camera's height.
 *
 * Only this file, the other `*-material.ts` files and `tsl.ts` know about shader
 * nodes.
 */
import { Color } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { LAMP_LENS } from './lamp-mesh.ts';
import { attribute, float, mix, step, uniform, vec3, type TslNode } from './tsl.ts';

/** The painted mast, and the glass under the lantern when it is dark. */
const MAST = 0x2e8c8a;
const LENS = 0xffe0a8;

/** How hard the lens burns when the lamps are full on. */
const LENS_GLOW = 5;

/** The lamps of one world: one material, and the switch every chunk shares. */
export interface LampMaterials {
  lamp: MeshStandardNodeMaterial;
  /** How far on the lamps are, 0 by day and 1 after dark. */
  lamps: { value: number };
  dispose(): void;
}

export function createLampMaterials(): LampMaterials {
  const lamps = uniform(0);
  const lamp = new MeshStandardNodeMaterial({ metalness: 0.4, roughness: 0.6 });
  const part = attribute('part', 'float');
  const lens = step(LAMP_LENS - 0.5, part);
  lamp.colorNode = mix(rgb(MAST), rgb(LENS), lens);
  lamp.emissiveNode = rgb(LENS).mul(lens).mul(float(LENS_GLOW)).mul(lamps);
  return {
    lamp,
    lamps,
    dispose(): void {
      lamp.dispose();
    },
  };
}

/** A colour constant in the working colour space, as a shader node. */
function rgb(hex: number): TslNode {
  const colour = new Color(hex);
  return vec3(colour.r, colour.g, colour.b);
}
