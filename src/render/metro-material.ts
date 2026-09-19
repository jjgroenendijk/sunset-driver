/**
 * The material the metro entrances are drawn with (spec section 13.3).
 *
 * One material for a whole world. The concrete of the parapets, the steel of
 * the rails and the dark of the well are on the vertices, as `metro-mesh.ts`
 * paints them; what a vertex also carries is how hard it burns, and that glow
 * times the switch is the emissive. Only the sign's plate carries any, so the
 * sign is the one surface that lights up. How far on the lamps are is one
 * uniform, shared with the street lamps, so the city lights together at dusk.
 *
 * Only this file, the other `*-material.ts` files and `tsl.ts` know about
 * shader nodes.
 */
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, uniform } from './tsl.ts';

/** The entrances of one world: one material, and the switch every chunk shares. */
export interface MetroMaterials {
  entrance: MeshStandardNodeMaterial;
  /** How far on the lamps are, 0 by day and 1 after dark. */
  lamps: { value: number };
  dispose(): void;
}

export function createMetroMaterials(): MetroMaterials {
  const lamps = uniform(0);
  const entrance = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.1 });
  entrance.emissiveNode = attribute('color', 'vec3').mul(attribute('glow', 'float')).mul(lamps);
  return {
    entrance,
    lamps,
    dispose(): void {
      entrance.dispose();
    },
  };
}
