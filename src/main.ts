import { Raycaster, Vector2 } from 'three';
import { GameAudio } from './audio/game-audio.ts';
import { WorldSites } from './audio/site.ts';
import { randomSeedString, readSeedFromLocation, seedFromString, writeSeedToHash } from './core/seed.ts';
import { BASE_DISTANCE, FollowCamera, PULL_MARGIN, type RoofHeight } from './render/camera.ts';
import { PostChain } from './render/post.ts';
import { frameBudgetFrom, QualityMonitor } from './render/quality.ts';
import { createRenderer, probeWebGpu } from './render/renderer.ts';
import { createTitleScene } from './render/scene.ts';
import { RenderSmoother } from './render/smooth.ts';
import { ParkedView } from './render/parked.ts';
import { PedestrianView } from './render/pedestrians.ts';
import { EmergencyView } from './render/emergency.ts';
import { PoliceView } from './render/police.ts';
import { TrafficView } from './render/traffic.ts';
import { TramView } from './render/tram.ts';
import { WorldSource } from './render/world-source.ts';
import { warmPasses } from './render/warm.ts';
import { WorldScene } from './render/world-scene.ts';
import { FixedStepClock, gameTime } from './sim/clock.ts';
import { DEFAULT_APPEARANCE } from './sim/character.ts';
import { buildPlaces } from './places.ts';
import { initPhysics, SimPhysics } from './sim/physics.ts';
import { EMPTY_INPUT, type InputFrame } from './sim/input.ts';
import { createSave, restoreSimState, saveFromText, saveToText, type SaveFile } from './sim/save.ts';
import { createSimState, stepSim, type SimState } from './sim/simulation.ts';
import { buildCity } from './city.ts';
import { commitCrime } from './sim/police.ts';
import { stationAt } from './sim/metro.ts';
import { visiting } from './sim/shop.ts';
import { turfLine } from './sim/territory.ts';
import { DealerMarks } from './ui/dealers.ts';
import { EnforcerMarks } from './ui/enforcers.ts';
import { MissionMarks } from './ui/missions.ts';
import { JobPanel } from './ui/job-panel.ts';
import { TerritoryOverlay } from './ui/territory.ts';
import { TradePanel } from './ui/trade-panel.ts';
import { HotwireBar } from './ui/hotwire.ts';
import { Hud } from './ui/hud.ts';
import { MapArt } from './ui/map-draw.ts';
import { MapPois, SHOP_POIS } from './ui/map.ts';
import { MAP_KEY, MapScreen } from './ui/map-screen.ts';
import { Minimap, MINIMAP_NORTH_KEY } from './ui/minimap.ts';
import { PAUSE_KEY, PauseMenu } from './ui/pause.ts';
import { SaveSlots, setPendingStart, takePendingStart } from './ui/saves.ts';
import { readSettings, writeSettings, type BuildingViewChoice, type SoundChoice } from './ui/settings.ts';
import { FREE_CAMERA_KEY, FreeCameraControls } from './ui/free-camera.ts';
import { isTouchDevice, readTouchProbe } from './ui/touch.ts';
import { markTouchUi, mountTouchBar } from './ui/touch-bar.ts';
import { Keyboard } from './ui/keyboard.ts';
import { LoadingScreen } from './ui/loading.ts';
import { TitleScreen, type TitleChoice } from './ui/title.ts';
import { HomePanel } from './ui/home-panel.ts';
import { ShopPanel } from './ui/shop-panel.ts';
import { TravelPanel } from './ui/travel.ts';
import { PICKER_KEY, VehiclePicker } from './ui/vehicle-picker.ts';
import { WEAPON_PICKER_KEY, WeaponPicker } from './ui/weapon-picker.ts';
import { dropWeapon } from './sim/pickup.ts';
import { applyQuality, type Session } from './session.ts';
import {
  currentSlot,
  currentWeapon,
  fitAttachment,
  giveWeapon,
  removeAttachment,
  SPARE_MAGAZINES,
  weaponOf,
} from './sim/weapon.ts';
import { swingOf } from './sim/melee.ts';
import { nearestRoadPlace, nearestWaterPlace } from './world/surface.ts';
import type { WorldDescription } from './world/types.ts';

/** Metres ahead of the player the weapon picker drops a weapon. */
const DROP_AHEAD = 3;

/**
 * How far through the loading screen's bar each step of the wait stands. The
 * world is built first, the ground under the player second, and the shaders of
 * the first frame last; the shares are roughly what each step takes.
 */
const LOADED = { plan: 0.35, ground: 0.85 };

/** The debug keys that end a run (spec section 11.7), until the damage does. */
const DIE_KEY = 'KeyK';
const ARREST_KEY = 'KeyB';

/**
 * The debug key that commits a crime (spec section 14), so a chase can be
 * started without shooting anybody. Each press is one assault, which is most of
 * a star.
 */
const CRIME_KEY = 'KeyL';

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

  // The settings hold for every seed, so they are read before the title screen.
  const settings = readSettings(localStorage);
  const buildingView: BuildingViewChoice = {
    current: () => settings.buildingView,
    choose: (view) => {
      settings.buildingView = view;
      writeSettings(localStorage, settings);
    },
  };

  // The audio of spec section 15. It is armed here rather than with the
  // session, so the click or the key that starts one is the gesture the browser
  // wants before it will give an audio context. A muted game builds no graph.
  const audio = new GameAudio(settings.muted);
  audio.arm(window);
  const sound: SoundChoice = {
    muted: () => settings.muted,
    mute: (muted) => {
      settings.muted = muted;
      audio.muted = muted;
      writeSettings(localStorage, settings);
    },
  };

  // Where the world of a seed is built (spec section 9.1). It is a worker, so
  // neither the title screen's map nor the wait after Start stops the frame.
  const worlds = new WorldSource();

  // The session is null until the title screen hands over a seed and a look.
  let session: Session | null = null;
  /** The roof over a ground point, which the camera pulls back over when the player asks it to. */
  const roofTop: RoofHeight = (x, z) => session?.world.roofOver(x, z, PULL_MARGIN)?.top;
  let last = performance.now();
  /** Whether the camera was detached last frame, so a release is noticed once. */
  let flew = false;
  /** The last frame of input the simulation was stepped with, which the mix reads. */
  let heard: InputFrame = EMPTY_INPUT;

  const frame = (now: number): void => {
    const elapsed = now - last;
    last = now;

    if (session) {
      // While the camera is detached the keys drive it alone, so the simulation
      // is stepped with an empty frame: `W` must not also drive the car left
      // behind. The simulation itself keeps running either way.
      const flying = free.detached;
      // A paused session takes no steps and keeps its place between two ticks,
      // so it resumes on the frame it stopped on. The city is still drawn.
      const paused = session.pause.open;
      const steps = paused ? 0 : clock.advance(elapsed);
      const respawned = session.state.respawn;
      const trips = session.state.metro.trips;
      for (let i = 0; i < steps; i++) {
        // The pose the step starts from is kept before it is taken, so the
        // frame is drawn between the last two ticks rather than on the last.
        session.smooth.capture(session.state);
        heard = flying ? EMPTY_INPUT : keyboard.sample();
        stepSim(session.state, heard, session.physics);
      }
      // A respawn and a metro trip both put the player down somewhere else on
      // the map (spec sections 11.7, 13.3), so the frame stands the camera
      // there rather than sliding it over the city.
      if (session.state.respawn !== respawned || session.state.metro.trips !== trips) {
        session.smooth.reset();
        camera.snap();
        // The record has jumped across the map, and the difference between two
        // records is not a crash (spec section 15).
        audio.resync(session.state);
      }
      // A frame falls between two ticks, so what is drawn is the blend of them
      // `smooth.ts` describes. Without it the record steps 0, 1 or 2 ticks a
      // frame while the camera slides every frame, and the city judders.
      const alpha = clock.alpha();
      const p = session.smooth.playerAt(session.state, alpha);
      // The shop the player is standing in (spec section 16.1), or undefined.
      // Two things read it: the room that is drawn, and the shell over it,
      // which has to be cut away or the room is roofed over again.
      const inShop = visiting(session.state, session.shops);
      const vehicle = session.smooth.vehicleAt(session.state, alpha);
      // The player and the car are both drawn from the record the physics
      // wrote. The record says how high the player's feet stand and how fast
      // they are going, so the model follows them over a kerb, through a jump
      // and across the water (spec section 11.5), and the character is shown
      // only while they are out of the car.
      // A swing is drawn between two ticks like the rest of the frame (11.6).
      const swing = swingOf(session.state.loadout, session.state.tick - 1 + alpha);
      session.world.walkPlayer(p, session.state.player, elapsed / 1000, swing);
      // The weapon in the hands and the weapons on the ground (spec section
      // 11.6), with what is fitted. The one in hand follows the arm swinging it.
      session.world.held.set(session.state.loadout, session.state.player, p, session.world.character.height, swing);
      // The pickup under the mouse grows, so what lies there can be read before
      // walking to it. Nothing is picked while the camera is detached.
      if (!flying && pointer.over && session.state.pickups.length > 0) {
        ray.setFromCamera(pointer.at, camera.camera);
        session.world.pickups.pick(ray);
      } else {
        session.world.pickups.hovered = undefined;
      }
      session.world.pickups.update(session.state.pickups, session.state.tick, elapsed / 1000);
      session.world.setVehicle(vehicle);
      // The traffic is a function of the tick, so it is drawn at the moment the
      // frame stands at: one tick behind the record, as the player is.
      const round = flying ? { x: free.camera.x, y: free.camera.z } : p;
      session.traffic.update(session.state, session.state.tick - 1 + alpha, round.x, round.y);
      session.tram.update(session.state.tick - 1 + alpha, round.x, round.y);
      // The units are stepped once a tick like the player, so they are drawn
      // where the last tick left them rather than between two of them.
      session.police.update(session.state, round.x, round.y);
      session.emergency.update(session.state, round.x, round.y);
      session.parked?.update(session.state, round.x, round.y);
      session.crowd.update(session.state, session.state.tick - 1 + alpha, round.x, round.y);
      // The damage of spec section 11.3, drawn off the same record: the smoke
      // and flames over the car and the rubber its tyres leave behind. It is
      // given the drawn pose, so the smoke stands where the car is seen to be.
      session.world.damage(vehicle, session.state, session.state.tick);
      // The light of the scene is a function of the tick, so the day runs at
      // the simulation's pace whatever the frame rate (spec section 10.5). The
      // colour grade follows the same tick (spec section 10.6).
      session.world.time = session.state.tick;
      session.post.time = session.state.tick;
      // A storm keeps the ambient life off the street (spec section 13.4). The
      // crowd is laid out once from the seed, so the weather decides who is
      // drawn rather than who exists.
      session.traffic.share = session.world.weatherNow.crowd;
      session.crowd.share = session.world.weatherNow.crowd;
      // The headlamps and tail lights of everything the scene does not draw
      // itself come on with the street lamps (spec section 13.4).
      session.traffic.lamps = session.world.lampsNow;
      session.police.lamps = session.world.lampsNow;
      session.emergency.lamps = session.world.lampsNow;
      if (flying) {
        free.camera.update(elapsed / 1000, free.input(keyboard.freeCamera()));
        free.camera.writeTo(camera.camera);
        // The streaming rings and the entity fade are measured from wherever
        // the view is, or a flight of a few hundred metres looks at empty
        // ground. Nothing waits for it: the chunks land as they are built.
        session.world.update(free.camera.x, free.camera.z);
        // The cut is aimed at the player, and a flight looks at buildings whole.
        session.world.cutaway.enabled = false;
      } else {
        session.world.update(p.x, p.y);
        // A building between the camera and the player (spec section 10.7):
        // it is cut to a ghost, and with Pull back the camera first moves over
        // the roofs. Off does neither.
        camera.update(elapsed / 1000, p, settings.buildingView === 'pull-back' ? roofTop : undefined);
        session.world.cutaway.enabled = settings.buildingView !== 'whole';
        session.world.seeThrough(camera.camera.position, p.x, p.height, p.y, inShop !== undefined);
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
      const change = flying || paused ? undefined : session.quality.sample(elapsed);
      if (change !== undefined) applyQuality(session, change);
      session.hud.update(
        session.state,
        session.world.drawCallsPerChunk,
        session.world.lightCount,
        session.world.streaming,
        session.quality.tier.name,
        audio.onAir,
        turfLine(session.state, session.turf),
      );
      // The lock the player is working at (spec section 11.4). The panel reads
      // the record the simulation is playing, so the bar on screen is the bar
      // the presses are judged against.
      session.hotwire.update(session.state.theft, session.state.seed, session.state.tick);
      // The metro panel of spec section 13.3: where the player may travel from
      // the station they are standing at, and the fade of a trip in progress.
      session.travel.update(session.state, session.metro, stationAt(session.metro, session.state), session.state.tick);
      // The shop of spec section 16.1: the counter on screen, and the room the
      // player is standing in, which is the only interior the scene ever holds.
      session.shopPanel.update(session.state, session.shops, session.safehouses);
      session.world.shopInside(inShop);
      // The contraband market of spec section 16.2: where the dealers are
      // standing this spell, and the prices of the one the player is with.
      session.dealerMarks.update(session.state.tick, session.world);
      session.tradePanel.update(session.state, session.dealers);
      // The enforcers of spec section 17.2, where the record left them this
      // tick, and the dealers standing behind them in the same list.
      session.enforcerMarks.update(session.state, session.world, session.dealerMarks);
      // The work of spec section 18: the board at the contact the player is
      // standing at, and the mark on wherever the job in hand is going.
      session.jobPanel.update(session.state, session.missions);
      session.missionMarks.update(session.state, session.enforcerMarks);
      // The safehouses of spec section 16.3: what a front door costs, or what
      // the house the player is standing in does for them.
      session.homePanel.update(session.state, session.safehouses);
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
      // The mix of spec section 15 stands where the frame is drawn from, which
      // is the player or the free camera. A paused session holds no note.
      if (paused) audio.hush();
      else audio.update(session.state, heard, round);
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

  // A page loaded by an import of another seed's save, or by Regenerate, goes
  // straight into its seed rather than through the title screen.
  const pending = takePendingStart(sessionStorage);
  let choice: TitleChoice;
  if (pending) {
    choice = { seed: pending.seed, character: pending.character, world: null, explore: false };
  } else {
    const opening = readSeedFromLocation(location.hash);
    // The seed the menu opens on is built while the player is still choosing a
    // look, so Start usually finds it finished. A player who changes the seed
    // pays for the build then, as they did before.
    worlds.warm(seedFromString(opening));
    const title = new TitleScreen(
      document.body,
      { seed: opening, character: DEFAULT_APPEARANCE, world: null, explore: false },
      worlds,
      (appearance) => preview.character.set(appearance),
      buildingView,
      touch,
      sound,
    );
    choice = await title.wait();
    title.destroy();
  }

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
  const state = createSimState(seedFromString(choice.seed), choice.character);
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
  const { ground, roads, traffic, crowd, tram, police } = buildCity(state.seed, description, world);
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
  if (pending?.load) {
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
  const { stations, metro, shops, dealers, safehouses, turf, missions, parked } = buildPlaces(
    state.seed,
    description,
    world,
    roads,
    ground,
  );

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
    // skid marks belongs to it, and it is drawn where it lands rather than
    // slid there from where the last one stood.
    world.resetDamage(state.tick);
    world.dress(state.character);
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
  pois.extra = [
    ...stations.map((at) => ({ type: 'police' as const, x: at.x, y: at.y })),
    ...metro.map((at) => ({ type: 'metro-station' as const, x: at.x, y: at.y, name: `Metro · ${at.name}` })),
    ...shops.map((at) => ({ type: SHOP_POIS[at.kind], x: at.x, y: at.y, name: at.name })),
    ...safehouses.map((at) => ({ type: 'safehouse' as const, x: at.x, y: at.y, name: at.name })),
    // The contacts of spec section 18 stand where the seed put them and never
    // move, so they are marked once with the rest.
    ...missions.givers.map((at) => ({ type: 'mission-giver' as const, x: at.x, y: at.y, name: at.name })),
  ];
  // The dealers are marked after the rest, because they are the only marks that
  // move: `DealerMarks` keeps the list above and writes its own after it.
  const dealerMarks = new DealerMarks(state.seed, dealers, pois);
  // The enforcers are marked after the dealers, because they move every tick
  // and the dealers do not: `EnforcerMarks` writes the list both of them stand
  // in (spec section 17.2).
  const enforcerMarks = new EnforcerMarks(pois);
  // The objective is marked last of all, because it moves with the leg of the
  // job the record is carrying (spec section 18).
  const missionMarks = new MissionMarks(pois);
  const overlay = new TerritoryOverlay(turf, state).draw;
  const art = new MapArt(description, pois);
  const minimap = new Minimap(document.body, art);
  minimap.overlay = overlay;
  const map = new MapScreen(
    document.body,
    art,
    (place) => {
      state.waypoint = place;
    },
    touch,
  );
  map.overlay = overlay;
  const pause = new PauseMenu(document.body, choice.seed, {
    save: () => {
      slots.write(createSave(choice.seed, state));
      const time = gameTime(state.tick);
      return `Saved on day ${time.day + 1} at ${clockText(time.hour, time.minute)}.`;
    },
    canLoad: () => slots.has(choice.seed),
    load: () => {
      const save = slots.read(choice.seed);
      if (!save) throw new Error('This seed has no save yet.');
      loadInto(save);
      return 'Loaded.';
    },
    exportText: () => saveToText(createSave(choice.seed, state)),
    importText: (text) => {
      const save = saveFromText(text);
      if (save.state.seed === state.seed) {
        loadInto(save);
        return 'Loaded.';
      }
      // Another seed is another world, and a world is built from a clean page.
      // The save is kept as that seed's save, and the page loads it.
      slots.write(save);
      restart(save.seed, save.state.character, true);
      return 'Opening the city of the save…';
    },
    sound,
    regenerate: () => restart(randomSeedString(), state.character, false),
    quit: () => location.reload(),
    buildingView,
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
  // A click on the minimap sets a waypoint too, so a player driving does not
  // have to stop and open the full map to mark where they are going.
  window.addEventListener('pointerdown', (event) => {
    if (pause.open || map.open || !minimap.holds(event.clientX, event.clientY)) return;
    state.waypoint = event.button === 2 ? null : minimap.pointAt(event.clientX, event.clientY);
  });
  window.addEventListener('keydown', (event) => {
    // The open pause menu takes every key, so nothing behind it moves.
    if (pause.open) {
      pause.key(event);
      return;
    }
    if (event.repeat) return;
    // Escape closes the map first, and opens the pause menu when nothing else is open.
    if (event.code === PAUSE_KEY && !map.open) {
      pause.show();
      return;
    }
    if (event.code === PICKER_KEY) picker.toggle();
    if (event.code === WEAPON_PICKER_KEY) weapons.toggle();
    // The debug triggers of spec section 11.7. Each writes the record between
    // two ticks, as the damage and the police will, and the next tick resolves
    // it, so a run ended this way replays like any other.
    if (event.code === DIE_KEY) state.player.health = 0;
    if (event.code === ARREST_KEY) state.arrested = true;
    if (event.code === CRIME_KEY) commitCrime(state, 'assault');
    if (event.code === MAP_KEY) map.toggle();
    if (event.code === MINIMAP_NORTH_KEY) minimap.toggleNorth();
    if (event.code === 'Escape' && map.open) map.toggle();
    if (map.open && (event.code === 'Equal' || event.code === 'NumpadAdd')) map.zoom(-1);
    if (map.open && (event.code === 'Minus' || event.code === 'NumpadSubtract')) map.zoom(1);
    // The developer free camera. It takes over from where the game camera
    // stands, and pointer lock needs this key press to ask for it.
    if (event.code === FREE_CAMERA_KEY) free.toggle(camera.camera);
  });

  const trafficView = new TrafficView(traffic);
  world.scene.add(trafficView.group);
  const policeView = new PoliceView();
  world.scene.add(policeView.group);
  const emergencyView = new EmergencyView();
  world.scene.add(emergencyView.group);
  const parkedView = parked === undefined ? undefined : new ParkedView(parked);
  if (parkedView !== undefined) world.scene.add(parkedView.group);
  const tramView = new TramView(tram);
  world.scene.add(tramView.group);
  const crowdView = new PedestrianView(crowd, tram);
  // The dealers and the faction enforcers are drawn with the crowd, and the
  // list they stand in is written by `EnforcerMarks` for both of them (spec
  // sections 16.2, 17.2): this hands it over once and never again.
  crowdView.standing = enforcerMarks.standing;
  world.scene.add(crowdView.group);

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
    traffic: trafficView,
    police: policeView,
    emergency: emergencyView,
    parked: parkedView,
    tram: tramView,
    crowd: crowdView,
    state,
    world,
    physics,
    post,
    quality,
    hud: new Hud(document.body, choice.seed),
    minimap,
    map,
    hotwire: new HotwireBar(document.body),
    travel: new TravelPanel(document.body),
    metro,
    shopPanel: new ShopPanel(document.body),
    shops,
    tradePanel: new TradePanel(document.body),
    dealers,
    dealerMarks,
    enforcerMarks,
    turf,
    homePanel: new HomePanel(document.body),
    safehouses,
    jobPanel: new JobPanel(document.body),
    missions,
    missionMarks,
    smooth,
    weapons,
    pause,
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

/** `07:05` from an hour and a minute. */
function clockText(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Load the page again straight into a seed (spec section 12): from its save,
 * for an import of another seed's save, or afresh, for Regenerate.
 */
function restart(seed: string, character: SimState['character'], load: boolean): void {
  setPendingStart(sessionStorage, { seed, character, load });
  history.replaceState(null, '', writeSeedToHash(location.hash, seed));
  location.reload();
}

void boot();
