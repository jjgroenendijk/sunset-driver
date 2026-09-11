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
 * Add a door here when a material needs one. Do not import `three/tsl`
 * anywhere else.
 */
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
