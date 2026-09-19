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
import { createPlayerState, exitPlace, JUMP_SPEED, SPRINT_SPEED, SWIM_DEPTH } from '../sim/on-foot.ts';
import type { PickupState } from '../sim/pickup.ts';
import { createSimState, type SimState } from '../sim/simulation.ts';
import type { EmergencyKind, EmergencyUnit } from '../sim/emergency.ts';
import { light } from '../sim/fire.ts';
import { EmergencyView } from './emergency.ts';
import { layBodies } from './preview-bodies.ts';
import {
  ATTACHMENTS,
  createLoadout,
  fitAttachment,
  giveWeapon,
  MUZZLE_HEIGHT,
  MUZZLE_REACH,
  normaliseAttachments,
  WEAPON_IDS,
  weaponOf,
  type Attachment,
} from '../sim/weapon.ts';
import type { TracerEnd } from '../sim/tracer.ts';
import {
  createVehicleState,
  DEFAULT_CLASS,
  rideHeight,
  specOf,
  VEHICLE_CLASSES,
  type VehicleSpec,
  type VehicleState,
} from '../sim/vehicle.ts';
import { SurfaceIndex, type Surface } from '../world/surface.ts';
import { PULL_MARGIN } from './camera.ts';
import { poseFor } from './character-pose.ts';
import { tickAtHour } from './daylight.ts';
import { FULL_TIER, QUALITY_TIERS } from './quality.ts';
import { forgetStage, peopleFor, stageFor, viewFor } from './preview-stage.ts';
import type { WorldScene } from './world-scene.ts';
import { roomOf, SHOP_KINDS, type Shop } from '../world/shops.ts';

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
   * What a building between the camera and the player does (spec section
   * 10.7): `see-through`, `pull-back` or `whole`. Left out, it is see-through,
   * as the game starts.
   */
  buildings?: string;
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
   * The stance to hold the player in, for looking at the movement of spec
   * sections 11.2 and 11.5 in a still frame: `stand`, `walk`, `air` or `swim`.
   * Left out, they stand. A cycle has no still of its own, so the frame is
   * taken a quarter of the way through, where the swing is widest.
   */
  stance?: string;
  /**
   * How far through a swing of a melee weapon to hold the player, 0 to 1 (spec
   * section 11.6). Left out, nothing is being swung. The blow is thrown and
   * over in a fifth of a second, so a still is the only way to look at it.
   */
  swing?: number;
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
   * Set to put the emergency services of spec section 20.3 in the picture: a
   * blaze in the road ahead, with a fire engine standing at it and an
   * ambulance behind. They are put down rather than driven to, because a
   * preview is one frame and a call takes the best part of a minute.
   */
  emergency?: boolean;
  /**
   * Set to show the rounds of spec section 11.6 in the air: a shotgun blast
   * the way the player faces, a tick old, and a pistol round two ticks before
   * it. What they meet is laid by hand, since a preview casts nothing.
   */
  shots?: boolean;
  /**
   * Set to lay casualties of spec section 11.6 in the road ahead: two dead,
   * and one each falling, rising, crawling, limping and thrown. With
   * {@link PreviewRequest.emergency} the ambulance's medics kneel at one.
   */
  bodies?: boolean;
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
  /**
   * The trade of the shop to stand the player inside (spec section 16.1), by
   * name, or `any` for the nearest shop of any trade. It is the one way to look
   * at an interior: the frame is taken from inside the room, with the vehicle
   * left at the kerb, and it overrides {@link PreviewRequest.onFoot}.
   */
  shop?: string;
  /**
   * Set to wait only for the chunks of the near ring before drawing, rather
   * than for both rings. The frame is ready in about half the time, and a
   * chunk of the far ring that has not landed yet is missing from it, so the
   * same request twice may not take the same picture.
   */
  fast?: boolean;
}

/** A quarter through a cycle, where a leg is furthest forward and the other furthest back. */
const POSE_PHASE = Math.PI / 2;

/**
 * Hold the player in one stance of spec sections 11.2 and 11.5, so a still
 * frame shows the walk, the jump or the stroke that a running game shows over
 * time. Left unasked, the model keeps the standing pose it was built in.
 */
function hold(scene: WorldScene, request: PreviewRequest): void {
  const asked = request.stance;
  const swing = request.swing ?? -1;
  if (asked === undefined && swing < 0) return;
  const stance = (['stand', 'walk', 'air', 'swim'] as const).find((name) => name === (asked ?? 'stand'));
  if (stance === undefined) throw new Error(`no stance named ${String(asked)}`);
  const stature = scene.character.height;
  scene.character.pose(
    poseFor(stance, POSE_PHASE, {
      speed: stance === 'walk' ? SPRINT_SPEED : 0,
      grounded: stance !== 'air',
      vy: stance === 'air' ? JUMP_SPEED : 0,
      // A swimmer is drawn where they stand, so the water is only as deep as
      // the stroke needs: the body lies on the ground rather than in the sea.
      depth: stance === 'swim' ? SWIM_DEPTH * stature * 1.1 : 0,
      stature,
      swing,
    }),
  );
}

/** Metres out of a shop door `--shop` leaves the vehicle. */
const KERB = 4;

/**
 * The shop `--shop` asks for: the nearest one of that trade to where the player
 * was going to stand, or the nearest of any trade for `any`. Nothing is asked
 * for, or no shop of that trade was built, and the frame is the street.
 */
function shopFor(shops: readonly Shop[] | undefined, wanted: string | undefined, x: number, y: number): Shop | undefined {
  if (wanted === undefined || shops === undefined) return undefined;
  const kind = SHOP_KINDS.find((name) => name === wanted);
  if (kind === undefined && wanted !== 'any') throw new Error(`no shop trade called ${wanted}`);
  let found: Shop | undefined;
  let near = Infinity;
  for (const shop of shops) {
    if (kind !== undefined && shop.kind !== kind) continue;
    const away = Math.hypot(shop.x - x, shop.y - y);
    if (away >= near) continue;
    near = away;
    found = shop;
  }
  return found;
}

/** Metres between two pickups `--pickups` lays, and how many lie in a row. */
const PICKUP_GRID = 3;
const PICKUP_ROW = 8;

/** Ticks of smoke and flame let into the air before the picture is taken. */
const FX_WARMUP = 240;

/** Metres of drift `--skid` lays, and the radius it curves through. */
/** Metres ahead of the player the preview's blaze burns, and how far back each unit stands. */
const FIRE_AHEAD = 11;
const ENGINE_BACK = 9;
const AMBULANCE_BACK = 18;

const DRIFT_LENGTH = 24;
const DRIFT_RADIUS = 18;

/** The picture, and what the frame cost to build. */
export interface PreviewResult {
  width: number;
  height: number;
  /** Where the frame was taken from, which `--shop` moves off what was asked for. */
  x: number;
  y: number;
  /** The rows, top row first, three bytes a pixel, base64 encoded. */
  rgb: string;
  /** Milliseconds spent generating the world, 0 when the world was kept from the last request. */
  worldMs: number;
  /** True when the scene and its chunks were kept from the last request, of the same seed and tier. */
  kept: boolean;
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
  /** People of the crowd drawn round the player (spec section 13.1). */
  pedestrians: number;
}

/** Bytes a pixel of the render target below. */
const BYTES_PER_PIXEL = 4;

/** Every row of a WebGPU readback starts on a multiple of this many bytes. */
const ROW_ALIGNMENT = 256;

export async function renderPreview(request: PreviewRequest): Promise<PreviewResult> {
  try {
    return await draw(request);
  } catch (error) {
    // A request that failed half way may have left anything in the scene.
    forgetStage();
    throw error;
  }
}

async function draw(request: PreviewRequest): Promise<PreviewResult> {
  const { seed, distance, heading, speed, width, height, hour } = request;
  // `--shop` moves the frame to the room of a shop, which is only known once a
  // worker has answered, so where the player stands is settled below.
  let x = request.x;
  let y = request.y;
  const tier = QUALITY_TIERS.find((entry) => entry.name === request.quality) ?? FULL_TIER;

  const { renderer, world, scene, worldMs, kept } = await stageFor(seed, tier, width, height);
  if (kept) clearStage(scene);

  const t1 = performance.now();
  const tick = tickAtHour(hour);
  scene.time = tick;
  // The chunks are built in the workers the game uses, so the picture is the
  // frame the game draws. Every chunk of both rings is waited for, so the same
  // request twice takes the same picture; `fast` waits for the near ring only.
  const radius = request.fast === true ? tier.rings.near : tier.rings.far;
  await scene.settle(x, y, radius);
  // The shops of spec section 16.1 come back with the first chunk, so the
  // nearest one of the trade asked for is picked here and the ground round it
  // built in turn. The room is then the frame's own middle.
  const shop = shopFor(scene.shops, request.shop, x, y);
  if (shop !== undefined) {
    const room = roomOf(shop);
    x = room.x;
    y = room.y;
    await scene.settle(x, y, radius);
    scene.shopInside({ kind: shop.kind, room });
  }
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
  // Inside a shop the vehicle waits at the kerb outside its door, because a
  // car parked in the shop is not what the room looks like.
  const kerb =
    shop === undefined
      ? { x, y }
      : { x: shop.x + Math.cos(shop.facing) * KERB, y: shop.y + Math.sin(shop.facing) * KERB };
  const vehicle = createVehicleState(spec, kerb.x, kerb.y, rest + rideHeight(spec), heading);
  if (request.damage !== undefined) vehicle.damage = damageAt(request.damage, tick);
  const stand = request.onFoot === true && shop === undefined ? exitPlace(vehicle, spec) : { x, y, heading };
  scene.character.group.position.set(stand.x, scene.heightAt(stand.x, stand.y), stand.y);
  scene.character.group.rotation.y = -stand.heading;
  scene.character.group.visible = request.onFoot === true || shop !== undefined;
  hold(scene, request);
  scene.setVehicle(vehicle);
  const record = createSimState(seed, undefined, tick);
  const services = request.emergency === true ? callOut(record, scene, kerb.x, kerb.y, heading) : undefined;
  // A fire is what has been burning for a while, not what started this frame,
  // so the smoke is given a run of ticks to climb before the picture is taken.
  scene.resetDamage(tick - FX_WARMUP);
  if (request.bodies === true) layBodies(record, kerb.x, kerb.y, heading, (px, py) => scene.heightAt(px, py), tick);
  if (request.shots === true) volley(record, stand, scene.heightAt(stand.x, stand.y), tick);
  // The surface of the ground, as the game reads it through the city: rubber
  // is left on the tarmac and nowhere else (spec section 11.3).
  const surfaces = new SurfaceIndex(world);
  const surfaceAt = (px: number, py: number): Surface => surfaces.at(px, py);
  for (let t = tick - FX_WARMUP; t <= tick; t++) scene.damage(vehicle, record, t, surfaceAt);
  if (request.skid === true) drift(scene, vehicle, spec, heading, surfaceAt);
  arm(scene, request, stand, tick);
  // What moves through the city, where its tours put it at the tick the
  // picture is taken, as the game draws it.
  const { traffic, trams, crowd, casualties, wildlife, parked } = peopleFor();
  traffic.lamps = scene.lampsNow;
  traffic.update(record, tick, x, y);
  trams.update(tick, x, y);
  crowd.update(record, tick, x, y);
  casualties.update(record, tick, x, y);
  wildlife.update(tick, tick, x, y);
  parked?.refresh();
  parked?.update(record, x, y);

  const { camera, post, target } = viewFor(width, height);
  camera.setBaseDistance(distance);
  // The first update snaps the camera onto its target rather than easing in,
  // so one call is a settled frame and no render time has to be simulated.
  const view = request.buildings ?? 'see-through';
  const roofs = view === 'pull-back' ? (px: number, pz: number) => scene.roofOver(px, pz, PULL_MARGIN)?.top : undefined;
  camera.update(0, { x, y, height: ground, heading, speed }, roofs);
  scene.cutaway.enabled = view !== 'whole';
  scene.seeThrough(camera.camera.position, stand.x, scene.heightAt(stand.x, stand.y), stand.y, shop !== undefined);

  const t2 = performance.now();
  post.regrade();
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
  const drawn = traffic.drawn;
  const standing = parked?.drawn ?? 0;
  const walking = crowd.drawn;
  // The scene is kept for the next request, so what this one put in it alone is taken out again.
  if (services !== undefined) scene.scene.remove(services.group);
  services?.dispose();

  return { width, height, x, y, rgb, worldMs, kept, chunkMs, frameMs, peakDrawCalls, lights, shadows, quality: tier.name, traffic: drawn, parked: standing, pedestrians: walking };
}

/**
 * Undo what an earlier request left in a kept scene and the next one might not
 * set again: a pose, laid pickups, a shop's room. Everything else a request
 * touches it sets every time.
 */
function clearStage(scene: WorldScene): void {
  scene.dress(DEFAULT_APPEARANCE);
  scene.pickups.hovered = undefined;
  scene.pickups.update([], 0);
  scene.shopInside(undefined);
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
  scene.held.set(loadout, player, { ...stand, height: ground }, scene.character.height, request.swing ?? -1);
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
 * The scene of spec section 20.3: a blaze in the road ahead of the player, a
 * fire engine standing at it and an ambulance behind. It answers the view, so
 * the caller can keep it alive while the frame is drawn.
 */
function callOut(record: SimState, scene: WorldScene, x: number, y: number, heading: number): EmergencyView {
  const ahead = (metres: number): { x: number; y: number } => ({
    x: x + Math.cos(heading) * metres,
    y: y + Math.sin(heading) * metres,
  });
  const fire = ahead(FIRE_AHEAD);
  light(record, fire.x, fire.y);
  const stand = (id: number, kind: EmergencyKind, metres: number): EmergencyUnit => {
    const at = ahead(metres);
    return {
      id,
      kind,
      task: 'work',
      call: 0,
      x: at.x,
      y: at.y,
      heading: heading + Math.PI,
      height: scene.heightAt(at.x, at.y),
      speed: 0,
      edges: [],
      distance: 0,
      stop: 0,
      planned: 0,
      goalX: fire.x,
      goalY: fire.y,
      homeX: at.x,
      homeY: at.y,
      until: -1,
    };
  };
  record.emergency.units.push(stand(0, 'engine', FIRE_AHEAD + ENGINE_BACK), stand(1, 'ambulance', FIRE_AHEAD + AMBULANCE_BACK));
  const view = new EmergencyView();
  view.lamps = scene.lampsNow;
  scene.scene.add(view.group);
  view.update(record, x, y);
  return view;
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
function drift(
  scene: WorldScene,
  vehicle: VehicleState,
  spec: VehicleSpec,
  heading: number,
  surfaceAt: (x: number, y: number) => Surface,
): void {
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
    scene.skid.update(sliding, spec, (px, py) => scene.heightAt(px, py), surfaceAt);
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

/** Metres the rounds of `--shots` carry before they stop, and the spread of the blast. */
const VOLLEY_REACH = 14;
const VOLLEY_SPREAD = 0.09;

/** Lay the rounds `--shots` shows into the record, as `gunfire.ts` would have. */
function volley(record: SimState, stand: { x: number; y: number; heading: number }, ground: number, tick: number): void {
  const h = ground + MUZZLE_HEIGHT;
  const round = (at: number, pellet: number, yaw: number, reach: number, end: TracerEnd): void => {
    const x = stand.x + Math.cos(stand.heading) * MUZZLE_REACH;
    const y = stand.y + Math.sin(stand.heading) * MUZZLE_REACH;
    const ex = x + Math.cos(yaw) * reach;
    const ey = y + Math.sin(yaw) * reach;
    record.tracers.push({ tick: at, pellet, x, y, h, ex, ey, eh: h - 0.3, end });
  };
  round(tick - 2, 0, stand.heading + 0.5, VOLLEY_REACH * 0.7, 'vehicle');
  for (let i = 0; i < 8; i++) {
    const yaw = stand.heading + ((i - 3.5) / 3.5) * VOLLEY_SPREAD;
    round(tick - 1, i, yaw, VOLLEY_REACH * (0.8 + 0.05 * (i % 4)), i % 3 === 0 ? 'none' : 'hard');
  }
}
