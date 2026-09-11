import { ACESFilmicToneMapping } from 'three';
import { ClusteredLighting } from 'three/examples/jsm/lighting/ClusteredLighting.js';
import { WebGPURenderer } from 'three/webgpu';

/**
 * How much light reaches the film. The sky of `sky.ts` is the Preetham model,
 * which answers in real sky brightness, so the frame has to be tone mapped or
 * the daylight sky is a white sheet. Every light in the game is set against
 * this one number.
 */
const EXPOSURE = 0.62;

/**
 * Tone mapping and the lighting system, set the same way wherever a renderer is
 * made (spec sections 10.5, 10.6).
 *
 * The clustered lighting of spec section 10.5 partitions the view into a grid
 * and gives each fragment only the lights that reach it, which is what makes
 * dense night lighting affordable. three.js 0.186 clusters shadowless point
 * lights alone, so the projector cones of `lamps.ts` still go down the default
 * path today; the hard cap in that file is what keeps them inside the budget,
 * and the neon and headlights that come later land in the cluster grid.
 */
function configure(renderer: WebGPURenderer): void {
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  // Off by default on `WebGPURenderer`, and nothing else says so: without this
  // the sun's cascades are built and never drawn, and the city is flat.
  renderer.shadowMap.enabled = true;
  renderer.lighting = new ClusteredLighting();
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
    const { swizzle: _swizzle, ...rest } = descriptor;
    return createView.call(this, rest);
  };
}

export async function createRenderer(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
  allowStringSwizzle();
  const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL: false });
  configure(renderer);
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
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
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  return renderer;
}
