/**
 * The materials the roads are drawn with (spec sections 10.1, 10.2).
 *
 * One material per tier, because a tier is one batch: the surface of a road, its
 * verge, its kerb and its pavement all arrive in the same mesh, and the material
 * tells them apart by the `across` attribute `road-mesh.ts` writes — metres from
 * the centreline. The boundaries are hard steps at the tier's own widths, so the
 * kerb reads as a kerb rather than as a gradient. The `kind` attribute marks the
 * decks, parapets and portals, which are concrete whatever they stand over.
 *
 * The build ships no image files, so the grain of asphalt, concrete and gravel
 * is fractal noise in the shader, as the ground's is.
 *
 * Only this file, `ground-material.ts` and `tsl.ts` know about shader nodes.
 */
import { Color } from 'three';
import { Line2NodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { TIERS } from '../world/tiers.ts';
import type { RoadTier } from '../world/types.ts';
import { attribute, float, fractalNoise, mix, positionWorld, step, vec3, type TslNode } from './tsl.ts';

/** Metres of one period of the fine grain of a surface, and of the patches over it. */
const GRAIN_METRES = 1.6;
const PATCH_METRES = 26;

/** Concrete: every deck, parapet and portal, whatever tier carries it. */
const CONCRETE = 0x8f8c85;

/** Metres a painted line is wide, and how bright the paint is. */
const PAINT_WIDTH = 0.16;

/**
 * What each tier is surfaced with: the carriageway, the verge or kerb beside it,
 * and the pavement outside that. A tier with no pavement repeats its verge, and
 * one with neither repeats its carriageway, so the bands a tier does not have
 * cost nothing and show nothing.
 */
interface TierPalette {
  carriageway: number;
  verge: number;
  pavement: number;
  /** How rough the carriageway is: asphalt is smoother than gravel. */
  roughness: number;
}

const PALETTE: Record<RoadTier, TierPalette> = {
  // Fresh asphalt on the fast roads, with a grass verge outside the hard edge.
  highway: { carriageway: 0x37383c, verge: 0x55632f, pavement: 0x55632f, roughness: 0.82 },
  // Worn asphalt between granite kerbs and concrete pavements.
  arterial: { carriageway: 0x3e3f43, verge: 0x84827d, pavement: 0x9c988f, roughness: 0.86 },
  street: { carriageway: 0x44454a, verge: 0x84827d, pavement: 0x97938b, roughness: 0.88 },
  // Unmarked and patched, kerb to kerb: an alley is all carriageway.
  alley: { carriageway: 0x393731, verge: 0x393731, pavement: 0x393731, roughness: 0.94 },
  // Unpaved, with the dust of the outskirts on the shoulder.
  dirt: { carriageway: 0x8a7350, verge: 0x76703f, pavement: 0x76703f, roughness: 0.97 },
};

/** The material one tier's roads are drawn with, shared by every chunk of a world. */
export function createRoadMaterial(tier: RoadTier): MeshStandardNodeMaterial {
  const spec = TIERS[tier];
  const palette = PALETTE[tier];
  const material = new MeshStandardNodeMaterial({ metalness: 0 });

  const grain = noise01(GRAIN_METRES, 3);
  const patch = noise01(PATCH_METRES, 2);
  const across = attribute('across', 'float').abs();

  // Hard boundaries at the tier's own widths: the kerb line, then the back of
  // the verge. A band the tier does not have is zero wide and never shows.
  const beyondKerb = step(spec.width / 2, across);
  const beyondVerge = step(spec.width / 2 + spec.verge, across);

  const surface = mix(rgb(palette.carriageway), rgb(palette.verge), beyondKerb);
  const paved = mix(surface, rgb(palette.pavement), beyondVerge);
  const road = paved.mul(float(0.82).add(patch.mul(0.26)).add(grain.mul(0.2)));
  const structure = rgb(CONCRETE).mul(float(0.86).add(grain.mul(0.22)));

  const kind = attribute('kind', 'float');
  material.colorNode = mix(road, structure, kind);
  // Asphalt is smoother than the ground beside it, and the fine grain varies it.
  material.roughnessNode = mix(float(palette.roughness), float(palette.roughness - 0.16), grain);
  return material;
}

/**
 * The material the lane markings are drawn with (spec section 22.1, `Line2`).
 * One material per tier, and the colour of each line comes off the geometry, so
 * the yellow of a centre line and the white of a lane divider share a draw call.
 */
export function createMarkingMaterial(): Line2NodeMaterial {
  return new Line2NodeMaterial({
    // The paint is on the road, so it is as wide as the road says, not as wide
    // as the screen says.
    worldUnits: true,
    linewidth: PAINT_WIDTH,
    vertexColors: true,
  });
}

/** A colour constant in the working colour space, as a shader node. */
function rgb(hex: number): TslNode {
  const colour = new Color(hex);
  return vec3(colour.r, colour.g, colour.b);
}

/**
 * Fractal noise over the ground plane, in 0..1. The place is the world one, so
 * the grain is continuous across a chunk boundary and does not move with the
 * mesh it is drawn on.
 */
function noise01(metres: number, octaves: number): TslNode {
  const place = vec3(positionWorld.x.div(metres), positionWorld.z.div(metres), 0);
  return fractalNoise(place, octaves).mul(0.5).add(0.5);
}
