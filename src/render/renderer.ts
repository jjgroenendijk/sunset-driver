import { WebGPURenderer } from 'three/webgpu';

export type WebGpuProbe = { ok: true } | { ok: false; reason: string };

/** WebGPU only; there is no WebGL fallback. */
export async function probeWebGpu(): Promise<WebGpuProbe> {
  if (!('gpu' in navigator) || !navigator.gpu) return { ok: false, reason: 'WebGPU is not available in this browser.' };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { ok: false, reason: 'WebGPU is present but no adapter was returned.' };
  return { ok: true };
}

export async function createRenderer(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
  const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL: false });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  return renderer;
}
