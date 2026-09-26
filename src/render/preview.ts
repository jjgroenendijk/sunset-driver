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
import { zoomOf } from './viewmodel.ts';
import { heavyFire } from './preview-heavy.ts';
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
import { exitPlace } from '../sim/on-foot.ts';
import { createSimState, type SimState } from '../sim/simulation.ts';
import type { GiverPlace } from '../sim/giver.ts';
import type { LoadoutState } from '../sim/weapon.ts';
import { callOut, standCrews } from './preview-services.ts';
import { EmergencyCrews } from '../ui/emergency-crews.ts';
import { layBodies } from './preview-bodies.ts';
import { layPolice } from './preview-police.ts';
import { nearestContact, previewContacts, standContacts } from './preview-contacts.ts';
import { arm, boardAt, hold, volley } from './preview-player.ts';
import type { PreviewRequest, PreviewResult } from './preview-request.ts';
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
import type { WorldDescription } from '../world/types.ts';
import { BASE_DISTANCE, PULL_MARGIN, TURN_MARGIN, type FollowCamera } from './camera.ts';
import { CAMERA_VIEWS } from './camera-view.ts';
import { seatRider } from './rider.ts';
import type { Camera, Object3D } from 'three';
import { tickAtHour } from './daylight.ts';
import { frameContents } from './frame-contents.ts';
import { FULL_TIER, QUALITY_TIERS, type QualityTier } from './quality.ts';
import { clearPlaceFor, GALLERY_SUBJECTS, layGallery, type Gallery, type GallerySubject } from './preview-gallery.ts';
import { forgetStage, peopleFor, stageFor, viewFor, type PreviewPeople } from './preview-stage.ts';
import type { EmergencyView } from './emergency.ts';
import type { StandingPerson } from './pedestrians.ts';
import type { WorldScene } from './world-scene.ts';
import { namedWeather, weatherAt, type Weather } from '../sim/weather.ts';
import { roomOf, SHOP_KINDS, type Shop } from '../world/shops.ts';

export type { PreviewRequest, PreviewResult } from './preview-request.ts';

/** Metres short of a contact `--contacts` stands the player, so the contact is in the frame. */
const CONTACT_BACK = 7;

/** Metres out of a shop door `--shop` leaves the vehicle. */
const KERB = 4;

/**
 * How far back the camera stands in a shop, when the request did not say. A
 * room is about 7 m across and the game's own distance is 36, which frames the
 * street the shop stands on rather than the room.
 */
const SHOP_DISTANCE = 22;

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

/**
 * How much of the camera's distance a gallery's own reach asks for, and the
 * least it ever stands back. The camera looks down at 58 degrees, so a grid
 * needs more room than its width; a row of props needs less room than the
 * game's own distance, which is why the game's distance is not the floor.
 */
const GALLERY_FIT = 2.8;
const GALLERY_NEAREST = 10;

/** The subject a gallery lays, by name. */
function subjectOf(name: string): GallerySubject {
  const subject = GALLERY_SUBJECTS.find((entry) => entry === name);
  if (subject === undefined) throw new Error(`no gallery of ${name}; the galleries are ${GALLERY_SUBJECTS.join(', ')}`);
  return subject;
}

/** How far back the camera stands when the request did not say: to hold a gallery, a room, or the game's own. */
function fitDistance(gallery: Gallery | undefined, inShop: boolean): number {
  if (gallery !== undefined) return Math.max(GALLERY_NEAREST, gallery.reach * GALLERY_FIT);
  return inShop ? SHOP_DISTANCE : BASE_DISTANCE;
}

/** Ticks of smoke and flame let into the air before the picture is taken. */
const FX_WARMUP = 240;

/** Metres of drift `--skid` lays, and the radius it curves through. */
const DRIFT_LENGTH = 24;
const DRIFT_RADIUS = 18;

/** Bytes a pixel of the render target below. */
const BYTES_PER_PIXEL = 4;

/** Every row of a WebGPU readback starts on a multiple of this many bytes. */
const ROW_ALIGNMENT = 256;

/** Where the player stands, and which way they face. */
interface Stand {
  x: number;
  y: number;
  heading: number;
}

/** Where the frame is taken from, once the chunks round it are built. */
interface Place {
  x: number;
  y: number;
  /** The shop the player stands inside, for `--shop`. */
  shop: Shop | undefined;
  /** The mission contacts `--contacts` stands. */
  givers: GiverPlace[];
}

/** The vehicle of the frame, where it waits, and where the player stands. */
interface Staged {
  vehicle: VehicleState;
  spec: VehicleSpec;
  kerb: { x: number; y: number };
  stand: Stand;
}

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
  const { seed, width, height } = request;
  const tier = QUALITY_TIERS.find((entry) => entry.name === request.quality) ?? FULL_TIER;

  const { renderer, world, scene, worldMs, kept } = await stageFor(seed, tier, width, height);
  if (kept) clearStage(scene);

  const t1 = performance.now();
  const tick = tickAtHour(request.hour);
  const weather = namedWeather(request.weather);
  scene.fixedWeather = weather;
  scene.time = tick;
  const place = await placeFor(request, tier, world, scene);
  const { x, y, shop } = place;
  const chunkMs = performance.now() - t1;

  const staged = stageVehicle(request, world, scene, place, tick);
  const record = createSimState(seed, undefined, tick);
  const { officers, services } = layRecord(request, world, scene, place, staged, record, tick);
  const loadout = arm(scene, request, staged.stand, tick);
  // The gallery of `preview-gallery.ts` stands in the scene for this one
  // request, as the emergency view does, and is taken out again below.
  const gallery =
    request.gallery === undefined
      ? undefined
      : layGallery(subjectOf(request.gallery), { x, y, heading: request.heading }, (px, py) => scene.heightAt(px, py), DEFAULT_APPEARANCE);
  if (gallery !== undefined) scene.scene.add(gallery.group);
  const people = movePeople(request, scene, record, place, officers, weather ?? weatherAt(seed, tick), tick);
  // A gallery is a shelf of models, and a street of traffic standing among
  // them is what makes it unreadable, so the city's own moving parts are
  // hidden for the one frame and shown again below.
  const ambient = ambientOf(people);
  if (gallery !== undefined) for (const group of ambient) group.visible = false;

  const { camera, post, target } = viewFor(width, height);
  camera.setBaseDistance(request.distance ?? fitDistance(gallery, shop !== undefined));
  pointCamera(request, scene, camera, place, staged.stand, gallery, loadout, tick);

  const t2 = performance.now();
  post.fixedWeather = weather;
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
  const counts = countsOf(people, gallery);
  const holds = frameContents(camera.camera, scene.contents);
  // The scene is kept for the next request, so what this one put in it alone is taken out again.
  if (services !== undefined) scene.scene.remove(services.group);
  services?.dispose();
  if (gallery !== undefined) {
    scene.scene.remove(gallery.group);
    gallery.dispose();
    for (const group of ambient) group.visible = true;
  }

  const laid = gallery === undefined ? {} : { gallery: gallery.labels };
  return { width, height, x, y, rgb, worldMs, kept, chunkMs, frameMs, peakDrawCalls, lights, shadows, quality: tier.name, ...counts, holds, ...laid };
}

/**
 * Settle where the frame is taken from, and build the chunks round it. The
 * `--contacts`, `--shop` and `--gallery` requests each move it off the place
 * asked for.
 */
async function placeFor(request: PreviewRequest, tier: QualityTier, world: WorldDescription, scene: WorldScene): Promise<Place> {
  let x = request.x;
  let y = request.y;
  // The chunks are built in the workers the game uses, so the picture is the
  // frame the game draws. Every chunk of both rings is waited for, so the same
  // request twice takes the same picture; `fast` waits for the near ring only.
  const radius = request.fast === true ? tier.rings.near : tier.rings.far;
  // `--contacts` takes the picture at the contact nearest the place asked for,
  // which is known from the world alone and so is settled before the chunks.
  const givers = request.contacts === true ? previewContacts(request.seed, world) : [];
  const atContact = request.contacts === true ? nearestContact(givers, x, y) : undefined;
  if (atContact !== undefined) {
    // Behind them rather than on them: a player standing on the corner stands
    // in their body, and the vehicle they arrived in covers it.
    x = atContact.x - Math.cos(atContact.heading) * CONTACT_BACK;
    y = atContact.y - Math.sin(atContact.heading) * CONTACT_BACK;
  }
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
  // A gallery is moved onto the nearest ground clear of buildings, and the
  // player with it, because a model behind a wall is not in the picture.
  if (request.gallery !== undefined && shop === undefined) {
    const roofed = (px: number, py: number): boolean => scene.roofOver(px, py) !== undefined;
    const clear = clearPlaceFor(subjectOf(request.gallery), { x, y, heading: request.heading }, roofed);
    if (clear.x !== x || clear.y !== y) {
      x = clear.x;
      y = clear.y;
      await scene.settle(x, y, radius);
    }
  }
  // Where the player stands decides which lamps burn and where the sky dome is.
  scene.look(x, y);
  return { x, y, shop, givers };
}

/**
 * The player is in their vehicle, on the ground the roads left, as in the
 * game. `--vehicle` is how a class of the roster is looked at (spec section
 * 11.3); a boat is stood on the waterline rather than on the ground. With
 * `--on-foot` they stand beside it instead, where stepping out leaves them
 * (spec section 11.5), and the character model is what the picture shows.
 */
function stageVehicle(request: PreviewRequest, world: WorldDescription, scene: WorldScene, place: Place, tick: number): Staged {
  const { x, y, shop } = place;
  const { heading } = request;
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
  for (const leaf of leavesOf(request.open)) vehicle.leaves.open[leaf] = 1;
  const stand = request.onFoot === true && shop === undefined ? exitPlace(vehicle, spec) : { x, y, heading };
  scene.character.group.position.set(stand.x, scene.heightAt(stand.x, stand.y), stand.y);
  scene.character.group.rotation.set(0, -stand.heading, 0);
  scene.character.group.visible = request.onFoot === true || shop !== undefined;
  hold(scene, request);
  scene.setVehicle(vehicle);
  // A class ridden astride carries the player on it, as the game draws them
  // (`rider.ts`), so `--vehicle=motorcycle` shows the rider and the bike.
  if (!scene.character.group.visible && seatRider(scene.character, vehicle, spec)) {
    scene.character.group.visible = true;
  }
  if (request.board !== undefined) boardAt(scene, vehicle, spec, request.board);
  return { vehicle, spec, kerb, stand };
}

/** The leaves `--open` draws open, by index: the four doors, then the bonnet. */
function leavesOf(open: string | undefined): number[] {
  if (open === 'all') return [0, 1, 2, 3, 4];
  if (open === 'doors') return [0, 1, 2, 3];
  if (open === 'bonnet') return [4];
  return [];
}

/**
 * Lay into the record what the request asks to see happen: the emergency
 * services, the casualties, the police, the rounds and the heavy weapons, and
 * the smoke and rubber of the vehicle. It answers the officers and the crews'
 * view, which the caller draws and takes out again.
 */
function layRecord(
  request: PreviewRequest,
  world: WorldDescription,
  scene: WorldScene,
  place: Place,
  staged: Staged,
  record: SimState,
  tick: number,
): { officers: StandingPerson[]; services: EmergencyView | undefined } {
  const { heading } = request;
  const { vehicle, spec, kerb, stand } = staged;
  const heightAt = (px: number, py: number): number => scene.heightAt(px, py);
  if (request.emergency === true) callOut(record, scene, kerb.x, kerb.y, heading);
  // A fire is what has been burning for a while, not what started this frame,
  // so the smoke is given a run of ticks to climb before the picture is taken.
  scene.resetDamage(tick - FX_WARMUP);
  if (request.bodies === true) layBodies(record, kerb.x, kerb.y, heading, heightAt, tick);
  const officers = request.police === true ? layPolice(record, kerb.x, kerb.y, heading, heightAt, tick) : [];
  // The crews stand at their places once the bodies are down, since a medic's
  // place is beside one of them.
  const services = request.emergency === true ? standCrews(record, scene, place.x, place.y) : undefined;
  if (request.shots === true) volley(record, stand, scene.heightAt(stand.x, stand.y), tick);
  if (request.heavy !== undefined) heavyFire(record, stand, heightAt, tick, request.heavy);
  // The surface of the ground, as the game reads it through the city: rubber
  // is left on the tarmac and nowhere else (spec section 11.3).
  const surfaces = new SurfaceIndex(world);
  const surfaceAt = (px: number, py: number): Surface => surfaces.at(px, py);
  for (let t = tick - FX_WARMUP; t <= tick; t++) scene.damage(vehicle, record, t, surfaceAt);
  if (request.skid === true) drift(scene, vehicle, spec, heading, surfaceAt);
  return { officers, services };
}

/**
 * What moves through the city, where its tours put it at the tick the
 * picture is taken, as the game draws it.
 */
function movePeople(
  request: PreviewRequest,
  scene: WorldScene,
  record: SimState,
  place: Place,
  officers: StandingPerson[],
  weather: Weather,
  tick: number,
): PreviewPeople {
  const { x, y } = place;
  const people = peopleFor();
  const { traffic, trams, tramStops, tramSigns, busStops, corners, crowd, casualties, guns, markers, wildlife, parked } = people;
  // The contacts of spec section 18 stand at the head of the crowd's own list,
  // as they do in a session, and their markers turn over them.
  const bodies = request.contacts === true ? standContacts(request.seed, place.givers, scene, record) : undefined;
  // The crew of the engine at work stand in the same list as the police.
  const crews = new EmergencyCrews();
  crews.update(record, { standing: [...(bodies?.standing ?? []), ...officers] });
  crowd.standing = crews.standing;
  markers.marks = bodies?.markers ?? [];
  markers.update(tick, x, y);
  traffic.lamps = scene.lampsNow;
  trams.lamps = scene.lampsNow;
  tramStops.lamps = scene.lampsNow;
  tramSigns.lamps = scene.lampsNow;
  traffic.update(record, tick, x, y);
  trams.update(tick, x, y);
  tramStops.update(x, y);
  tramSigns.update(tick, x, y);
  busStops.update(x, y);
  corners.update(tick, x, y);
  // The crowd puts its umbrellas up in the weather the picture is drawn in.
  crowd.rain = weather.rain;
  crowd.update(record, tick, x, y);
  casualties.update(record, tick, x, y);
  guns.update(record);
  wildlife.update(tick, tick, x, y);
  parked?.refresh();
  parked?.update(record, x, y);
  return people;
}

/** The groups of the city's own moving parts, which a gallery hides. */
function ambientOf(people: PreviewPeople): Object3D[] {
  const { traffic, trams, tramStops, tramSigns, busStops, corners, crowd, casualties, wildlife, parked } = people;
  const groups = [traffic.group, trams.group, tramStops.group, tramSigns.group, busStops.group, corners.group, crowd.group, casualties.group, wildlife.group];
  if (parked !== undefined) groups.push(parked.group);
  return groups;
}

/** What the city drew round the player, which is nothing while a gallery hides it. */
function countsOf(people: PreviewPeople, gallery: Gallery | undefined): { traffic: number; parked: number; pedestrians: number } {
  if (gallery !== undefined) return { traffic: 0, parked: 0, pedestrians: 0 };
  return { traffic: people.traffic.drawn, parked: people.parked?.drawn ?? 0, pedestrians: people.crowd.drawn };
}

/**
 * Put the camera where the request asks, onto the player or the place looked
 * at, and ghost what stands in the way.
 */
function pointCamera(
  request: PreviewRequest,
  scene: WorldScene,
  camera: FollowCamera,
  place: Place,
  stand: Stand,
  gallery: Gallery | undefined,
  loadout: LoadoutState,
  tick: number,
): void {
  const { x, y, shop } = place;
  // The first update snaps the camera onto its target rather than easing in,
  // so one call is a settled frame and no render time has to be simulated.
  const view = request.buildings ?? 'see-through';
  const pull = view === 'pull-back' ? (px: number, pz: number) => scene.roofOver(px, pz, PULL_MARGIN)?.top : undefined;
  const turn = view === 'turn' ? (px: number, pz: number) => scene.roofOver(px, pz, TURN_MARGIN)?.top : undefined;
  const look = CAMERA_VIEWS.find((choice) => choice.value === request.view)?.value ?? 'top-down';
  // Top down looks at the vehicle, as it always has; a chase view follows
  // whoever the player is, in the car or beside it.
  const eye = look === 'top-down' ? { x, y, heading: request.heading } : stand;
  const driving = request.onFoot !== true && shop === undefined;
  const on = { x: eye.x, y: eye.y, height: scene.heightAt(eye.x, eye.y), heading: eye.heading, speed: request.speed, driving };
  camera.update(0, on, { view: look, pull, turn, zoom: zoomOf(loadout) });
  showHands(scene, camera, loadout, look === 'first-person' && !driving, tick);
  const seen = aimCamera(request, scene, camera.camera, on, gallery, stand);
  if (look !== 'top-down' && request.lookUp !== undefined) tiltUp(camera.camera, request.lookUp);
  scene.cutaway.enabled = view !== 'whole';
  // A building in the way of the place looked at is ghosted, as one in the way of the player is.
  scene.seeThrough(camera.camera.position, seen.x, seen.height, seen.y, shop !== undefined);
}

/**
 * Move the camera onto the place the request looks at, and answer that place:
 * the player when it looks at none. A gallery is what the picture is of, so the
 * camera looks at the middle of its grid unless the request named a place of
 * its own.
 */
function aimCamera(
  request: PreviewRequest,
  scene: WorldScene,
  camera: Camera,
  on: { x: number; y: number; height: number },
  gallery: Gallery | undefined,
  stand: Stand,
): { x: number; y: number; height: number } {
  const at = request.lookAt ?? (gallery === undefined ? undefined : { x: gallery.x, y: gallery.y, height: 0 });
  if (at === undefined) return { ...stand, height: scene.heightAt(stand.x, stand.y) };
  const aim = { ...at, height: scene.heightAt(at.x, at.y) + at.height };
  aimAt(camera, on, aim);
  return aim;
}

/** First person on foot draws the weapon in view instead of the body (`viewmodel.ts`). */
function showHands(scene: WorldScene, camera: FollowCamera, loadout: LoadoutState, first: boolean, tick: number): void {
  if (!first) {
    scene.viewModel.hide();
    return;
  }
  scene.character.group.visible = false;
  scene.held.stow();
  scene.viewModel.update(camera.camera, loadout, DEFAULT_APPEARANCE, tick, 1, { yaw: camera.heading, pitch: camera.elevation, speed: 0, grounded: true });
}

/** Tilt a chase view up by `degrees`, so the sky is in the frame. */
function tiltUp(camera: Camera, degrees: number): void {
  camera.rotation.x += (degrees * Math.PI) / 180;
  camera.updateMatrixWorld();
}

/**
 * Move the camera by how far a place lies from the player, so the place is
 * framed as the player would be standing there: the same pitch, heading and
 * distance, and the place where the player would be in the picture.
 */
function aimAt(camera: Camera, from: { x: number; y: number; height: number }, to: { x: number; y: number; height: number }): void {
  camera.position.x += to.x - from.x;
  camera.position.y += to.height - from.height;
  camera.position.z += to.y - from.y;
  camera.updateMatrixWorld();
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
