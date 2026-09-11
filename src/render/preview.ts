/**
 * One frame of the game, rendered off screen and handed back as pixels.
 *
 * `scripts/render-preview.ts` loads this in a headless browser, because the
 * renderer needs a real WebGPU device and there is no such device in Node.
 * `world-preview.ts` draws the world description; this draws what the game
 * draws. Everything that is awkward about taking that picture lives here:
 *
 * - A headless WebGPU canvas never reaches the compositor, so a screenshot of
 *   the page is blank. The picture is read back off a render target instead.
 * - A render target is not the screen, so tone mapping and the sRGB encode are
 *   skipped and the readback looks almost black. `setOutputRenderTarget` makes
 *   the target the output of the frame, so the output pass runs into it.
 * - WebGPU pads each row of a readback to a multiple of 256 bytes. The rows are
 *   unpadded below; a picture read without that step comes back sheared, which
 *   looks exactly like a broken mesh.
 */
import { RenderTarget, SRGBColorSpace, UnsignedByteType } from 'three';
import { DEFAULT_APPEARANCE } from '../sim/character.ts';
import { generateWorld } from '../world/world.ts';
import { FollowCamera } from './camera.ts';
import { createOffscreenRenderer } from './renderer.ts';
import { WorldScene } from './world-scene.ts';

/** Where to stand, how far back to look from, and how big a picture to take. */
export interface PreviewRequest {
  seed: number;
  x: number;
  y: number;
  /** Camera distance at rest, in metres. `BASE_DISTANCE` is what the game uses. */
  distance: number;
  /** Which way the player faces, in radians. The camera leads this direction. */
  heading: number;
  /** How fast the player moves, in metres per second. It pulls the camera back. */
  speed: number;
  width: number;
  height: number;
  /** Chunks each way of the player to build before the frame is drawn. */
  chunkRadius: number;
  /** How far into the night it is, 0 by day and 1 at midnight. */
  night: number;
}

/** The picture, and what the frame cost to build. */
export interface PreviewResult {
  width: number;
  height: number;
  /** The rows, top row first, three bytes a pixel, base64 encoded. */
  rgb: string;
  /** Milliseconds spent generating the world. */
  worldMs: number;
  /** Milliseconds spent building the chunks near the player. */
  chunkMs: number;
  /** Milliseconds spent drawing and reading back the frame. */
  frameMs: number;
  /** Draw calls the dearest chunk built costs: ground, roads and buildings. */
  peakDrawCalls: number;
}

/** Bytes a pixel of the render target below. */
const BYTES_PER_PIXEL = 4;

/** Every row of a WebGPU readback starts on a multiple of this many bytes. */
const ROW_ALIGNMENT = 256;

export async function renderPreview(request: PreviewRequest): Promise<PreviewResult> {
  const { seed, x, y, distance, heading, speed, width, height, chunkRadius, night } = request;

  const t0 = performance.now();
  const world = generateWorld(seed);
  const worldMs = performance.now() - t0;

  const t1 = performance.now();
  const scene = new WorldScene(world, DEFAULT_APPEARANCE);
  scene.night = night;
  scene.prime(x, y, chunkRadius);
  const chunkMs = performance.now() - t1;

  // The player stands on the ground the roads left, as it does in the game.
  const ground = scene.heightAt(x, y);
  scene.character.group.position.set(x, ground, y);
  scene.character.group.rotation.y = -heading;

  const camera = new FollowCamera(width / height);
  camera.setBaseDistance(distance);
  // The first update snaps the camera onto its target rather than easing in,
  // so one call is a settled frame and no render time has to be simulated.
  camera.update(0, { x, y, height: ground, heading, speed });

  const t2 = performance.now();
  const renderer = await createOffscreenRenderer(width, height);
  const target = new RenderTarget(width, height, { type: UnsignedByteType, colorSpace: SRGBColorSpace });
  // Not `setRenderTarget`: a target set as the output of the frame is what the
  // tone mapping and the colour space conversion are written into.
  renderer.setOutputRenderTarget(target);
  // `render` only submits the work; the readback below is what waits for it.
  renderer.render(scene.scene, camera.camera);
  const padded = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  const frameMs = performance.now() - t2;

  const peakDrawCalls = scene.drawCallsPerChunk;
  const rgb = toRgb(padded as Uint8Array, width, height);
  target.dispose();
  scene.dispose();
  renderer.dispose();

  return { width, height, rgb, worldMs, chunkMs, frameMs, peakDrawCalls };
}

/**
 * Drop the row padding and the alpha, and turn the picture the right way up.
 * A render target's first row is the bottom of the picture; a PNG's is the top.
 */
function toRgb(padded: Uint8Array, width: number, height: number): string {
  const stride = Math.ceil((width * BYTES_PER_PIXEL) / ROW_ALIGNMENT) * ROW_ALIGNMENT;
  const rgb = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const from = (height - 1 - row) * stride;
    const to = row * width * 3;
    for (let px = 0; px < width; px++) {
      rgb[to + px * 3] = padded[from + px * BYTES_PER_PIXEL] ?? 0;
      rgb[to + px * 3 + 1] = padded[from + px * BYTES_PER_PIXEL + 1] ?? 0;
      rgb[to + px * 3 + 2] = padded[from + px * BYTES_PER_PIXEL + 2] ?? 0;
    }
  }
  return base64(rgb);
}

/** Bytes per `btoa` call. A whole picture at once overflows the argument list. */
const BASE64_BLOCK = 0x8000;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_BLOCK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_BLOCK));
  }
  return btoa(binary);
}
