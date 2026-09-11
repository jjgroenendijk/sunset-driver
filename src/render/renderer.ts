import { WebGPURenderer } from 'three/webgpu';

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
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  return renderer;
}
