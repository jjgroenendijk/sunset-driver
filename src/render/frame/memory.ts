/**
 * What the GPU holds, counted as the page asks for it.
 *
 * `scripts/render-profile.ts --memory` loads this with the profile. WebGPU
 * offers no query of how much memory a device holds, so the ledger wraps the
 * calls that allocate and free it: `createBuffer`, `createTexture` and their
 * `destroy`. It has to be installed before the renderer asks for its device, or
 * the buffers made at start are missed. A buffer or texture the page drops
 * without destroying stays counted, which is what the GPU does too until the
 * collector finds it.
 */
import type { BufferAttribute, BufferGeometry, Object3D } from 'three';

/** Bytes the GPU holds, by what they are for. */
export interface GpuMemory {
  vertex: number;
  index: number;
  /** Uniform, storage and staging buffers. */
  otherBuffers: number;
  textures: number;
  total: number;
}

/** Bytes a texel takes, by format. A format not listed is counted at four. */
const TEXEL_BYTES: Record<string, number> = {
  r8unorm: 1,
  rg8unorm: 2,
  r16float: 2,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  rg16float: 4,
  r32float: 4,
  rg11b10ufloat: 4,
  rgb10a2unorm: 4,
  depth16unorm: 2,
  depth24plus: 4,
  'depth24plus-stencil8': 4,
  depth32float: 4,
  'depth32float-stencil8': 5,
  rgba16float: 8,
  rg32float: 8,
  rgba32float: 16,
};

type Kind = 'vertex' | 'index' | 'otherBuffers' | 'textures';

/** The bytes and the kind of every buffer and texture alive. */
const alive = new WeakMap<object, { bytes: number; kind: Kind }>();
const standing: GpuMemory = { vertex: 0, index: 0, otherBuffers: 0, textures: 0, total: 0 };
let peak = 0;
let installed = false;

function count(object: object, bytes: number, kind: Kind): void {
  alive.set(object, { bytes, kind });
  standing[kind] += bytes;
  standing.total += bytes;
  peak = Math.max(peak, standing.total);
}

/** The ledger line a buffer counts on, by the usage it was made for. */
function bufferKind(usage: number): Kind {
  if ((usage & GPUBufferUsage.VERTEX) !== 0) return 'vertex';
  return (usage & GPUBufferUsage.INDEX) !== 0 ? 'index' : 'otherBuffers';
}

function forget(object: object): void {
  const entry = alive.get(object);
  if (entry === undefined) return;
  alive.delete(object);
  standing[entry.kind] -= entry.bytes;
  standing.total -= entry.bytes;
}

/** Bytes of a texture: every level of every layer, at its sample count. */
function textureBytes(descriptor: GPUTextureDescriptor): number {
  const size = descriptor.size as GPUExtent3DDict | number[];
  const [width, height, layers] = Array.isArray(size)
    ? [size[0] ?? 1, size[1] ?? 1, size[2] ?? 1]
    : [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1];
  const texel = TEXEL_BYTES[descriptor.format] ?? 4;
  const three = descriptor.dimension === '3d';
  let bytes = 0;
  for (let level = 0; level < (descriptor.mipLevelCount ?? 1); level++) {
    const w = Math.max(1, width >> level);
    const h = Math.max(1, height >> level);
    const d = three ? Math.max(1, layers >> level) : layers;
    bytes += w * h * d * texel;
  }
  return bytes * (descriptor.sampleCount ?? 1);
}

/** Start counting. Call before the renderer asks for its device. */
export function installGpuLedger(): void {
  if (installed) return;
  installed = true;
  const device = GPUDevice.prototype;
  const createBuffer = device.createBuffer;
  device.createBuffer = function (this: GPUDevice, descriptor: GPUBufferDescriptor): GPUBuffer {
    const buffer = createBuffer.call(this, descriptor);
    const usage = descriptor.usage;
    count(buffer, descriptor.size, bufferKind(usage));
    return buffer;
  };
  const createTexture = device.createTexture;
  device.createTexture = function (this: GPUDevice, descriptor: GPUTextureDescriptor): GPUTexture {
    const texture = createTexture.call(this, descriptor);
    count(texture, textureBytes(descriptor), 'textures');
    return texture;
  };
  for (const prototype of [GPUBuffer.prototype, GPUTexture.prototype] as { destroy(): void }[]) {
    const destroy = prototype.destroy;
    prototype.destroy = function (this: object): void {
      forget(this);
      destroy.call(this);
    };
  }
}

/** What the GPU holds now. */
export function gpuMemory(): GpuMemory {
  return { ...standing };
}

/** The most the GPU has held since the last call, which starts the next watch at what it holds now. */
export function gpuPeak(): number {
  const most = peak;
  peak = standing.total;
  return most;
}

/**
 * Bytes of typed arrays the scene's geometry still holds in the page. An array
 * two attributes share is counted once.
 */
export function geometryBytes(root: Object3D): number {
  const seen = new Set<ArrayBufferLike>();
  let bytes = 0;
  const add = (array: ArrayBufferView | undefined): void => {
    if (array === undefined || seen.has(array.buffer)) return;
    seen.add(array.buffer);
    bytes += array.buffer.byteLength;
  };
  root.traverse((object) => {
    const geometry = (object as { geometry?: BufferGeometry }).geometry;
    if (geometry === undefined) return;
    for (const name in geometry.attributes) add((geometry.attributes[name] as BufferAttribute).array);
    add(geometry.getIndex()?.array);
  });
  return bytes;
}
