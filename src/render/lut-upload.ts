/**
 * Get the colour grade's cube to the GPU in one copy.
 *
 * three.js 0.186 uploads a `Data3DTexture` one slice at a time: sixteen writes
 * of a 16x16x1 region into a 16-cube. Each of those is a partial write, and a
 * partial write of a texture the renderer also declared a render attachment
 * makes the driver clear the rest of it first. Some Dawn builds clear a 3D
 * texture through 2D views, which WebGPU refuses, so every slice is dropped
 * with a validation error and the cube keeps the zeros it was allocated with.
 * A frame looked up in a cube of zeros is black in every pixel.
 *
 * It is the family of the mipmap trap in `CLAUDE.md` — three.js reaching a 3D
 * texture through 2D views — on a different path: this one is the upload
 * itself, and `generateMipmaps` is already off.
 *
 * The fix is to write the whole cube at once. A write that covers the texture
 * needs no clear before it, so nothing builds a view of anything. The renderer
 * still allocates the texture; `Source.dataReady` set to false is what tells it
 * to allocate and transfer nothing, leaving the transfer here.
 *
 * The refusal follows the browser build rather than the code — the same commit
 * draws the city on one Chromium and a black rectangle on another — so a
 * browser that shows no error is not evidence the slice-by-slice upload is
 * sound.
 */
import type { Data3DTexture, Texture } from 'three';

/** Bytes one entry of the cube takes on the GPU: four channels of half float. */
const BYTES_PER_TEXEL = 8;

/**
 * The part of a `WebGPURenderer` the upload needs. three.js types its backend
 * as the abstract base, which names neither the device nor the map from a
 * texture to the `GPUTexture` the backend made for it.
 */
interface LutBackend {
  device?: GPUDevice;
  get(object: object): { texture?: GPUTexture } | undefined;
}

/** The part of a `WebGPURenderer` this file uses, so a test can stand in for one. */
export interface LutRenderer {
  backend: unknown;
  initTexture(texture: Texture): void;
}

/**
 * Write the cube to the GPU. Returns false when there was nowhere to write it:
 * no WebGPU device, or a backend that made no texture for it. A caller that
 * gets false must stop grading rather than look the frame up in a cube that
 * never arrived.
 */
export function uploadLut(renderer: LutRenderer, lut: Data3DTexture): boolean {
  const backend = renderer.backend as LutBackend | undefined;
  const device = backend?.device;
  if (backend === undefined || device === undefined) return false;

  // The texture is allocated on first use, which is a frame away. Asking for it
  // here is what makes the first frame drawn a graded one.
  try {
    renderer.initTexture(lut);
  } catch {
    return false;
  }
  const texture = backend.get(lut)?.texture;
  if (texture === undefined) return false;

  const { width, height, depth } = lut.image;
  device.queue.writeTexture(
    { texture },
    lut.image.data as ArrayBufferView,
    { bytesPerRow: width * BYTES_PER_TEXEL, rowsPerImage: height },
    { width, height, depthOrArrayLayers: depth },
  );
  return true;
}
