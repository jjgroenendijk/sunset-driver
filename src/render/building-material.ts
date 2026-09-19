/**
 * The materials the buildings are drawn with (spec sections 10.1, 10.3).
 *
 * Three of them, which is what a chunk's three batches need:
 *
 * - the facade, which is the generator's own material dressing the towers and
 *   the mid-rise blocks, with the night added to it;
 * - the block, which shades the walls, roofs, trim and glazing of everything
 *   else from the `part` attribute `block-mesh.ts` writes;
 * - the outline, a flat dark shell drawn back-face only, which is the hard
 *   outline of spec section 10.1.
 *
 * Both lit materials carry the emissive window mask: the glass of a building is
 * picked out, some of it is lit, and the whole of it is multiplied by one
 * `night` uniform. The uniform is 0 by daylight and nothing glows; the day and
 * night cycle of spec section 10.5 is issue #21 and owns it from there.
 *
 * The build ships no image files, so the grain of render, brick and metal is
 * fractal noise in the shader, as the ground's and the roads' are.
 *
 * Only this file, the other `*-material.ts` files and `tsl.ts` know about shader
 * nodes.
 */
import { BackSide, Color } from 'three';
import { createSkyscraperMaterial } from 'three/examples/jsm/generators/city/SkyscraperGenerator.js';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { BLOCK_GLASS, BLOCK_ROOF, BLOCK_TRIM } from './block-mesh.ts';
import type { BuildingCutaway } from './cutaway.ts';
import {
  attribute,
  float,
  fractalNoise,
  mix,
  positionWorld,
  smoothstep,
  step,
  uniform,
  uv,
  vec3,
  type TslNode,
} from './tsl.ts';

/**
 * The material zones the tower generator bakes into its `partId` attribute. Only
 * the two glazed ones are named here, because they are the ones the night lights
 * up; the generator's own material reads the rest.
 */
const FACADE_GLASS = 4;
const FACADE_SHOPGLASS = 6;

/** Metres of one period of the fine grain of a wall, and of the patches over it. */
const GRAIN_METRES = 1.1;
const PATCH_METRES = 18;

/** Metres of one storey, as the window bands are spaced (`block-mesh.ts`). */
const STOREY = 3.2;

/** Metres of one window and of the mullion between two of them. */
const WINDOW_PITCH = 2.2;
const MULLION = 0.28;

/** How much of the windows are lit after dark, and how warm that light is. */
const LIT_SHARE = 0.45;
const WINDOW_GLOW = 0xffd9a2;

/**
 * How hard a lit window burns, as a multiple of {@link WINDOW_GLOW}. At 1 it
 * stayed under the bloom threshold of `post.ts` once exposed, and a lit tower
 * read as painted yellow rather than lit.
 */
const WINDOW_GAIN = 2.5;

/** Glass by day: dark, and darker still where it faces away from the sky. */
const GLAZING = 0x2a3338;

/** The dark of every outline (spec section 10.1). */
const OUTLINE = 0x150f12;

/** Roofs and trim, which are the same felt and concrete whatever stands under them. */
const ROOF = 0x4a4742;
const TRIM = 0xb9b4a8;

/** The materials a world's buildings are drawn with, and the night they share. */
export interface BuildingMaterials {
  /** The generated towers and mid-rise blocks. */
  facade: MeshStandardNodeMaterial;
  /** Everything built as boxes: houses, shop rows, warehouses, roadhouses. */
  block: MeshStandardNodeMaterial;
  /** The inverted hulls that outline both. */
  outline: MeshBasicNodeMaterial;
  /** How far into the night it is, 0 by day and 1 at midnight. */
  night: { value: number };
  dispose(): void;
}

/**
 * Build the three materials every chunk of a world shares. All three are cut
 * where a building hides the player (`cutaway.ts`).
 */
export function createBuildingMaterials(cutaway: BuildingCutaway): BuildingMaterials {
  const night = uniform(0);
  const facade = createFacadeMaterial(night);
  const block = createBlockMaterial(night);
  const outline = new MeshBasicNodeMaterial({ color: new Color(OUTLINE), side: BackSide, fog: true });
  cutaway.dressShell(facade);
  cutaway.dressShell(block);
  cutaway.dressOutline(outline);
  return {
    facade,
    block,
    outline,
    night,
    dispose(): void {
      facade.dispose();
      block.dispose();
      outline.dispose();
    },
  };
}

/**
 * The generator's own facade material, dressed with each building's colour and
 * given the night. The colour comes off the geometry rather than from a uniform,
 * which is what lets one material dress a whole city: `building-mesh.ts` writes
 * the palette pick of every tower into its vertices.
 */
function createFacadeMaterial(night: TslNode): MeshStandardNodeMaterial {
  const material = createSkyscraperMaterial(attribute('tint', 'vec3')) as MeshStandardNodeMaterial;
  const partId = attribute('partId', 'float');
  const glass = is(partId, FACADE_GLASS).add(is(partId, FACADE_SHOPGLASS));
  // A whole storey lights up at once. A window of the generator's is a pane of
  // its own, so lighting them one by one would need the bay each stands in, and
  // a floor read off the world height is exact wherever the pane is cut.
  const storey = vec3(
    positionWorld.x.div(40).floor(),
    positionWorld.y.div(STOREY).floor(),
    positionWorld.z.div(40).floor(),
  );
  material.emissiveNode = rgb(WINDOW_GLOW).mul(WINDOW_GAIN).mul(glass).mul(lit(storey)).mul(night);
  return material;
}

/**
 * The material every building that is not generated is drawn with. The `part`
 * attribute tells the walls, the roof, the trim and the glazing apart, and the
 * `uv` of a band of glazing is metres along the wall, so the windows are the
 * same width on a house and on a warehouse.
 */
function createBlockMaterial(night: TslNode): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ metalness: 0 });
  const part = attribute('part', 'float');
  const tint = attribute('tint', 'vec3');
  const grain = noise01(GRAIN_METRES, 3);
  const patch = noise01(PATCH_METRES, 2);

  // Which window a fragment stands in, and how far across it: the pane grid is
  // measured from the corner the band starts at, so it never straddles a window.
  const along = uv().x;
  const pane = along.div(WINDOW_PITCH).fract();
  const share = MULLION / WINDOW_PITCH;
  const glazed = step(share, pane).mul(float(1).sub(step(float(1).sub(share), pane)));

  const wall = tint.mul(float(0.78).add(patch.mul(0.28)).add(grain.mul(0.16)));
  const glass = mix(rgb(TRIM).mul(0.7), rgb(GLAZING), glazed);
  const surface = mix(wall, rgb(ROOF).mul(float(0.85).add(grain.mul(0.3))), is(part, BLOCK_ROOF));
  const trimmed = mix(surface, rgb(TRIM).mul(float(0.86).add(grain.mul(0.22))), is(part, BLOCK_TRIM));
  material.colorNode = mix(trimmed, glass, is(part, BLOCK_GLASS));

  // A window is lit pane by pane here, because the pane grid is exact.
  const window = vec3(
    along.div(WINDOW_PITCH).floor(),
    positionWorld.y.div(STOREY).floor(),
    positionWorld.x.add(positionWorld.z).div(30).floor(),
  );
  material.emissiveNode = rgb(WINDOW_GLOW).mul(WINDOW_GAIN).mul(is(part, BLOCK_GLASS)).mul(glazed).mul(lit(window)).mul(night);
  // Render and brick are rough; glass and painted trim are not.
  material.roughnessNode = mix(float(0.92).sub(grain.mul(0.12)), float(0.18), is(part, BLOCK_GLASS));
  return material;
}

/** 1 where a part attribute carries exactly `id`, 0 everywhere else. */
function is(part: TslNode, id: number): TslNode {
  return step(id - 0.5, part).mul(float(1).sub(step(id + 0.5, part)));
}

/** Which cells of a grid have their light on: a little under half of them. */
function lit(cell: TslNode): TslNode {
  return smoothstep(LIT_SHARE - 0.08, LIT_SHARE + 0.08, fractalNoise(cell.mul(0.37), 1).mul(0.5).add(0.5));
}

/** A colour constant in the working colour space, as a shader node. */
function rgb(hex: number): TslNode {
  const colour = new Color(hex);
  return vec3(colour.r, colour.g, colour.b);
}

/**
 * Fractal noise over the world, in 0..1. The place is the world one, so the
 * grain does not move with the mesh it is drawn on and two walls of one street
 * are not weathered identically.
 */
function noise01(metres: number, octaves: number): TslNode {
  const place = vec3(positionWorld.x.div(metres), positionWorld.y.div(metres), positionWorld.z.div(metres));
  return fractalNoise(place, octaves).mul(0.5).add(0.5);
}
