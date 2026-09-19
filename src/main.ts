import { GameAudio } from './audio/game-audio.ts';
import { WorldSites } from './audio/site.ts';
import { seedFromString, writeSeedToHash } from './core/seed.ts';
import { BASE_DISTANCE, FollowCamera } from './render/camera.ts';
import { PostChain } from './render/post.ts';
import { frameBudgetFrom, QualityMonitor } from './render/quality.ts';
import { createRenderer, probeWebGpu } from './render/renderer.ts';
import { createTitleScene } from './render/scene.ts';
import { RenderSmoother } from './render/smooth.ts';
import { WorldSource } from './render/world-source.ts';
import { warmPasses } from './render/warm.ts';
import { WorldScene } from './render/world-scene.ts';
import { FixedStepClock } from './sim/clock.ts';
import { DEFAULT_APPEARANCE } from './sim/character.ts';
import { buildPlaces } from './places.ts';
import { initPhysics, SimPhysics } from './sim/physics.ts';
import { restoreSimState, type SaveFile } from './sim/save.ts';
import { createSimState } from './sim/simulation.ts';
import { attachParty } from './net/attach.ts';
import { buildCity } from './city.ts';
import { buildViews } from './views.ts';
import { SessionFrame } from './frame.ts';
import { listenForKeys } from './keys.ts';
import { buildMaps } from './maps.ts';
import { buildPauseMenu } from './pause-actions.ts';
import { buildPickers } from './pickers.ts';
import { JobPanel } from './ui/job-panel.ts';
import { TradePanel } from './ui/trade-panel.ts';
import { HotwireBar } from './ui/hotwire.ts';
import { Hud } from './ui/hud.ts';
import { SaveSlots } from './ui/saves.ts';
import { readSettings, writeSettings, type MenuSettings } from './ui/settings.ts';
import { FreeCameraControls } from './ui/free-camera.ts';
import { isTouchDevice, readTouchProbe } from './ui/touch.ts';
import { markTouchUi, mountTouchBar } from './ui/touch-bar.ts';
import { Keyboard } from './ui/keyboard.ts';
import { LoadingScreen } from './ui/loading.ts';
import { openingChoice } from './ui/title-open.ts';
import { HomePanel } from './ui/home-panel.ts';
import { ShopPanel } from './ui/shop-panel.ts';
import { TravelPanel } from './ui/travel.ts';
import type { Session } from './session.ts';
import { nearestRoadPlace } from './world/surface.ts';
import type { WorldDescription } from './world/types.ts';

/**
 * How far through the loading screen's bar each step of the wait stands. The
 * world is built first, the ground under the player second, and the shaders of
 * the first frame last; the shares are roughly what each step takes.
 */
const LOADED = { plan: 0.35, ground: 0.85 };

/**
 * The quality tier a touch session starts on (spec section 9.2).
 *
 * A phone is not integrated graphics on a desk. The monitor would find this
 * level on its own inside a second, but the second it spends there is the
 * first second of the flight, and the frame it warms and compiles at full
 * quality is the dearest one the session ever draws. Starting here spends
 * neither. The monitor is free to walk back up if the phone can hold it.
 */
const TOUCH_START_TIER = 2;

async function boot(): Promise<void> {
  const status = document.getElementById('status');
  const say = (text: string): void => {
    if (status) status.textContent = text;
  };

  // Rapier is WebAssembly and has to be loaded before a world can be built
  // from it (spec section 2.1). Nothing before the session touches it, so it
  // is fetched beside the graphics rather than in front of them and waited for
  // where it is first needed. The error is carried rather than thrown, because
  // nothing is awaiting this promise yet.
  const physicsReady: Promise<Error | null> = initPhysics().then(
    () => null,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );

  const probe = await probeWebGpu();
  if (!probe.ok) {
    say(probe.reason);
    return;
  }

  say('Starting the graphics…');
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
  keyboard.listenMouse(canvas);
  // A phone has no keys and no pointer lock, so it is given the buttons of
  // `touch-bar.ts` and the fly pad of `touch-fly.ts` instead (`docs/menus.md`).
  const touch = isTouchDevice(readTouchProbe(window));
  if (touch) markTouchUi(document);
  // The developer free camera of `docs/dev-tooling.md`. It writes into the same
  // camera the game is played through, so nothing else in the frame changes.
  const free = new FreeCameraControls(canvas, touch);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.resize(window.innerWidth / window.innerHeight);
    preview.resize(window.innerWidth / window.innerHeight);
    // The sun's shadow cascades are cut to the camera's frustum (spec section
    // 10.5), so a new shape needs them refitted.
    session?.world.resize();
  });

  // The settings hold for every seed, so they are read before the title screen.
  const settings = readSettings(localStorage);

  // The audio of spec section 15. It is armed here rather than with the
  // session, so the click or the key that starts one is the gesture the browser
  // wants before it will give an audio context. A muted game builds no graph.
  const audio = new GameAudio(settings.muted);
  audio.arm(window);
  // What the Settings column of both menus reads and writes. A choice holds at
  // once and is kept for every seed.
  const menuSettings: MenuSettings = {
    buildingView: {
      current: () => settings.buildingView,
      choose: (view) => {
        settings.buildingView = view;
        writeSettings(localStorage, settings);
      },
    },
    sound: {
      on: () => !settings.muted,
      set: (on) => {
        settings.muted = !on;
        audio.muted = !on;
        writeSettings(localStorage, settings);
      },
    },
    northUp: {
      on: () => settings.northUp,
      set: (on) => {
        settings.northUp = on;
        writeSettings(localStorage, settings);
      },
    },
  };

  // Where the world of a seed is built (spec section 9.1). It is a worker, so
  // neither the title screen's map nor the wait after Start stops the frame.
  const worlds = new WorldSource();

  // The session is null until the title screen hands over a seed and a look.
  let session: Session | null = null;
  // What a frame of a session does (`frame.ts`). Until there is one the title
  // screen's preview is drawn instead.
  const loop = new SessionFrame(canvas, { camera, clock, keyboard, free, audio, settings });
  let last = performance.now();

  const frame = (now: number): void => {
    const elapsed = now - last;
    last = now;
    if (session) {
      loop.draw(session, elapsed);
    } else {
      preview.update(elapsed / 1000);
      void renderer.render(preview.scene, preview.camera);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // The seed and the look, from the title screen or from the save that
  // reloaded the page (`ui/title-open.ts`).
  const choice = await openingChoice({
    worlds,
    onPreview: (appearance) => preview.character.set(appearance),
    settings: menuSettings,
    touch,
  });

  history.replaceState(null, '', writeSeedToHash(location.hash, choice.seed));

  // The wait between the title screen and the street. It is drawn rather than
  // announced: every step the screen shows is one really being taken, and
  // nothing on this path blocks the frame loop, so the screen keeps drawing
  // its own progress. The chunks are built in the workers, and the screen
  // stands until there is ground under the player; the rest of the city fills
  // in as it is played.
  //
  // A player who looked at the seed's map on the title screen has already paid
  // for that build, and the world is a pure function of the seed, so the
  // preview's world is the session's world.
  const loading = new LoadingScreen(document.body, choice.seed);
  loading.say('Drawing the city plan', 0);
  const state = createSimState(seedFromString(choice.seed), choice.character, undefined, choice.money);
  let description: WorldDescription;
  try {
    description = choice.world ?? (await worlds.get(state.seed));
  } catch (error) {
    loading.fail('The world could not be built.');
    console.error(error);
    return;
  }
  const world = new WorldScene(description, state.character);
  loading.say('Laying out the streets', LOADED.plan);

  // The city the seed is played in: the traffic, the crowd, the tram, the
  // police and the emergency services, and the ground the physics drives on
  // (`city.ts`). The session starts on the nearest road to the core rather
  // than wherever the origin happens to fall.
  const { ground, roads, traffic, crowd, tram, police, wildlife } = buildCity(state.seed, description, world);
  // The bells of spec section 13.2 are a function of the tick rather than part
  // of the record, so the audio is given the line itself to ask.
  audio.watch(tram);
  // The ambient beds of spec section 15 are the place itself, which is not in
  // the record either: the audio reads it off the world where the player stands.
  audio.survey(new WorldSites(description));
  const start = nearestRoadPlace(description, state.player.x, state.player.y);
  // Rapier was fetched while the graphics were being set up, and this is the
  // first line that needs it.
  const physicsError = await physicsReady;
  if (physicsError !== null) {
    loading.fail('The physics engine could not be loaded.');
    console.error(physicsError);
    world.dispose();
    return;
  }
  let physics = new SimPhysics(ground, state);
  physics.spawn(state, start?.x ?? state.player.x, start?.y ?? state.player.y, start?.heading ?? 0);
  // Where a player who owns no safehouse comes back to (spec sections 11.7,
  // 16.3): the place the session started at.
  state.origin = { x: state.player.x, y: state.player.y, heading: state.player.heading };

  // The saves of spec section 16.4, one per seed in this browser. A save is
  // loaded into the record in place, since everything below holds the record,
  // and the physics is built afresh from it: the bodies of the session before
  // the load, the traffic's among them, have nothing to do with the save.
  const slots = new SaveSlots(localStorage);
  const loadSave = (save: SaveFile): void => {
    restoreSimState(state, save);
    physics.dispose();
    physics = new SimPhysics(ground, state);
    if (session) session.physics = physics;
  };
  if (choice.load) {
    try {
      const save = slots.read(choice.seed);
      if (save) loadSave(save);
    } catch (error) {
      console.warn('The save could not be loaded; a new session starts instead.', error);
    }
  }

  try {
    await world.settle(state.player.x, state.player.y, 1, undefined, (done, total) => {
      // Nothing is done while the workers are still building their layers, and
      // that is the longest part of the wait: it is named rather than shown as
      // a bar that does not move.
      const step = done === 0 ? 'Laying out the streets' : `Building the ground · ${done} of ${total}`;
      loading.say(step, LOADED.plan + (done / Math.max(total, 1)) * (LOADED.ground - LOADED.plan));
    });
  } catch (error) {
    // A worker that never answers leaves the player standing on nothing, so
    // the screen says so rather than standing on the last step for ever.
    loading.fail(error instanceof Error ? error.message : 'The world could not be built.');
    physics.dispose();
    world.dispose();
    return;
  }
  // The parcels are built in the chunk workers, so every place dealt over them
  // is known once a worker has answered, which `settle` waited for. `places.ts`
  // asks each system where its own places stand and fills the ground with them.
  const places = buildPlaces(state.seed, description, world, roads, ground);
  const { metro, shops, dealers, safehouses, turf, missions, parked } = places;

  loading.say('Getting the first frame ready', LOADED.ground);
  // The camera is put where the session starts before anything is compiled,
  // because what is compiled is what the camera can see.
  const smooth = new RenderSmoother();
  camera.setBaseDistance(BASE_DISTANCE);
  camera.update(0, smooth.playerAt(state, 1));
  // The chain is built on the world's scene and the camera that follows the
  // player, so it is made here rather than beside the renderer. Waiting for it
  // means the first frame is antialiased like every frame after it.
  const post = new PostChain(renderer, world.scene, camera.camera, undefined, state.seed);
  await post.ready();
  // `?budget=6` holds the game to a frame no machine makes at full quality, so
  // the tiers of spec section 9.2 can be watched stepping down.
  const quality = new QualityMonitor(frameBudgetFrom(location.search), touch ? TOUCH_START_TIER : 0);
  // The tier the monitor opens on has to be put on the two halves that draw at
  // it, because nothing has changed a tier yet for `applyQuality` to report.
  world.quality = quality.tier;
  post.quality = quality.tier.post;

  // The debug pickers of spec sections 11.3 and 11.6 (`pickers.ts`), and the
  // maps of spec section 12 with every mark on them (`maps.ts`).
  const { picker, weapons } = buildPickers(state, description, world, () => physics, smooth);
  const { minimap, map, navigator, dealerMarks, enforcerMarks, streetLife, missionMarks } = buildMaps(
    state,
    description,
    places,
    touch,
  );
  // The multiplayer of spec section 21. Nothing connects here: the handle is
  // offline until a press, or until `join` below reads a room off the link.
  const party = attachParty(choice.seed, () => state, {
    snap: (tick) => {
      // The host's clock is the city's clock. The record jumps to it as it
      // jumps for a metro trip, so the camera and the audio are put where it
      // landed rather than sliding across the city to it.
      state.tick = tick;
      smooth.reset();
      camera.snap();
      audio.resync(state);
    },
    redraw: () => pause.refresh(),
  });
  // A load moves the player across the map and puts a different vehicle under
  // them, so the frame snaps to it rather than sliding there.
  const loadInto = (save: SaveFile): void => {
    loadSave(save);
    audio.resync(state);
    world.resetDamage(state.tick);
    world.dress(state.character);
    smooth.reset();
    camera.snap();
    picker.select(state.vehicle.cls);
  };
  const pause = buildPauseMenu({
    seed: choice.seed,
    state,
    slots,
    loadInto,
    settings: menuSettings,
    party: party.actions,
  });
  // A page opened on an invite link joins that room, now that there is a menu
  // to report it on (`docs/multiplayer.md`).
  party.join();
  // The presses that open a menu, a map or a picker (`keys.ts`).
  listenForKeys(window, { state, pause, map, minimap, picker, weapons, free, camera });

  const views = buildViews(world, { traffic, crowd, tram, wildlife }, parked, streetLife.standing);

  // WebGPU compiles a pipeline the first time it draws with it, so a session
  // that starts here compiles the whole city over its first frames: the street
  // stutters into place while the player is already driving on it. The wait is
  // paid once, here, where there is a screen saying so. It comes after every
  // view is in the scene, because a shader is compiled for the object that is
  // drawn with it and not for the material alone (`warm.ts`).
  await warmPasses(world, post, (done, total) => {
    loading.say(
      `Compiling the shaders · ${done} of ${total}`,
      LOADED.ground + (done / Math.max(total, 1)) * (1 - LOADED.ground),
    );
  });

  session = {
    ...views,
    state,
    world,
    physics,
    surfaceAt: ground.surfaceAt,
    post,
    quality,
    hud: new Hud(document.body, choice.seed),
    minimap,
    map,
    navigator,
    hotwire: new HotwireBar(document.body),
    travel: new TravelPanel(document.body),
    metro,
    shopPanel: new ShopPanel(document.body),
    shops,
    tradePanel: new TradePanel(document.body),
    dealers,
    dealerMarks,
    enforcerMarks,
    streetLife,
    turf,
    homePanel: new HomePanel(document.body),
    safehouses,
    jobPanel: new JobPanel(document.body),
    missions,
    missionMarks,
    smooth,
    weapons,
    pause,
    party: party.control,
  };
  // The three buttons a phone drives a session from, over the canvas.
  if (touch) mountTouchBar(document.body, free, camera.camera, { menu: () => pause.show(), map: () => map.toggle() });
  // Explore opens the city from the air rather than from the driver's seat: the
  // camera is detached before the first frame and lifted over where the session
  // started, so the screen the loading screen fades off is already the flight.
  if (choice.explore) {
    free.toggle(camera.camera);
    free.camera.survey(world.heightAt(state.player.x, state.player.y));
  }
  preview.dispose();
  last = performance.now();
  // The city is handed over rather than cut to: the screen waits for the first
  // frame of the session to be drawn under it and then fades off it.
  await loading.reveal();
}

void boot();
