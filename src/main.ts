import { readSeedFromLocation, seedFromString, writeSeedToHash } from './core/seed.ts';
import { BASE_DISTANCE, FollowCamera, PREVIEW_DISTANCE } from './render/camera.ts';
import { PostChain } from './render/post.ts';
import { frameBudgetFrom, QualityMonitor, type QualityChange } from './render/quality.ts';
import { createRenderer, probeWebGpu } from './render/renderer.ts';
import { createPreviewScene } from './render/scene.ts';
import { WorldScene } from './render/world-scene.ts';
import { FixedStepClock } from './sim/clock.ts';
import { DEFAULT_APPEARANCE } from './sim/character.ts';
import { initPhysics, SimPhysics, type Ground } from './sim/physics.ts';
import { EMPTY_INPUT } from './sim/input.ts';
import { createSimState, stepSim, type SimState } from './sim/simulation.ts';
import { HotwireBar } from './ui/hotwire.ts';
import { Hud } from './ui/hud.ts';
import { FREE_CAMERA_KEY, FreeCameraControls } from './ui/free-camera.ts';
import { Keyboard } from './ui/keyboard.ts';
import { TitleScreen } from './ui/title.ts';
import { PICKER_KEY, VehiclePicker } from './ui/vehicle-picker.ts';
import { WEAPON_PICKER_KEY, WeaponPicker } from './ui/weapon-picker.ts';
import { currentWeapon, giveWeapon } from './sim/weapon.ts';
import { roadDecks } from './world/decks.ts';
import { nearestRoadPlace, nearestWaterPlace, SurfaceIndex } from './world/surface.ts';
import { generateWorld } from './world/world.ts';

/** How fast the character turns on the title screen, in radians per second. */
const PREVIEW_SPIN = 0.7;

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
  /** The hotwire minigame of spec section 11.4, drawn while a lock is being worked at. */
  hotwire: HotwireBar;
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

  const preview = createPreviewScene(DEFAULT_APPEARANCE);
  const camera = new FollowCamera(window.innerWidth / window.innerHeight);
  camera.setBaseDistance(PREVIEW_DISTANCE);
  const clock = new FixedStepClock();
  const keyboard = new Keyboard(window);
  // The developer free camera of `docs/dev-tooling.md`. It writes into the same
  // camera the game is played through, so nothing else in the frame changes.
  const free = new FreeCameraControls(canvas);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.resize(window.innerWidth / window.innerHeight);
    // The sun's shadow cascades are cut to the camera's frustum (spec section
    // 10.5), so a new shape needs them refitted.
    session?.world.resize();
  });

  // The session is null until the title screen hands over a seed and a look.
  let session: Session | null = null;
  let spin = 0;
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
      for (let i = 0; i < steps; i++) {
        stepSim(session.state, flying ? EMPTY_INPUT : keyboard.sample(), session.physics);
      }
      const p = session.state.player;
      // The player and the car are both drawn from the record the physics
      // wrote. The record says how high the player's feet stand, so the model
      // follows them over a kerb and through a jump (spec section 11.5), and
      // the character is shown only while they are out of the car.
      session.world.character.group.position.set(p.x, p.height, p.y);
      session.world.character.group.rotation.y = -p.heading;
      session.world.character.group.visible = !p.driving;
      session.world.vehicle.set(session.state.vehicle);
      // The damage of spec section 11.3, drawn off the same record: the smoke
      // and flames over the car and the rubber its tyres leave behind.
      session.world.damage(session.state.vehicle, session.state.seed, session.state.tick);
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
        // Escape leaves the pointer lock as well as the key does, so the camera
        // is given back here rather than where it is detached.
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
      // Not `renderer.render`: the post chain draws the scene itself and the
      // effects of spec section 10.6 over it.
      session.post.render();
    } else {
      spin += (elapsed / 1000) * PREVIEW_SPIN;
      preview.character.group.position.set(0, 0, 0);
      preview.character.group.rotation.y = spin;
      camera.update(elapsed / 1000, { x: 0, y: 0, height: 0, heading: 0, speed: 0 });
      void renderer.render(preview.scene, camera.camera);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  const title = new TitleScreen(
    document.body,
    { seed: readSeedFromLocation(location.hash), character: DEFAULT_APPEARANCE },
    (appearance) => preview.character.set(appearance),
  );
  const choice = await title.wait();
  title.destroy();

  history.replaceState(null, '', writeSeedToHash(location.hash, choice.seed));

  // Generating the whole-map skeleton blocks the frame loop for a second or
  // two, so say so and let the browser paint the notice before it starts. The
  // chunks are then built in the workers, and the notice stands until there is
  // ground under the player; the rest of the city fills in as it is played.
  const notice = showNotice('Generating the world…');
  await nextFrame();
  const state = createSimState(seedFromString(choice.seed), choice.character);
  const description = generateWorld(state.seed);
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
  const picker = new VehiclePicker(document.body, state.vehicle.cls, (cls) => {
    const here = { x: state.player.x, y: state.player.y, heading: state.player.heading };
    const place = cls === 'boat' ? (nearestWaterPlace(description, here.x, here.y) ?? here) : here;
    physics.spawn(state, place.x, place.y, place.heading, cls);
    // A vehicle put down is a fresh vehicle: nothing of the last one's smoke or
    // skid marks belongs to it.
    world.resetDamage(state.tick);
  });
  // The debug picker of spec section 11.6: every weapon of the arsenal, loaded
  // and in the player's hands. It is what makes the table something to fire
  // until the weapon shops and the faction dealers of spec section 11.6 land.
  const weapons = new WeaponPicker(document.body, currentWeapon(state.loadout).id, (id) => {
    giveWeapon(state.loadout, id);
  });
  window.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    if (event.code === PICKER_KEY) picker.toggle();
    if (event.code === WEAPON_PICKER_KEY) weapons.toggle();
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
    hotwire: new HotwireBar(document.body),
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
