import { readSeedFromLocation, seedFromString, writeSeedToHash } from './core/seed.ts';
import { BASE_DISTANCE, FollowCamera, PREVIEW_DISTANCE } from './render/camera.ts';
import { PostChain } from './render/post.ts';
import { createRenderer, probeWebGpu } from './render/renderer.ts';
import { createPreviewScene } from './render/scene.ts';
import { WorldScene } from './render/world-scene.ts';
import { FixedStepClock } from './sim/clock.ts';
import { DEFAULT_APPEARANCE } from './sim/character.ts';
import { createSimState, stepSim, type SimState } from './sim/simulation.ts';
import { Hud } from './ui/hud.ts';
import { Keyboard } from './ui/keyboard.ts';
import { TitleScreen } from './ui/title.ts';
import { generateWorld } from './world/world.ts';

/** How fast the character turns on the title screen, in radians per second. */
const PREVIEW_SPIN = 0.7;

/** A session in progress: the state, the world it is played in, and the overlay. */
interface Session {
  state: SimState;
  world: WorldScene;
  /** The effects the world is drawn through (spec section 10.6). */
  post: PostChain;
  hud: Hud;
}

async function boot(): Promise<void> {
  const status = document.getElementById('status');
  const probe = await probeWebGpu();
  if (!probe.ok) {
    if (status) status.textContent = probe.reason;
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
      for (let i = 0; i < steps; i++) stepSim(session.state, keyboard.sample());
      const p = session.state.player;
      // The player walks on the ground the roads left, not on the natural one.
      const height = session.world.heightAt(p.x, p.y);
      session.world.character.group.position.set(p.x, height, p.y);
      session.world.character.group.rotation.y = -p.heading;
      // The light of the scene is a function of the tick, so the day runs at
      // the simulation's pace whatever the frame rate (spec section 10.5). The
      // colour grade follows the same tick (spec section 10.6).
      session.world.time = session.state.tick;
      session.post.time = session.state.tick;
      session.world.update(p.x, p.y);
      camera.update(elapsed / 1000, { ...p, height });
      session.hud.update(
        session.state,
        session.world.drawCallsPerChunk,
        session.world.lightCount,
        session.world.streaming,
      );
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
  const world = new WorldScene(generateWorld(state.seed), state.character);
  try {
    await world.settle(state.player.x, state.player.y, 1);
  } catch (error) {
    // A worker that never answers leaves the player standing on nothing, so
    // the notice says so rather than hanging on 'Generating the world…'.
    notice.textContent = error instanceof Error ? error.message : 'The world could not be built.';
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
  session = { state, world, post, hud: new Hud(document.body, choice.seed) };
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
