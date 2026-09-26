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
import { lut3D as lut3DNode } from 'three/examples/jsm/tsl/display/Lut3DNode.js';
import { smaa as smaaNode } from 'three/examples/jsm/tsl/display/SMAANode.js';
import type { Camera, Matrix4, Object3D, Scene, Texture, Vector3 } from 'three';
import * as tsl from 'three/tsl';

/**
 * An expression in a shader graph. Deliberately `any`: the shader type is not a
 * TypeScript type, and every operator on a node returns another node.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- the name documents a shader node
export type TslNode = any;

/** A per-vertex attribute of the geometry, by name and shader type. */
export const attribute = tsl.attribute as unknown as (name: string, type: string) => TslNode;

/** A constant, or another node read as a single float. */
export const float = tsl.float as unknown as (value: number | TslNode) => TslNode;

/** A constant, or another node read as a single whole number. */
export const int = tsl.int as unknown as (value: number | TslNode) => TslNode;

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

/** The larger of two numbers. */
export const max = tsl.max as unknown as (a: number | TslNode, b: number | TslNode) => TslNode;

/** A number held between `low` and `high`, at either edge where it passes them. */
export const clamp = tsl.clamp as unknown as (
  x: TslNode,
  low: number | TslNode,
  high: number | TslNode,
) => TslNode;

/** The natural logarithm. */
export const log = tsl.log as unknown as (x: TslNode) => TslNode;

/** The whole part of a number, towards minus infinity. */
export const floor = tsl.floor as unknown as (x: TslNode) => TslNode;

/** What is left of a number once its whole part is taken away, always in 0..1. */
export const fract = tsl.fract as unknown as (x: TslNode) => TslNode;

/**
 * A value the material reads every frame rather than at build time. Assigning
 * to `.value` changes what every mesh drawn with that material sees.
 */
export const uniform = tsl.uniform as unknown as (value: number) => { value: number } & TslNode;

/**
 * The group a uniform is sent in once a render rather than once an object. A
 * light's uniforms go here: they are the same for every mesh it reaches.
 */
export const renderGroup: TslNode = tsl.renderGroup;

/**
 * Run the nodes `body` builds only where `condition` holds. The shader branches
 * rather than blending, so a fragment that fails the test does none of the work.
 */
export const If = tsl.If as unknown as (condition: TslNode, body: () => void) => TslNode;

/** The brightness of a linear colour, as the eye weighs its three channels. */
export const luminance = tsl.luminance as unknown as (colour: TslNode) => TslNode;

/** The texture coordinates of the geometry. The game measures them in metres. */
export const uv = tsl.uv as unknown as () => TslNode;

/** The fragment's place in world space. */
export const positionWorld: TslNode = tsl.positionWorld;

/** The fragment's place in front of the camera, before projection. */
export const positionView: TslNode = tsl.positionView;

/** The fragment's surface normal in world space. */
export const normalWorld: TslNode = tsl.normalWorld;

/** The time the frame is drawn at, in seconds. */
export const time: TslNode = tsl.time;

/** Where the camera stands, in world space. */
export const cameraPosition: TslNode = tsl.cameraPosition;

/**
 * A texture as a node a material samples. The value returned carries `sample`,
 * which reads the texture at a place and answers a colour node.
 */
export const texture = tsl.texture as unknown as (map: Texture) => { sample(at: TslNode): TslNode } & TslNode;

/**
 * A flat mirror of the scene, as a node the material reads the mirror's picture
 * from. The `reflector` under it is what renders that picture; its
 * `resolutionScale` is read every frame, so it can be written at any time. The
 * `target` is the object the mirror takes its plane from, and belongs in the
 * scene graph of the surface that mirrors.
 *
 * `getVirtualCamera` answers the camera the mirror renders with, cloned from
 * the camera it is asked for and kept. It is called again every frame, so a
 * caller that wants to steer that camera wraps it rather than calling it once:
 * the game renders with more than one camera, and each gets its own clone.
 */
export const reflector = tsl.reflector as unknown as () => {
  uvNode: TslNode;
  rgb: TslNode;
  reflector: { resolutionScale: number; getVirtualCamera(camera: Camera): Camera };
  target: Object3D;
} & TslNode;

/**
 * The fragment's place on the window, in whole pixels. A pattern taken from it
 * stands still on the screen rather than on the surface, which is what a dither
 * needs (spec section 9.2).
 */
export const screenCoordinate: TslNode = tsl.screenCoordinate;

/**
 * The fragment's place on the window as a share of it, 0 to 1 across whichever
 * target the frame is being drawn into. Unlike `screenCoordinate` it names the
 * same place on the picture whatever resolution that target is drawn at.
 */
export const screenUV: TslNode = tsl.screenUV;

/**
 * What the target holds under the fragment, read at `at` (a share of the
 * target, as {@link screenUV}). The target is copied once each time a material
 * that reads it is drawn, and only then: the heat haze of `puff-material.ts`
 * is the one caller, so a frame with no fire copies nothing.
 */
export const viewportSharedTexture = tsl.viewportSharedTexture as unknown as (at?: TslNode) => TslNode;

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

/**
 * A 3D texture as a node an effect can read. The grade's cube is the only
 * texture the game holds, and `lut3D` wants it in this form rather than raw.
 */
export const texture3D = tsl.texture3D as unknown as (map: Texture) => TslNode;

/**
 * A colour looked up in a cube of colours: `size` is the cube's side, and
 * `intensity` how much of the answer is kept, 1 being all of it.
 */
export const lut3D = lut3DNode as unknown as (
  colour: TslNode,
  lut: TslNode,
  size: number,
  intensity: number,
) => TslNode;

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
  strength?: number | TslNode,
  radius?: number,
  threshold?: number,
) => TslNode;

/** Subpixel morphological antialiasing. It wants linear colour, not encoded. */
export const smaa = smaaNode as unknown as (colour: TslNode) => TslNode;


// The crowd of spec section 13.1: a skinned body drawn instanced, its bones read from a texture.

/** A shader function: the body builds nodes, and may assign to the vertex's own values. */
export const Fn = tsl.Fn as unknown as (body: () => TslNode) => () => TslNode;

/** One texel of a texture, by whole column and row, with no filtering. */
export const textureLoad = tsl.textureLoad as unknown as (map: Texture, at: TslNode) => TslNode;

/** Two whole numbers, most often a texel's column and row. */
export const ivec2 = tsl.ivec2 as unknown as (x: number | TslNode, y?: number | TslNode) => TslNode;

/** The vertex's place and normal as the geometry holds them, before anything moves them. */
export const positionGeometry: TslNode = tsl.positionGeometry;
export const normalGeometry: TslNode = tsl.normalGeometry;

/** The vertex's normal in the object's frame, which the lighting reads; assignable in the vertex stage. */
export const normalLocal: TslNode = tsl.normalLocal;

/** Sine and cosine of an angle in radians. */
export const sin = tsl.sin as unknown as (x: TslNode) => TslNode;
export const cos = tsl.cos as unknown as (x: TslNode) => TslNode;

/**
 * What a lighting model reads (`cel.ts`): the shaded normal in view space, the
 * material's diffuse colour, and the Lambert term that turns light into colour.
 */
export const normalView: TslNode = tsl.normalView;
export const diffuseColor: TslNode = tsl.diffuseColor;
export const BRDF_Lambert = tsl.BRDF_Lambert as unknown as (input: { diffuseColor: TslNode }) => TslNode;

/**
 * What the edge pass of `edges.ts` reads the depth with: the view-space z of a
 * perspective depth, a view-space position from a screen place and a depth,
 * the size of the drawing buffer in pixels, and a matrix held by reference.
 */
export const perspectiveDepthToViewZ = tsl.perspectiveDepthToViewZ as unknown as (
  depth: TslNode,
  near: TslNode,
  far: TslNode,
) => TslNode;
export const getViewPosition = tsl.getViewPosition as unknown as (
  screen: TslNode,
  depth: TslNode,
  projectionInverse: TslNode,
) => TslNode;
export const screenSize: TslNode = tsl.screenSize;
export const uniformMatrix = tsl.uniform as unknown as (matrix: Matrix4) => TslNode;
/**
 * A vector uniform: writing `value` changes every shader that reads it, and
 * compiles nothing. Hold a colour in one as its linear channels. A `Color`
 * handed to `uniform` is converted as if it were sRGB, so a dark colour comes
 * out several times too bright; only black and a pure primary survive it.
 */
export const uniformVector = tsl.uniform as unknown as (vector: Vector3) => { value: Vector3 } & TslNode;
