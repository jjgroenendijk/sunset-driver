import { readSeedFromLocation, seedFromString, writeSeedToHash } from './core/seed.ts';
import { BASE_DISTANCE, FollowCamera, PREVIEW_DISTANCE } from './render/camera.ts';
import { createRenderer, probeWebGpu } from './render/renderer.ts';
import { createPreviewScene } from './render/scene.ts';
import { WorldScene } from './render/world-scene.ts';
import { FixedStepClock } from './sim/clock.ts';
import { DEFAULT_APPEARANCE } from './sim/character.ts';
import { initPhysics, SimPhysics, type Ground } from './sim/physics.ts';
import { createSimState, stepSim, type SimState } from './sim/simulation.ts';
import { Hud } from './ui/hud.ts';
import { Keyboard } from './ui/keyboard.ts';
import { TitleScreen } from './ui/title.ts';
import { nearestRoadPlace, SurfaceIndex } from './world/surface.ts';
import { generateWorld } from './world/world.ts';

/** How fast the character turns on the title screen, in radians per second. */
const PREVIEW_SPIN = 0.7;

/** A session in progress: the state, the world it is played in, and the overlay. */
interface Session {
  state: SimState;
  world: WorldScene;
  physics: SimPhysics;
  hud: Hud;
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

  const frame = (now: number): void => {
    const elapsed = now - last;
    last = now;

    if (session) {
      const steps = clock.advance(elapsed);
      for (let i = 0; i < steps; i++) stepSim(session.state, keyboard.sample(), session.physics);
      const p = session.state.player;
      // The player walks on the ground the roads left, not on the natural one.
      const height = session.world.heightAt(p.x, p.y);
      session.world.character.group.position.set(p.x, height, p.y);
      session.world.character.group.rotation.y = -p.heading;
      // The car is drawn from the record the physics wrote, pose and wheels.
      session.world.vehicle.set(session.state.vehicle);
      // The light of the scene is a function of the tick, so the day runs at
      // the simulation's pace whatever the frame rate (spec section 10.5).
      session.world.time = session.state.tick;
      session.world.update(p.x, p.y);
      camera.update(elapsed / 1000, { ...p, height });
      session.hud.update(
        session.state,
        session.world.drawCallsPerChunk,
        session.world.lightCount,
        session.world.streaming,
      );
      void renderer.render(session.world.scene, camera.camera);
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
  session = { state, world, physics, hud: new Hud(document.body, choice.seed) };
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
