/**
 * The materials the roads are drawn with (spec sections 10.1, 10.2).
 *
 * One material per tier, because a tier is one batch: the surface of a road, its
 * verge, its kerb and its pavement all arrive in the same mesh, and the material
 * tells them apart by the `across` attribute `road-mesh.ts` writes — metres from
 * the centreline. The boundaries are hard steps at the tier's own widths, so the
 * kerb reads as a kerb rather than as a gradient. The `kind` attribute marks the
 * decks, parapets, piers and portals, which are concrete whatever they stand
 * over, and the tram's lane, rails and level crossings (`road-section.ts`).
 *
 * The build ships no image files, so the grain of asphalt, concrete and gravel
 * is fractal noise in the shader, as the ground's is.
 *
 * Only this file, `ground-material.ts` and `tsl.ts` know about shader nodes.
 */
import { Color } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { TIERS } from '../world/tiers.ts';
import type { RoadTier } from '../world/types.ts';
import { attribute, float, floor, fract, fractalNoise, max, mix, positionWorld, step, vec3, type TslNode } from './tsl.ts';

/** Metres of one period of the fine grain of a surface, and of the patches over it. */
const GRAIN_METRES = 1.6;
const PATCH_METRES = 26;

/** Concrete: every deck, parapet, pier and portal, whatever tier carries it. */
const CONCRETE = 0x8f8c85;
/**
 * The tram's lane: granite setts where it is paved, cut grass where it is open,
 * steel rails with a dark groove down each head, and a pale concrete panel at a
 * level crossing, outlined in white paint.
 */
const SETTS_RGB = 0x6f6a63;
const SETTS_JOINT_RGB = 0x4a453f;
const TRACK_GRASS_RGB = 0x53703a;
const RAIL_RGB = 0xa9aaae;
const GROOVE_RGB = 0x2a2724;
const CROSSING_RGB = 0xb3ab98;
const CROSSING_MARK_RGB = 0xd7d4cb;

/** Metres of one sett, along the track and across it. */
const SETT_LONG = 0.34;
const SETT_ACROSS = 0.22;
/** Metres of mortar between two setts. */
const SETT_JOINT = 0.045;

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
  /**
   * Metres of the verge, out from the kerb, drawn in the verge colour. The rest
   * of the verge takes the pavement colour. Unset, the whole verge does.
   */
  shoulder?: number;
}

const PALETTE: Record<RoadTier, TierPalette> = {
  // Fresh asphalt on the fast roads. The verge is a paved hard shoulder of
  // older, paler asphalt, with a strip of gravel at its back.
  highway: { carriageway: 0x37383c, verge: 0x4b4b4c, pavement: 0x7a7468, roughness: 0.82, shoulder: 3 },
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
  // the verge, or of the shoulder where the tier has one. A band the tier does not have is zero wide and never shows.
  const beyondKerb = step(spec.width / 2, across);
  const beyondVerge = step(spec.width / 2 + (palette.shoulder ?? spec.verge), across);

  const surface = mix(rgb(palette.carriageway), rgb(palette.verge), beyondKerb);
  const paved = mix(surface, rgb(palette.pavement), beyondVerge);
  const road = paved.mul(float(0.82).add(patch.mul(0.26)).add(grain.mul(0.2)));
  const structure = rgb(CONCRETE).mul(float(0.86).add(grain.mul(0.22)));

  // The kinds are whole numbers, so a step half-way between two picks one out.
  const kind = attribute('kind', 'float');
  const at = (k: number): TslNode => step(k - 0.5, kind).sub(step(k + 0.5, kind));
  const setts = mix(rgb(SETTS_RGB).mul(float(0.82).add(patch.mul(0.24)).add(grain.mul(0.2))), rgb(SETTS_JOINT_RGB), settJoints());
  const grass = rgb(TRACK_GRASS_RGB).mul(float(0.74).add(patch.mul(0.3)).add(grain.mul(0.26)));
  const crossing = rgb(CROSSING_RGB).mul(float(0.86).add(grain.mul(0.22)));
  let colour = mix(road, structure, at(1));
  colour = mix(colour, setts, at(2));
  colour = mix(colour, rgb(RAIL_RGB).mul(float(0.9).add(grain.mul(0.2))), at(3));
  colour = mix(colour, crossing, at(4));
  colour = mix(colour, grass, at(5));
  colour = mix(colour, rgb(GROOVE_RGB), at(6));
  colour = mix(colour, rgb(CROSSING_MARK_RGB), at(7));
  material.colorNode = colour;
  // Asphalt is smoother than the ground beside it, and the fine grain varies it.
  material.roughnessNode = mix(float(palette.roughness), float(palette.roughness - 0.16), grain);
  return material;
}

/**
 * The material the lane markings are drawn with (spec section 22.1).
 *
 * The paint is a flat strip lying on the carriageway (`road-mesh.ts`), lit as
 * the road under it is, so a line in the shadow of a building is as dark as the
 * asphalt beside it. The colour of each line comes off the geometry, so the
 * yellow of a centre line and the white of a lane divider share a draw call.
 *
 * The strip stands only millimetres over the road. A depth offset pulls it
 * towards the camera, so it wins against the road at any distance rather than
 * breaking up into the asphalt far off. The offset is a nudge in depth, not a
 * lift in the world, so the paint never shows through anything standing in
 * front of the road.
 */
export function createMarkingMaterial(): MeshStandardNodeMaterial {
  return new MeshStandardNodeMaterial({
    vertexColors: true,
    // Road paint is smoother than the asphalt it is laid on.
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
}

/**
 * How dark a place stands in the courses of setts, 1 in the mortar and 0 on the
 * face of a stone. The courses run on the world grid rather than along the
 * track, which a top-down camera cannot tell apart from a laid course, and
 * every other course is offset half a stone so the joints never line up.
 */
function settJoints(): TslNode {
  const course = positionWorld.z.div(SETT_ACROSS);
  const shift = floor(course).mul(0.5);
  const along = fract(positionWorld.x.div(SETT_LONG).add(shift));
  const across = fract(course);
  const edge = (at: TslNode, width: number): TslNode => step(at, float(width)).add(step(float(1 - width), at));
  return max(edge(along, SETT_JOINT / SETT_LONG), edge(across, SETT_JOINT / SETT_ACROSS)).mul(0.85);
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
