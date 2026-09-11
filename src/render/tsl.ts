/**
 * The one loosely typed door onto TSL (spec Appendix A).
 *
 * `ShaderMaterial` and `onBeforeCompile` do nothing on `WebGPURenderer`, so
 * every custom material in this project is a node material and every shader
 * expression is TSL. TSL's own types do not survive chained maths: an
 * expression that runs perfectly well fails `tsc` a few links in. Appendix A's
 * answer is to keep that looseness in one place rather than to weaken the
 * typecheck everywhere, so this module is the only place in `src/` that says
 * `any`, and everything downstream is typed as usual.
 *
 * Add a helper here as a material needs it. Nothing else should import
 * `three/tsl` directly.
 */
import * as tsl from 'three/tsl';

/**
 * One node of a shader graph. The real type is a large union the compiler
 * cannot follow through `.mul().add().clamp()`, so it stops here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the note above
export type TslNode = any;

/** A TSL helper: nodes and plain numbers in, a node out. */
type TslFn = (...args: TslNode[]) => TslNode;

const lib = tsl as unknown as Record<string, TslNode>;

/** A constant, a two-vector and a three-vector. */
export const float = lib.float as TslFn;
export const vec2 = lib.vec2 as TslFn;
export const vec3 = lib.vec3 as TslFn;

/** A vertex attribute of the geometry, by name and type. */
export const attribute = lib.attribute as TslFn;

/** Where the fragment stands, in world metres. */
export const positionWorld = lib.positionWorld as TslNode;

/** Linear blend and a smooth step, for mixing colours and masking. */
export const mix = lib.mix as TslFn;
export const smoothstep = lib.smoothstep as TslFn;

/**
 * Runtime noise, which is how spec section 10.2 gets surface richness with no
 * binary assets: one octave for a patch, several for grain.
 */
export const noise = lib.mx_noise_float as TslFn;
export const fractalNoise = lib.mx_fractal_noise_float as TslFn;
