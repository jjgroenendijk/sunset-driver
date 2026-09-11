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
import { createVehicleState, DEFAULT_CLASS, rideHeight, specOf, VEHICLE_CLASSES } from '../sim/vehicle.ts';
import { generateWorld } from '../world/world.ts';
import { FollowCamera } from './camera.ts';
import { tickAtHour } from './daylight.ts';
import { PostChain } from './post.ts';
import { FULL_TIER, QUALITY_TIERS } from './quality.ts';
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
  /** The hour of the day to light the frame at, 0 to 24 (spec section 10.5). */
  hour: number;
  /**
   * The quality tier to draw at, by name (spec section 9.2). Left out, the
   * frame is the game at full quality; named, it is what a machine that
   * cannot hold the frame ends up looking at.
   */
  quality?: string;
  /**
   * The class of vehicle to stand the player in, by name (spec section 11.3).
   * Left out, or named something the roster does not hold, it is the class a
   * session starts in.
   */
  vehicle?: string;
}

/** The picture, and what the frame cost to build. */
export interface PreviewResult {
  width: number;
  height: number;
  /** The rows, top row first, three bytes a pixel, base64 encoded. */
  rgb: string;
  /** Milliseconds spent generating the world. */
  worldMs: number;
  /** Milliseconds spent building the chunks around the player. */
  chunkMs: number;
  /** Milliseconds spent drawing and reading back the frame. */
  frameMs: number;
  /** Draw calls the dearest chunk built costs: ground, roads and buildings. */
  peakDrawCalls: number;
  /** Lights the scene holds: the sun, the sky fill and the street lamp pool. */
  lights: number;
  /** Shadow maps the sun is split into (spec section 10.5). */
  shadows: number;
  /** The quality tier the frame was drawn at (spec section 9.2). */
  quality: string;
}

/** Bytes a pixel of the render target below. */
const BYTES_PER_PIXEL = 4;

/** Every row of a WebGPU readback starts on a multiple of this many bytes. */
const ROW_ALIGNMENT = 256;

export async function renderPreview(request: PreviewRequest): Promise<PreviewResult> {
  const { seed, x, y, distance, heading, speed, width, height, hour } = request;
  const tier = QUALITY_TIERS.find((entry) => entry.name === request.quality) ?? FULL_TIER;

  const t0 = performance.now();
  const world = generateWorld(seed);
  const worldMs = performance.now() - t0;

  const t1 = performance.now();
  const tick = tickAtHour(hour);
  const scene = new WorldScene(world, DEFAULT_APPEARANCE);
  // The tier is set before anything is built, so the chunks the picture holds
  // are the ones that tier asks for and are thinned as it asks.
  scene.quality = tier;
  scene.time = tick;
  // The chunks are built in the workers the game uses, so the picture is the
  // frame the game draws. Every chunk of both rings is waited for, so the same
  // request twice takes the same picture.
  await scene.settle(x, y);
  // Where the player stands decides which lamps burn and where the sky dome is.
  scene.look(x, y);
  const chunkMs = performance.now() - t1;

  // The player is in their vehicle, on the ground the roads left, as in the
  // game. `--vehicle` is how a class of the roster is looked at (spec section
  // 11.3); a boat is stood on the waterline rather than on the ground.
  const ground = scene.heightAt(x, y);
  const spec = specOf(VEHICLE_CLASSES.find((cls) => cls === request.vehicle) ?? DEFAULT_CLASS);
  const rest = spec.hull === undefined ? ground : Math.max(ground, world.water.seaLevel);
  scene.character.group.position.set(x, ground, y);
  scene.character.group.rotation.y = -heading;
  scene.vehicle.set(createVehicleState(spec, x, y, rest + rideHeight(spec), heading));

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
  // The effects of spec section 10.6 are part of what the game draws, so the
  // picture is taken through them. The chain tone maps and encodes the frame
  // itself, which is what the output target is written with.
  const post = new PostChain(renderer, scene.scene, camera.camera, tier.post);
  post.time = tick;
  // SMAA's tables are decoded from data URLs, so a frame drawn before they
  // land is a different picture. The same request twice takes the same one.
  await post.ready();
  // `render` only submits the work; the readback below is what waits for it.
  post.render();
  const padded = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  const frameMs = performance.now() - t2;

  const peakDrawCalls = scene.drawCallsPerChunk;
  const lights = scene.lightCount;
  const shadows = scene.shadowCascades;
  const rgb = toRgb(padded as Uint8Array, width, height);
  post.dispose();
  target.dispose();
  scene.dispose();
  renderer.dispose();

  return { width, height, rgb, worldMs, chunkMs, frameMs, peakDrawCalls, lights, shadows, quality: tier.name };
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
