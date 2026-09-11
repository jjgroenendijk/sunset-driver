/**
 * The one loosely typed door onto TSL (spec Appendix A).
 *
 * `ShaderMaterial` and `onBeforeCompile` do not work on `WebGPURenderer`, so
 * custom shading is written as node graphs. A node carries a shader type
 * (`float`, `vec3`, …) rather than a TypeScript one, and the chained builders
 * return types `tsc` cannot reconcile: `attribute('tint', 'vec3').mul(2)` is
 * rejected even though it runs. Appendix A asks for one wrapper module rather
 * than casts spread through the renderer, so every TSL helper the game uses is
 * re-exported here and the looseness stops at this file.
 *
 * The post-processing nodes of spec section 10.6 are addons rather than part of
 * `three/tsl`, but they are node constructors of the same kind and they are
 * typed the same way, so they come through this door too.
 *
 * Add a door here when a material or the post chain needs one. Do not import
 * `three/tsl` anywhere else.
 */
import { bloom as bloomNode } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { smaa as smaaNode } from 'three/examples/jsm/tsl/display/SMAANode.js';
import type { Camera, Scene, Texture } from 'three';
import * as tsl from 'three/tsl';

/**
 * An expression in a shader graph. Deliberately `any`: the shader type is not a
 * TypeScript type, and every operator on a node returns another node.
 */
export type TslNode = any;

/** A per-vertex attribute of the geometry, by name and shader type. */
export const attribute = tsl.attribute as unknown as (name: string, type: string) => TslNode;

/** A constant, or another node read as a single float. */
export const float = tsl.float as unknown as (value: number | TslNode) => TslNode;

/** A constant colour or vector, or three nodes read as one. */
export const vec3 = tsl.vec3 as unknown as (
  x: number | TslNode,
  y?: number | TslNode,
  z?: number | TslNode,
) => TslNode;

/** A place on a texture, or two nodes read as one. */
export const vec2 = tsl.vec2 as unknown as (x: number | TslNode, y?: number | TslNode) => TslNode;

/** A colour with its alpha, most often a `vec3` and a one. */
export const vec4 = tsl.vec4 as unknown as (
  x: number | TslNode,
  y?: number | TslNode,
  z?: number | TslNode,
  w?: number | TslNode,
) => TslNode;

/** Linear blend: `a` where `t` is 0, `b` where it is 1. */
export const mix = tsl.mix as unknown as (a: TslNode, b: TslNode, t: number | TslNode) => TslNode;

/** 0 below `edge`, 1 at it and above. A hard boundary, where `smoothstep` gives a soft one. */
export const step = tsl.step as unknown as (edge: number | TslNode, x: TslNode) => TslNode;

/** 0 below `low`, 1 above `high`, smooth between. `low` must be below `high`. */
export const smoothstep = tsl.smoothstep as unknown as (
  low: number | TslNode,
  high: number | TslNode,
  x: TslNode,
) => TslNode;

/**
 * A value the material reads every frame rather than at build time. Assigning
 * to `.value` changes what every mesh drawn with that material sees.
 */
export const uniform = tsl.uniform as unknown as (value: number) => { value: number } & TslNode;

/** The texture coordinates of the geometry. The game measures them in metres. */
export const uv = tsl.uv as unknown as () => TslNode;

/** The fragment's place in world space. */
export const positionWorld: TslNode = tsl.positionWorld;

/** The fragment's surface normal in world space. */
export const normalWorld: TslNode = tsl.normalWorld;

/**
 * Fractal value noise in -1..1, summed over `octaves`. This is the runtime
 * texture of spec section 10.2: the build ships no image files, so every
 * surface detail is generated in the shader.
 */
export const fractalNoise = tsl.mx_fractal_noise_float as unknown as (
  position: TslNode,
  octaves?: number,
  lacunarity?: number,
  diminish?: number,
) => TslNode;

// The post chain of spec section 10.6. `post.ts` is the only caller.

/** The scene drawn into a texture, which is what every effect below reads. */
export const pass = tsl.pass as unknown as (scene: Scene, camera: Camera) => TslNode;

/** A texture, read at a place on it. The grade's table is the only one the game holds. */
export const texture = tsl.texture as unknown as (map: Texture, at?: TslNode) => TslNode;

/** Real light in, film in 0..1 out. The mapping is a `ToneMapping` constant. */
export const toneMapping = tsl.toneMapping as unknown as (
  mapping: number,
  exposure: number | TslNode,
  colour: TslNode,
) => TslNode;

/** The renderer's `toneMappingExposure`, read every frame rather than at build time. */
export const toneMappingExposure: TslNode = tsl.toneMappingExposure;

/** The last step of a frame: tone mapping, then the encode the display asks for. */
export const renderOutput = tsl.renderOutput as unknown as (
  colour: TslNode,
  mapping?: number,
  colourSpace?: string,
) => TslNode;

/** Spread the light of everything brighter than `threshold` (spec section 10.6). */
export const bloom = bloomNode as unknown as (
  colour: TslNode,
  strength?: number,
  radius?: number,
  threshold?: number,
) => TslNode;

/** Subpixel morphological antialiasing. It wants linear colour, not encoded. */
export const smaa = smaaNode as unknown as (colour: TslNode) => TslNode;

