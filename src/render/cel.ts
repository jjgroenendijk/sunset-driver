/**
 * The banded light of the art style (spec section 10.1, `docs/art-style.md`).
 *
 * A lit surface shows three bands of the sun — light, mid and shade — joined by
 * a short soft ramp, never a long smooth gradient. The sun's own term is the
 * one that bands: the cosine of its angle to the surface, times the shadow the
 * cascades cast, is stepped into the three levels before it lights anything.
 * The shade band is the sky fill alone, which is a colour, so a surface in
 * shade shifts toward it rather than toward black.
 *
 * Every other light keeps the model it had. A street lamp, a headlight and the
 * area light of a neon sign still light the street as the physical model says,
 * so a pool of lamplight on the road keeps its falloff.
 *
 * The bands are put in by replacing the lighting model of the two node
 * materials the city is drawn with, on their prototypes, once. That reaches the
 * classic `MeshStandardMaterial` of a vehicle as well, since the renderer draws
 * it through `MeshStandardNodeMaterial`. The water and the sky are materials of
 * their own and are not banded.
 */
import {
  MeshLambertNodeMaterial,
  MeshStandardNodeMaterial,
  PhongLightingModel,
  PhysicalLightingModel,
  type NodeBuilder,
} from 'three/webgpu';
import { BRDF_Lambert, diffuseColor, float, normalView, smoothstep, type TslNode } from './tsl.ts';

/**
 * Where the bands change, as the sun's cosine times its shadow. A face turned
 * more than about 83 degrees from the sun, or in a cast shadow, is in shade; a
 * wall the afternoon sun rakes is mid; a roof or a street under a high sun is
 * lit.
 */
const SHADE_TO_MID = 0.12;
const MID_TO_LIT = 0.42;

/** How much of the sun the mid band takes. The lit band takes all of it. */
const MID = 0.5;

/**
 * Half the width of the soft ramp between two bands, in the same cosine. It is
 * a small share of a band, so an edge reads as a step, but it is wider than a
 * pixel's worth of a curved surface, so the step does not stair.
 */
const RAMP = 0.035;

/** The share of the sun a surface takes: 0 in shade, {@link MID} in mid, 1 lit. */
function sunBand(light: TslNode): TslNode {
  const toMid = smoothstep(SHADE_TO_MID - RAMP, SHADE_TO_MID + RAMP, light);
  const toLit = smoothstep(MID_TO_LIT - RAMP, MID_TO_LIT + RAMP, light);
  return toMid.mul(MID).add(toLit.mul(1 - MID));
}

/** What a light hands the lighting model's `direct`. */
interface DirectLight {
  lightDirection: TslNode;
  lightColor: TslNode;
  lightNode: {
    light: { isDirectionalLight?: boolean; castShadow: boolean } | null;
    shadowNode: TslNode | null;
    baseColorNode: TslNode | null;
  };
  reflectedLight: { directDiffuse: TslNode; indirectDiffuse: TslNode };
}

/**
 * Light a surface with the sun in bands, and say whether the light was the sun.
 *
 * The light hands its colour with the shadow already multiplied in. The bands
 * need the shadow and the cosine together, so the colour is read from before
 * the shadow was laid on, and the shadow is folded into the cosine instead. An
 * object that takes no shadow gets the light's plain colour and no shadow.
 *
 * A surface takes the sun as a painted one does, whatever its metalness: the
 * sun has no specular here, and a metal lit only by a specular it no longer
 * has would be black.
 */
function sunDirect(data: DirectLight, builder: NodeBuilder): boolean {
  const { light, shadowNode, baseColorNode } = data.lightNode;
  if (light?.isDirectionalLight !== true) return false;
  const shadowed = builder.object.receiveShadow && light.castShadow && shadowNode !== null && baseColorNode !== null;
  const colour = shadowed ? baseColorNode : data.lightColor;
  const shadow = shadowed ? shadowNode : float(1);
  const cosine = normalView.dot(data.lightDirection).clamp();
  const irradiance = colour.mul(sunBand(cosine.mul(shadow)));
  data.reflectedLight.directDiffuse.addAssign(irradiance.mul(BRDF_Lambert({ diffuseColor: diffuseColor.rgb })));
  return true;
}

/**
 * The fill of the sky, as plain Lambert. The physical model takes the share a
 * specular lobe would have reflected off it, which darkens the shade band of a
 * smooth surface against a rough one beside it for no reason a painted city
 * shows.
 */
function fillIndirect(builder: NodeBuilder): void {
  const { ambientOcclusion, irradiance, reflectedLight } = builder.context as unknown as {
    ambientOcclusion: TslNode;
    irradiance: TslNode;
    reflectedLight: DirectLight['reflectedLight'];
  };
  reflectedLight.indirectDiffuse.addAssign(irradiance.mul(BRDF_Lambert({ diffuseColor: diffuseColor.rgb })));
  reflectedLight.indirectDiffuse.mulAssign(ambientOcclusion);
}

/** What three.js hands a lighting model's `direct`, as its types name it. */
type DirectInput = Parameters<PhysicalLightingModel['direct']>[0];

/** The physical model with the sun in bands and a Lambert fill. */
class CelPhysicalModel extends PhysicalLightingModel {
  override direct(data: DirectInput, builder: NodeBuilder): void {
    if (!sunDirect(data as unknown as DirectLight, builder)) super.direct(data, builder);
  }

  override indirect(builder: NodeBuilder): void {
    fillIndirect(builder);
  }
}

/** The Lambert model with the sun in bands. */
class CelLambertModel extends PhongLightingModel {
  constructor() {
    super(false);
  }

  override direct(data: DirectInput, builder: NodeBuilder): void {
    if (!sunDirect(data as unknown as DirectLight, builder)) super.direct(data, builder);
  }

  override indirect(builder: NodeBuilder): void {
    fillIndirect(builder);
  }
}

let installed = false;

/**
 * Band the light of every Standard and Lambert node material, from now on. A
 * material builds its shader the first time it is drawn, so this has to run
 * before the first frame; `renderer.ts` runs it when a renderer is made. It is
 * safe to call again.
 */
export function installCelShading(): void {
  if (installed) return;
  installed = true;
  MeshStandardNodeMaterial.prototype.setupLightingModel = () => new CelPhysicalModel();
  MeshLambertNodeMaterial.prototype.setupLightingModel = () => new CelLambertModel();
}
