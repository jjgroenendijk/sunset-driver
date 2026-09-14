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
import {
  createDamageState,
  explode,
  FUSE_TICKS,
  ignite,
  PANELS,
  type DamageStage,
  type DamageState,
} from '../sim/damage.ts';
import { createPlayerState, exitPlace } from '../sim/on-foot.ts';
import type { PickupState } from '../sim/pickup.ts';
import { createSimState } from '../sim/simulation.ts';
import { ParkedCars } from '../sim/parked.ts';
import { AmbientTraffic, trafficRoadsOf } from '../sim/traffic.ts';
import {
  ATTACHMENTS,
  createLoadout,
  fitAttachment,
  giveWeapon,
  normaliseAttachments,
  WEAPON_IDS,
  weaponOf,
  type Attachment,
} from '../sim/weapon.ts';
import {
  createVehicleState,
  DEFAULT_CLASS,
  rideHeight,
  specOf,
  VEHICLE_CLASSES,
  type VehicleSpec,
  type VehicleState,
} from '../sim/vehicle.ts';
import { generateWorld } from '../world/world.ts';
import { FollowCamera } from './camera.ts';
import { tickAtHour } from './daylight.ts';
import { PostChain } from './post.ts';
import { FULL_TIER, QUALITY_TIERS } from './quality.ts';
import { createOffscreenRenderer } from './renderer.ts';
import { ParkedView } from './parked.ts';
import { TrafficView } from './traffic.ts';
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
  /**
   * Set to stand the player beside their vehicle rather than in it, which is
   * how the character of spec sections 11.1 and 11.5 is looked at.
   */
  onFoot?: boolean;
  /**
   * The damage state to show the vehicle in, by name (spec section 11.3):
   * `dented`, `smoking`, `burning` or `burnt`. Left out, the vehicle is
   * straight out of the showroom.
   */
  damage?: string;
  /**
   * Set to lay a drift's worth of skid marks into the road behind the vehicle
   * (spec section 11.3), which is the one way to look at them in a still frame.
   */
  skid?: boolean;
  /**
   * The weapon to put in the player's hands, by id (spec section 11.6). It is
   * drawn only with {@link PreviewRequest.onFoot}, as in the game.
   */
  weapon?: string;
  /** The attachments to fit to that weapon and to the pickups, by name. */
  attachments?: string[];
  /** Set to hold the weapon at the shoulder rather than at the hip. */
  aim?: boolean;
  /**
   * Set to lay every weapon of the arsenal on the ground ahead of the player as
   * a pickup, in rows, which is how the silhouettes are compared.
   */
  pickups?: boolean;
  /** The index of the laid pickup to draw as the one under the mouse, grown to its full hover size. */
  hover?: number;
}

/** Metres between two pickups `--pickups` lays, and how many lie in a row. */
const PICKUP_GRID = 3;
const PICKUP_ROW = 8;

/** Ticks of smoke and flame let into the air before the picture is taken. */
const FX_WARMUP = 240;

/** Metres of drift `--skid` lays, and the radius it curves through. */
const DRIFT_LENGTH = 24;
const DRIFT_RADIUS = 18;

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
  /** Vehicles of the traffic drawn round the player (spec section 13.1). */
  traffic: number;
  /** Parked cars drawn round the player (spec section 13.1). */
  parked: number;
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
  // 11.3); a boat is stood on the waterline rather than on the ground. With
  // `--on-foot` they stand beside it instead, where stepping out leaves them
  // (spec section 11.5), and the character model is what the picture shows.
  const ground = scene.heightAt(x, y);
  const spec = specOf(VEHICLE_CLASSES.find((cls) => cls === request.vehicle) ?? DEFAULT_CLASS);
  const rest = spec.hull === undefined ? ground : Math.max(ground, world.water.seaLevel);
  const vehicle = createVehicleState(spec, x, y, rest + rideHeight(spec), heading);
  if (request.damage !== undefined) vehicle.damage = damageAt(request.damage, tick);
  const stand = request.onFoot === true ? exitPlace(vehicle, spec) : { x, y, heading };
  scene.character.group.position.set(stand.x, scene.heightAt(stand.x, stand.y), stand.y);
  scene.character.group.rotation.y = -stand.heading;
  scene.character.group.visible = request.onFoot === true;
  scene.vehicle.set(vehicle);
  // A fire is what has been burning for a while, not what started this frame,
  // so the smoke is given a run of ticks to climb before the picture is taken.
  scene.resetDamage(tick - FX_WARMUP);
  for (let t = tick - FX_WARMUP; t <= tick; t++) scene.damage(vehicle, seed, t);
  if (request.skid === true) drift(scene, vehicle, spec, heading);
  arm(scene, request, stand, tick);
  // The traffic of spec section 13.1, where its tours put it at the tick the
  // picture is taken, as the game draws it.
  const traffic = new TrafficView(new AmbientTraffic(seed, trafficRoadsOf(world)));
  scene.scene.add(traffic.group);
  const record = createSimState(seed, undefined, tick);
  traffic.update(record, tick, x, y);
  // The parked cars, from the bays the chunk workers laid out.
  const parked = scene.bays === undefined ? undefined : new ParkedView(new ParkedCars(seed, scene.bays));
  if (parked !== undefined) scene.scene.add(parked.group);
  parked?.update(record, x, y);

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
  post.render();
  const padded = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  const frameMs = performance.now() - t2;

  const peakDrawCalls = scene.drawCallsPerChunk;
  const lights = scene.lightCount;
  const shadows = scene.shadowCascades;
  const rgb = toRgb(padded as Uint8Array, width, height);
  post.dispose();
  target.dispose();
  const drawn = traffic.drawn;
  const standing = parked?.drawn ?? 0;
  traffic.dispose();
  parked?.dispose();
  scene.dispose();
  renderer.dispose();

  return { width, height, rgb, worldMs, chunkMs, frameMs, peakDrawCalls, lights, shadows, quality: tier.name, traffic: drawn, parked: standing };
}

/**
 * The weapons of spec section 11.6, for the preview alone: the one in the
 * player's hands, and with `--pickups` every weapon of the arsenal lying in
 * rows ahead of them.
 */
function arm(scene: WorldScene, request: PreviewRequest, stand: { x: number; y: number; heading: number }, tick: number): void {
  const attachments = ATTACHMENTS.filter((name: Attachment) => request.attachments?.includes(name) === true);
  const loadout = createLoadout();
  const weapon = WEAPON_IDS.find((id) => id === request.weapon);
  if (weapon !== undefined) {
    giveWeapon(loadout, weapon);
    for (const attachment of attachments) fitAttachment(loadout, weapon, attachment);
  }
  loadout.aiming = request.aim === true;
  const player = createPlayerState();
  player.driving = request.onFoot !== true;
  const ground = scene.heightAt(stand.x, stand.y);
  scene.held.set(loadout, player, { ...stand, height: ground }, scene.character.height);
  if (request.pickups !== true) return;
  const laid: PickupState[] = WEAPON_IDS.filter((id) => id !== 'fists').map((weapon, i) => {
    const x = stand.x + ((i % PICKUP_ROW) - (PICKUP_ROW - 1) / 2) * PICKUP_GRID;
    const y = stand.y + (2 + Math.floor(i / PICKUP_ROW)) * PICKUP_GRID;
    const fits = normaliseAttachments(weaponOf(weapon), attachments);
    return { id: i, weapon, attachments: fits, loaded: 0, rounds: 0, x, y, h: scene.heightAt(x, y), droppedTick: tick };
  });
  scene.pickups.hovered = laid[request.hover ?? -1]?.id;
  // A second of frames at once is long enough for the hover to grow all the way.
  scene.pickups.update(laid, tick, 1);
}

/**
 * The damage a stage looks like (spec section 11.3), for the preview alone. The
 * game gets there by being driven into things; this is how one is looked at.
 */
function damageAt(stage: string, tick: number): DamageState {
  const damage = createDamageState();
  if (stage === 'intact') return damage;
  damage.dents[PANELS.indexOf('front')] = 0.8;
  damage.dents[PANELS.indexOf('left')] = 0.5;
  damage.integrity = 0.6;
  damage.stage = 'dented';
  if (stage === 'dented') return damage;
  damage.dents[PANELS.indexOf('front')] = 1;
  damage.lost[PANELS.indexOf('front')] = true;
  damage.integrity = 0.2;
  damage.stage = 'smoking';
  if (stage === 'smoking') return damage;
  ignite(damage, tick - Math.floor(FUSE_TICKS / 2));
  if ((stage as DamageStage) === 'burning') return damage;
  explode(damage, tick - 90);
  return damage;
}

/**
 * Lay a drift's worth of rubber into the road behind the vehicle, so a still
 * frame shows what a handbrake turn leaves (spec section 11.3). The game lays
 * these as the car slides; nothing here is simulated.
 */
function drift(scene: WorldScene, vehicle: VehicleState, spec: VehicleSpec, heading: number): void {
  const sliding: VehicleState = JSON.parse(JSON.stringify(vehicle)) as VehicleState;
  for (const wheel of sliding.wheels) {
    wheel.contact = true;
    wheel.skid = true;
  }
  const steps = Math.ceil(DRIFT_LENGTH / 0.4);
  // An arc the car came round, with its heading along the arc: a circle whose
  // centre stands off to one side of where the car has ended up.
  const cx = vehicle.x - Math.sin(heading) * DRIFT_RADIUS;
  const cz = vehicle.z + Math.cos(heading) * DRIFT_RADIUS;
  for (let i = steps; i >= 0; i--) {
    const back = (i / steps) * DRIFT_LENGTH;
    const turn = back / DRIFT_RADIUS;
    const way = heading - turn;
    sliding.x = cx + Math.sin(way) * DRIFT_RADIUS;
    sliding.z = cz - Math.cos(way) * DRIFT_RADIUS;
    sliding.y = scene.heightAt(sliding.x, sliding.z) + rideHeight(spec);
    const half = -way / 2;
    sliding.qy = Math.sin(half);
    sliding.qw = Math.cos(half);
    scene.skid.update(sliding, spec, (px, py) => scene.heightAt(px, py));
  }
}

/**
 * Drop the row padding and the alpha. The rows stay in the order they come: a
 * WebGPU texture's first row is the top of the picture, as a PNG's is.
 */
function toRgb(padded: Uint8Array, width: number, height: number): string {
  const stride = Math.ceil((width * BYTES_PER_PIXEL) / ROW_ALIGNMENT) * ROW_ALIGNMENT;
  const rgb = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const from = row * stride;
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
