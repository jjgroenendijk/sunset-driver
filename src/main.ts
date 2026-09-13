import { Raycaster, Vector2 } from 'three';
import { readSeedFromLocation, seedFromString, writeSeedToHash } from './core/seed.ts';
import { BASE_DISTANCE, FollowCamera } from './render/camera.ts';
import { PostChain } from './render/post.ts';
import { frameBudgetFrom, QualityMonitor, type QualityChange } from './render/quality.ts';
import { createRenderer, probeWebGpu } from './render/renderer.ts';
import { createTitleScene } from './render/scene.ts';
import { RenderSmoother } from './render/smooth.ts';
import { WorldScene } from './render/world-scene.ts';
import { FixedStepClock } from './sim/clock.ts';
import { DEFAULT_APPEARANCE } from './sim/character.ts';
import { initPhysics, SimPhysics, type Ground } from './sim/physics.ts';
import { EMPTY_INPUT } from './sim/input.ts';
import { createSimState, stepSim, type SimState } from './sim/simulation.ts';
import { HotwireBar } from './ui/hotwire.ts';
import { Hud } from './ui/hud.ts';
import { MapArt } from './ui/map-draw.ts';
import { MapPois } from './ui/map.ts';
import { MAP_KEY, MapScreen } from './ui/map-screen.ts';
import { Minimap, MINIMAP_NORTH_KEY } from './ui/minimap.ts';
import { FREE_CAMERA_KEY, FreeCameraControls } from './ui/free-camera.ts';
import { Keyboard } from './ui/keyboard.ts';
import { TitleScreen } from './ui/title.ts';
import { PICKER_KEY, VehiclePicker } from './ui/vehicle-picker.ts';
import { WEAPON_PICKER_KEY, WeaponPicker } from './ui/weapon-picker.ts';
import { dropWeapon } from './sim/pickup.ts';
import {
  currentSlot,
  currentWeapon,
  fitAttachment,
  giveWeapon,
  removeAttachment,
  SPARE_MAGAZINES,
  weaponOf,
} from './sim/weapon.ts';
import { roadDecks } from './world/decks.ts';
import { nearestRoadPlace, nearestWaterPlace, SurfaceIndex } from './world/surface.ts';
import { generateWorld } from './world/world.ts';

/** Metres ahead of the player the weapon picker drops a weapon. */
const DROP_AHEAD = 3;

/** The debug keys that end a run (spec section 11.7), until the damage and the police do. */
const DIE_KEY = 'KeyK';
const ARREST_KEY = 'KeyB';

/** A session in progress: the state, the world it is played in, and the overlay. */
interface Session {
  state: SimState;
  world: WorldScene;
  physics: SimPhysics;
  /** The effects the world is drawn through (spec section 10.6). */
  post: PostChain;
  /** What watches the frame and steps the quality tiers (spec section 9.2). */
  quality: QualityMonitor;
  hud: Hud;
  /** The corner map of spec section 12, following the player. */
  minimap: Minimap;
  /** The full map of spec section 12: pan, zoom and waypoint. */
  map: MapScreen;
  /** The hotwire minigame of spec section 11.4, drawn while a lock is being worked at. */
  hotwire: HotwireBar;
  /** What draws the frame between two ticks, so the motion is smooth (spec section 9.2). */
  smooth: RenderSmoother;
  /** The debug picker of the arsenal, which shows the weapon in hand. */
  weapons: WeaponPicker;
}

/**
 * Hand a tier to the two halves that draw at it, and say so (spec section 9.2).
 *
 * The line in the console is how a tier change is read back after the fact:
 * the player sees a frame that holds its rate, and the log says what it cost.
 */
function applyQuality(session: Session, change: QualityChange): void {
  session.world.quality = change.to;
  session.post.quality = change.to.post;
  console.info(
    `quality: ${change.from.name} -> ${change.to.name} at ${change.frameMs.toFixed(1)} ms a frame ` +
      `(budget ${session.quality.budget} ms)`,
  );
}

async function boot(): Promise<void> {
  const status = document.getElementById('status');
  const probe = await probeWebGpu();
  if (!probe.ok) {
    if (status) status.textContent = probe.reason;
    return;
  }

  // Rapier is WebAssembly and has to be loaded before a world can be built
  // from it (spec section 2.1). It is small, and the title screen is next.
  try {
    await initPhysics();
  } catch {
    if (status) status.textContent = 'The physics engine could not be loaded.';
    return;
  }

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = await createRenderer(canvas);
  document.getElementById('splash')?.remove();
  canvas.hidden = false;

  // The camera behind the menu swings about the car, unless the player asks the browser for less motion.
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const preview = createTitleScene(DEFAULT_APPEARANCE, window.innerWidth / window.innerHeight, still);
  const camera = new FollowCamera(window.innerWidth / window.innerHeight);
  const clock = new FixedStepClock();
  const keyboard = new Keyboard(window);
  // The developer free camera of `docs/dev-tooling.md`. It writes into the same
  // camera the game is played through, so nothing else in the frame changes.
  const free = new FreeCameraControls(canvas);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.resize(window.innerWidth / window.innerHeight);
    preview.resize(window.innerWidth / window.innerHeight);
    // The sun's shadow cascades are cut to the camera's frustum (spec section
    // 10.5), so a new shape needs them refitted.
    session?.world.resize();
  });

  // Where the mouse is over the canvas, in the camera's -1 to 1 frame, which is
  // what picks the pickup under it.
  const pointer = { at: new Vector2(), over: false };
  const ray = new Raycaster();
  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.at.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    pointer.over = true;
  });
  canvas.addEventListener('pointerleave', () => {
    pointer.over = false;
  });

  // The session is null until the title screen hands over a seed and a look.
  let session: Session | null = null;
  let last = performance.now();
  /** Whether the camera was detached last frame, so a release is noticed once. */
  let flew = false;

  const frame = (now: number): void => {
    const elapsed = now - last;
    last = now;

    if (session) {
      // While the camera is detached the keys drive it alone, so the simulation
      // is stepped with an empty frame: `W` must not also drive the car left
      // behind. The simulation itself keeps running either way.
      const flying = free.detached;
      const steps = clock.advance(elapsed);
      const respawned = session.state.respawn;
      for (let i = 0; i < steps; i++) {
        // The pose the step starts from is kept before it is taken, so the
        // frame is drawn between the last two ticks rather than on the last.
        session.smooth.capture(session.state);
        stepSim(session.state, flying ? EMPTY_INPUT : keyboard.sample(), session.physics);
      }
      // A respawn moves the player across the map (spec section 11.7), so the
      // frame puts them down there rather than sliding them over the city.
      if (session.state.respawn !== respawned) {
        session.smooth.reset();
        camera.snap();
      }
      // A frame falls between two ticks, so what is drawn is the blend of them
      // `smooth.ts` describes. Without it the record steps 0, 1 or 2 ticks a
      // frame while the camera slides every frame, and the city judders.
      const alpha = clock.alpha();
      const p = session.smooth.playerAt(session.state, alpha);
      const vehicle = session.smooth.vehicleAt(session.state, alpha);
      // The player and the car are both drawn from the record the physics
      // wrote. The record says how high the player's feet stand, so the model
      // follows them over a kerb and through a jump (spec section 11.5), and
      // the character is shown only while they are out of the car.
      session.world.character.group.position.set(p.x, p.height, p.y);
      session.world.character.group.rotation.y = -p.heading;
      session.world.character.group.visible = !session.state.player.driving;
      // The weapon in the hands and the weapons on the ground (spec section
      // 11.6), both drawn off the record with what is fitted to them.
      session.world.held.set(session.state.loadout, session.state.player, p, session.world.character.height);
      // The pickup under the mouse grows, so what lies there can be read before
      // walking to it. Nothing is picked while the camera is detached.
      if (!flying && pointer.over && session.state.pickups.length > 0) {
        ray.setFromCamera(pointer.at, camera.camera);
        session.world.pickups.pick(ray);
      } else {
        session.world.pickups.hovered = undefined;
      }
      session.world.pickups.update(session.state.pickups, session.state.tick, elapsed / 1000);
      session.world.vehicle.set(vehicle);
      // The damage of spec section 11.3, drawn off the same record: the smoke
      // and flames over the car and the rubber its tyres leave behind. It is
      // given the drawn pose, so the smoke stands where the car is seen to be.
      session.world.damage(vehicle, session.state.seed, session.state.tick);
      // The light of the scene is a function of the tick, so the day runs at
      // the simulation's pace whatever the frame rate (spec section 10.5). The
      // colour grade follows the same tick (spec section 10.6).
      session.world.time = session.state.tick;
      session.post.time = session.state.tick;
      if (flying) {
        free.camera.update(elapsed / 1000, keyboard.freeCamera());
        free.camera.writeTo(camera.camera);
        // The streaming rings and the entity fade are measured from wherever
        // the view is, or a flight of a few hundred metres looks at empty
        // ground. Nothing waits for it: the chunks land as they are built.
        session.world.update(free.camera.x, free.camera.z);
      } else {
        session.world.update(p.x, p.y);
        camera.update(elapsed / 1000, p);
      }
      if (flew && !flying) {
        // The flight ended, whichever frame the key came on: the camera slides
        // back to the player rather than jumping, and the quality monitor
        // starts judging frames again.
        camera.snap();
        session.quality.settle();
      }
      flew = flying;
      // What the frame took is what decides the quality tier of spec section
      // 9.2. It is measured over the whole frame, drawing included, so it is
      // the frame before this one that is being judged. A frame drawn with the
      // free camera is never a performance measurement, so it is not counted.
      const change = flying ? undefined : session.quality.sample(elapsed);
      if (change !== undefined) applyQuality(session, change);
      session.hud.update(
        session.state,
        session.world.drawCallsPerChunk,
        session.world.lightCount,
        session.world.streaming,
        session.quality.tier.name,
      );
      // The lock the player is working at (spec section 11.4). The panel reads
      // the record the simulation is playing, so the bar on screen is the bar
      // the presses are judged against.
      session.hotwire.update(session.state.theft, session.state.seed, session.state.tick);
      session.weapons.sync(session.state.loadout);
      // The maps of spec section 12. Both follow the player from the record,
      // and both redraw only when something on them has moved, so a session
      // standing still pays for neither. The minimap follows the free camera
      // while it is detached, because that is what the player is looking at.
      const at = flying
        ? { x: free.camera.x, y: free.camera.z, heading: p.heading }
        : { x: p.x, y: p.y, heading: p.heading };
      session.minimap.update(at, session.state.waypoint);
      session.map.update(at, session.state.waypoint);
      // Not `renderer.render`: the post chain draws the scene itself and the
      // effects of spec section 10.6 over it.
      session.post.render();
    } else {
      preview.update(elapsed / 1000);
      void renderer.render(preview.scene, preview.camera);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  const title = new TitleScreen(
    document.body,
    { seed: readSeedFromLocation(location.hash), character: DEFAULT_APPEARANCE, world: null },
    (appearance) => preview.character.set(appearance),
  );
  const choice = await title.wait();
  title.destroy();

  history.replaceState(null, '', writeSeedToHash(location.hash, choice.seed));

  // Generating the whole-map skeleton blocks the frame loop for a second or
  // two, so say so and let the browser paint the notice before it starts. The
  // chunks are then built in the workers, and the notice stands until there is
  // ground under the player; the rest of the city fills in as it is played.
  //
  // A player who looked at the seed's map on the title screen has already paid
  // for that build, and the world is a pure function of the seed, so the
  // preview's world is the session's world.
  const notice = showNotice('Generating the world…');
  await nextFrame();
  const state = createSimState(seedFromString(choice.seed), choice.character);
  const description = choice.world ?? generateWorld(state.seed);
  const world = new WorldScene(description, state.character);

  // The physics reads the carved ground the renderer draws and the surface the
  // parcel model left, so the car drives on what is on screen (spec section
  // 11.3). The session starts on the nearest road to the core rather than
  // wherever the origin happens to fall.
  const surfaces = new SurfaceIndex(description);
  const ground: Ground = {
    heightAt: (x, y) => world.heightAt(x, y),
    surfaceAt: (x, y) => surfaces.at(x, y),
    seaLevel: description.water.seaLevel,
    // A bridged segment carves no ground, so the deck is the only thing to
    // drive on there and the physics is given it as a solid.
    decks: roadDecks(description),
  };
  const start = nearestRoadPlace(description, state.player.x, state.player.y);
  const physics = new SimPhysics(ground, state);
  physics.spawn(state, start?.x ?? state.player.x, start?.y ?? state.player.y, start?.heading ?? 0);
  // The safehouses of spec section 16.3 have not landed, so a death comes back
  // where the session started (spec section 11.7).
  state.safehouse = { x: state.player.x, y: state.player.y, heading: state.player.heading };

  try {
    await world.settle(state.player.x, state.player.y, 1);
  } catch (error) {
    // A worker that never answers leaves the player standing on nothing, so
    // the notice says so rather than hanging on 'Generating the world…'.
    notice.textContent = error instanceof Error ? error.message : 'The world could not be built.';
    physics.dispose();
    world.dispose();
    return;
  }
  notice.remove();
  // The parcels are built in the chunk workers, so the police stations are
  // known once a worker has answered, which `settle` waited for. An arrest
  // comes back on the road nearest a station (spec section 11.7).
  const stations = world.stations ?? [];
  ground.stations = stations.map((at) => nearestRoadPlace(description, at.x, at.y) ?? { ...at, heading: 0 });

  camera.setBaseDistance(BASE_DISTANCE);
  // The chain is built on the world's scene and the camera that follows the
  // player, so it is made here rather than beside the renderer. Waiting for it
  // means the first frame is antialiased like every frame after it.
  const post = new PostChain(renderer, world.scene, camera.camera);
  await post.ready();
  // `?budget=6` holds the game to a frame no machine makes at full quality, so
  // the tiers of spec section 9.2 can be watched stepping down.
  const quality = new QualityMonitor(frameBudgetFrom(location.search));

  // The debug picker of spec section 11.3: every class of the roster, put down
  // under the player. A boat goes on the nearest open water instead, since a
  // boat on a street is not a boat that can be driven. The ground the physics
  // reads is the carve, which answers anywhere on the map, so the vehicle is
  // driveable the moment it lands and the chunks around it stream in after.
  const smooth = new RenderSmoother();
  const picker = new VehiclePicker(document.body, state.vehicle.cls, (cls) => {
    const here = { x: state.player.x, y: state.player.y, heading: state.player.heading };
    const place = cls === 'boat' ? (nearestWaterPlace(description, here.x, here.y) ?? here) : here;
    physics.spawn(state, place.x, place.y, place.heading, cls);
    // A vehicle put down is a fresh vehicle: nothing of the last one's smoke or
    // skid marks belongs to it, and it is drawn where it lands rather than
    // slid there from where the last one stood.
    world.resetDamage(state.tick);
    smooth.reset();
  });
  // The debug picker of spec section 11.6: every weapon of the arsenal, loaded
  // and in the player's hands, and the attachments of the one in hand. It is
  // what makes the table something to fire until the weapon shops and the
  // faction dealers of spec section 11.6 land. A weapon dropped from it lies
  // on the ground ahead, which is how a pickup is tried before anybody dies.
  const weapons = new WeaponPicker(document.body, currentWeapon(state.loadout).id, {
    pick: (id) => giveWeapon(state.loadout, id),
    drop: (id) => {
      const spec = weaponOf(id);
      const from = state.player.driving ? { x: state.vehicle.x, y: state.vehicle.z } : state.player;
      const x = from.x + Math.cos(state.player.heading) * DROP_AHEAD;
      const y = from.y + Math.sin(state.player.heading) * DROP_AHEAD;
      dropWeapon(state, id, spec.capacity, spec.capacity * SPARE_MAGAZINES, [], x, y, world.heightAt(x, y));
    },
    fit: (attachment) => {
      const slot = currentSlot(state.loadout);
      if (!removeAttachment(state.loadout, slot.id, attachment)) fitAttachment(state.loadout, slot.id, attachment);
    },
  });
  // The maps of spec section 12, both drawn from one `MapArt`, so the corner
  // map and the full map can never disagree about a road or a mark. The POI
  // list is shared with them: a system that owns places writes `pois.extra`
  // once and both maps show them.
  const pois = new MapPois(description);
  pois.extra = stations.map((at) => ({ type: 'police' as const, x: at.x, y: at.y }));
  const art = new MapArt(description, pois);
  const minimap = new Minimap(document.body, art);
  const map = new MapScreen(document.body, art, (place) => {
    state.waypoint = place;
  });
  // A click on the minimap sets a waypoint too, so a player driving does not
  // have to stop and open the full map to mark where they are going.
  window.addEventListener('pointerdown', (event) => {
    if (map.open || !minimap.holds(event.clientX, event.clientY)) return;
    state.waypoint = event.button === 2 ? null : minimap.pointAt(event.clientX, event.clientY);
  });
  window.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    if (event.code === PICKER_KEY) picker.toggle();
    if (event.code === WEAPON_PICKER_KEY) weapons.toggle();
    // The debug triggers of spec section 11.7. Each writes the record between
    // two ticks, as the damage and the police will, and the next tick resolves
    // it, so a run ended this way replays like any other.
    if (event.code === DIE_KEY) state.player.health = 0;
    if (event.code === ARREST_KEY) state.arrested = true;
    if (event.code === MAP_KEY) map.toggle();
    if (event.code === MINIMAP_NORTH_KEY) minimap.toggleNorth();
    if (event.code === 'Escape' && map.open) map.toggle();
    if (map.open && (event.code === 'Equal' || event.code === 'NumpadAdd')) map.zoom(-1);
    if (map.open && (event.code === 'Minus' || event.code === 'NumpadSubtract')) map.zoom(1);
    // The developer free camera. It takes over from where the game camera
    // stands, and pointer lock needs this key press to ask for it.
    if (event.code === FREE_CAMERA_KEY) free.toggle(camera.camera);
  });

  session = {
    state,
    world,
    physics,
    post,
    quality,
    hud: new Hud(document.body, choice.seed),
    minimap,
    map,
    hotwire: new HotwireBar(document.body),
    smooth,
    weapons,
  };
  preview.dispose();
  last = performance.now();
}

/** A full-screen message over the canvas, until it is removed. */
function showNotice(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'notice';
  el.textContent = text;
  document.body.append(el);
  return el;
}

/** Resolve after the browser has painted: the second frame starts once the first is on screen. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

void boot();
