import { readSeedFromLocation, seedFromString, writeSeedToHash } from './core/seed.ts';
import { BASE_DISTANCE, FollowCamera, PREVIEW_DISTANCE } from './render/camera.ts';
import { createRenderer, probeWebGpu } from './render/renderer.ts';
import { createTitleScene } from './render/scene.ts';
import { WorldView } from './render/world-view.ts';
import { FixedStepClock } from './sim/clock.ts';
import { DEFAULT_APPEARANCE } from './sim/character.ts';
import { createSimState, stepSim, type SimState } from './sim/simulation.ts';
import { Hud } from './ui/hud.ts';
import { Keyboard } from './ui/keyboard.ts';
import { TitleScreen } from './ui/title.ts';
import { generateWorld } from './world/world.ts';

/** How fast the character turns on the title screen, in radians per second. */
const PREVIEW_SPIN = 0.7;

/** A session: the state being stepped, the scene it is played in, and the readout. */
interface Session {
  state: SimState;
  view: WorldView;
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

  const title = createTitleScene(DEFAULT_APPEARANCE);
  const camera = new FollowCamera(window.innerWidth / window.innerHeight);
  camera.setBaseDistance(PREVIEW_DISTANCE);
  const clock = new FixedStepClock();
  const keyboard = new Keyboard(window);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.resize(window.innerWidth / window.innerHeight);
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
      session.view.placeCharacter(p.x, p.y, p.heading);
      camera.update(elapsed / 1000, p, session.view.heightAt(p.x, p.y));
      session.hud.update(session.state);
      void renderer.render(session.view.scene, camera.camera);
    } else {
      spin += (elapsed / 1000) * PREVIEW_SPIN;
      title.character.group.position.set(0, 0, 0);
      title.character.group.rotation.y = spin;
      camera.update(elapsed / 1000, { x: 0, y: 0, heading: 0, speed: 0 });
      void renderer.render(title.scene, camera.camera);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  const screen = new TitleScreen(
    document.body,
    { seed: readSeedFromLocation(location.hash), character: DEFAULT_APPEARANCE },
    (appearance) => title.character.set(appearance),
  );
  const choice = await screen.wait();
  screen.destroy();

  history.replaceState(null, '', writeSeedToHash(location.hash, choice.seed));
  // Generating a world and cutting its ground takes a few seconds, and it
  // blocks the thread: doing it on a worker, chunk by chunk, is the streaming
  // of spec section 9.1. Until then, say so rather than looking hung.
  const loading = document.getElementById('loading');
  if (loading) loading.hidden = false;
  await nextFrame();

  const seed = seedFromString(choice.seed);
  const view = new WorldView(generateWorld(seed), choice.character);
  loading?.remove();
  camera.setBaseDistance(BASE_DISTANCE);
  session = {
    state: createSimState(seed, choice.character),
    view,
    hud: new Hud(document.body, choice.seed),
  };
}

/** Let the browser paint before a long piece of work blocks the thread. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

void boot();
