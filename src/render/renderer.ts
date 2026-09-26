import { NeutralToneMapping } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { clamp } from '../core/math.ts';
import { stopUploadingWith, uploadBatchesWith } from './streaming/batch.ts';
import { installCelShading } from './look/cel.ts';
import { PinnedClusterLighting } from './look/clustered-lights.ts';
import { registerLampLight } from './roads/lamp-light.ts';
import { registerNeonLight } from './signage/sign-light.ts';

/**
 * How much light reaches the film. The sky of `sky.ts` is the Preetham model,
 * which answers in real sky brightness, so the frame has to be tone mapped or
 * the daylight sky is a white sheet. Every light in the game is set against
 * this one number. At noon it brings a flat surface in the sun a little over
 * its own colour, which is the high key of `docs/art-style.md`. It was 0.56
 * while the previews encoded the frame twice and showed it far paler than the
 * game (issue #695); at 0.56 the game's noon was a dim, low-key frame.
 */
const EXPOSURE = 1.3;

/**
 * Tone mapping and the lighting system, set the same way wherever a renderer is
 * made (spec sections 10.5, 10.6).
 *
 * The tone map is the neutral one, which keeps a colour's hue and saturation
 * until it is near white. ACES washed the pale colours of the palette to white
 * and pulled them toward blue.
 *
 * The clustered lighting of spec section 10.5 partitions the view into a grid
 * and gives each fragment only the lights that reach it, which is what makes
 * dense night lighting affordable. `clustered-lights.ts` holds the grid still
 * across a render-scale change, which is what keeps a quality change from
 * rebuilding every shader in the city. three.js 0.186 clusters shadowless
 * point lights alone, so the projector cones of `lamps.ts` still go down the
 * default path today; the hard cap in that file and the branch of
 * `lamp-light.ts`, which skips a cone while it is off, keep them inside the
 * budget. The rect area lights of the neon (`sign-light.ts`) go down that same
 * path and branch the same way. With no point light in the scene, the
 * clustered path is not built at all.
 */
function configure(renderer: WebGPURenderer): void {
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  // Off by default on `WebGPURenderer`, and nothing else says so: without this
  // the sun's cascades are built and never drawn, and the city is flat.
  renderer.shadowMap.enabled = true;
  // Every lit material shades the sun in bands (`cel.ts`).
  installCelShading();
  registerLampLight(renderer);
  registerNeonLight(renderer);
}

/**
 * Give the renderer the clustered lighting, its grid pinned to the largest
 * buffer it will draw at: the page or picture at the full pixel ratio, before
 * any render scale. It is set after the size, because the pin is read from the
 * size the renderer has just been given.
 */
function pinClusterGrid(renderer: WebGPURenderer, width: number, height: number, pixelRatio: number): void {
  renderer.lighting = new PinnedClusterLighting(width * pixelRatio, height * pixelRatio);
}

/**
 * The lowest the quality tiers may take the render scale (spec section 9.2).
 * Half the pixels each way is a quarter of the frame's cost, and it is as far
 * down as a game read at a glance from 60 m can go and still show a kerb.
 */
export const MIN_RENDER_SCALE = 0.5;

/**
 * The densest a frame is drawn: one pixel per CSS pixel (issue #714).
 *
 * The GPU cost of a frame is per pixel. An M1 at 1600×900 and a pixel ratio of
 * 1 already spends most of the frame on the GPU, and at a Retina ratio of 2 the
 * frame took 50 ms. The tiers then fell all the way to the low one, which gives
 * up the plants, the lamps and the bloom as well as the pixels.
 */
const MAX_PIXEL_RATIO = 1;

/** The pixel ratio a page is drawn at by the full tier, before any render scale. */
export function basePixelRatioFor(devicePixelRatio: number): number {
  return Math.min(devicePixelRatio, MAX_PIXEL_RATIO);
}

/**
 * The pixel ratio each renderer was made at, before the render scale. A
 * renderer is told its ratio rather than asked for it, because asking would
 * compound: every step down would scale the step before it.
 */
const basePixelRatio = new WeakMap<WebGPURenderer, number>();

/** The render scale each renderer was last given, so a resize can apply it again. */
const renderScale = new WeakMap<WebGPURenderer, number>();

/**
 * Draw the frame at a fraction of the display's pixels (spec section 9.2).
 * This is the first quality-tier knob: everything the frame costs, the post
 * chain included, falls with the square of it, and the browser scales the
 * canvas back up.
 */
export function setRenderScale(renderer: WebGPURenderer, scale: number): void {
  const base = basePixelRatio.get(renderer) ?? 1;
  renderScale.set(renderer, scale);
  renderer.setPixelRatio(base * clamp(scale, MIN_RENDER_SCALE, 1));
}

/**
 * Size the page's renderer for a window of a new size. The base pixel ratio
 * is read again, since a window dragged to another screen changes it.
 */
export function resizeRenderer(renderer: WebGPURenderer, width: number, height: number): void {
  basePixelRatio.set(renderer, basePixelRatioFor(window.devicePixelRatio));
  setRenderScale(renderer, renderScale.get(renderer) ?? 1);
  renderer.setSize(width, height, false);
}

export type WebGpuProbe = { ok: true } | { ok: false; reason: string };

/** WebGPU only; there is no WebGL fallback. */
export async function probeWebGpu(): Promise<WebGpuProbe> {
  if (!('gpu' in navigator) || !navigator.gpu) return { ok: false, reason: 'WebGPU is not available in this browser.' };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { ok: false, reason: 'WebGPU is present but no adapter was returned.' };
  return { ok: true };
}

/**
 * Let three.js talk to a browser that has moved on from string swizzles.
 *
 * `GPUTextureViewDescriptor.swizzle` used to be a string. three.js 0.186 still
 * sets it to `'rgba'` on the descriptor it reuses for every `createView`, and
 * so does `@webgpu/types` 0.1.72. The WebGPU specification has since made the
 * field a `GPUTextureComponentSwizzle` dictionary, and a browser that follows
 * it type-checks the field whether or not the `texture-component-swizzle`
 * feature is on. There every `createView` throws and the game draws nothing.
 *
 * The field means nothing here — `'rgba'` is the identity swizzle, and no
 * material asks for another — so where the browser refuses the string it is
 * dropped. The first refusal is what says so, rather than a probe: a probe
 * needs a device of its own. Once three.js sends the dictionary no call reaches
 * the retry, and the shim can be deleted.
 */
function allowStringSwizzle(): void {
  const proto = GPUTexture.prototype as GPUTexture & { swizzleShimmed?: boolean };
  if (proto.swizzleShimmed === true) return;
  proto.swizzleShimmed = true;
  const createView = proto.createView;
  let strip = false;
  proto.createView = function (descriptor?: GPUTextureViewDescriptor): GPUTextureView {
    if (descriptor === undefined || typeof descriptor.swizzle !== 'string') {
      return createView.call(this, descriptor);
    }
    if (!strip) {
      try {
        return createView.call(this, descriptor);
      } catch (error) {
        // Only the type check is shimmed; anything else is the caller's fault.
        if (!(error instanceof TypeError)) throw error;
        strip = true;
      }
    }
    const rest: GPUTextureViewDescriptor = { ...descriptor };
    delete rest.swizzle;
    return createView.call(this, rest);
  };
}

/**
 * The renderer of the page. `trackTimestamp` asks for GPU timestamps around
 * every pass, which the profiler reads (`gpu-passes.ts`); the game leaves it
 * off, since every pass then carries two more writes.
 */
export async function createRenderer(canvas: HTMLCanvasElement, trackTimestamp = false): Promise<WebGPURenderer> {
  allowStringSwizzle();
  // No multisampling: SMAA in the post chain is what takes the edges down
  // (spec section 10.6), and paying for both would be paying twice.
  const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL: false, trackTimestamp });
  configure(renderer);
  await renderer.init();
  // The upload record exists from `init` on.
  uploadBatchesWith(renderer);
  const base = basePixelRatioFor(window.devicePixelRatio);
  basePixelRatio.set(renderer, base);
  setRenderScale(renderer, 1);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  pinClusterGrid(renderer, window.innerWidth, window.innerHeight, base);
  return renderer;
}

/**
 * A renderer that draws into a render target instead of onto a page.
 *
 * `scripts/render-preview.ts` uses it to take a picture of the game from a
 * session. A headless browser never puts a WebGPU canvas in front of the
 * compositor, so a screenshot of the page is blank whatever the flags; the
 * picture has to be read back off a render target. The swizzle shim above is
 * needed here for the same reason it is needed on the page.
 */
export async function createOffscreenRenderer(width: number, height: number): Promise<WebGPURenderer> {
  allowStringSwizzle();
  const renderer = new WebGPURenderer({ antialias: false, forceWebGL: false });
  configure(renderer);
  await renderer.init();
  uploadBatchesWith(renderer);
  basePixelRatio.set(renderer, 1);
  setRenderScale(renderer, 1);
  renderer.setSize(width, height, false);
  pinClusterGrid(renderer, width, height, 1);
  return renderer;
}

/**
 * Size an offscreen renderer for a picture of another size, as
 * {@link createOffscreenRenderer} sized it for the first.
 */
export function resizeOffscreenRenderer(renderer: WebGPURenderer, width: number, height: number): void {
  renderer.setSize(width, height, false);
  pinClusterGrid(renderer, width, height, 1);
}

/** Dispose a renderer, and make sure no batch built after it uploads into it. */
export function disposeRenderer(renderer: WebGPURenderer): void {
  stopUploadingWith(renderer);
  renderer.dispose();
}
