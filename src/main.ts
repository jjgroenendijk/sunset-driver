import { readSeedFromLocation, seedFromString, writeSeedToHash } from './core/seed.ts';
import { BASE_DISTANCE, FollowCamera, PREVIEW_DISTANCE } from './render/camera.ts';
import { createRenderer, probeWebGpu } from './render/renderer.ts';
import { createPlaceholderScene } from './render/scene.ts';
import { FixedStepClock } from './sim/clock.ts';
import { DEFAULT_APPEARANCE } from './sim/character.ts';
import { createSimState, stepSim, type SimState } from './sim/simulation.ts';
import { Hud } from './ui/hud.ts';
import { Keyboard } from './ui/keyboard.ts';
import { TitleScreen } from './ui/title.ts';

/** How fast the character turns on the title screen, in radians per second. */
const PREVIEW_SPIN = 0.7;

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

  const { scene, character } = createPlaceholderScene(DEFAULT_APPEARANCE);
  const camera = new FollowCamera(window.innerWidth / window.innerHeight);
  camera.setBaseDistance(PREVIEW_DISTANCE);
  const clock = new FixedStepClock();
  const keyboard = new Keyboard(window);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.resize(window.innerWidth / window.innerHeight);
  });

  // The session is null until the title screen hands over a seed and a look.
  let session: { state: SimState; hud: Hud } | null = null;
  let spin = 0;
  let last = performance.now();

  const frame = (now: number): void => {
    const elapsed = now - last;
    last = now;

    if (session) {
      const steps = clock.advance(elapsed);
      for (let i = 0; i < steps; i++) stepSim(session.state, keyboard.sample());
      const p = session.state.player;
      character.group.position.set(p.x, 0, p.y);
      character.group.rotation.y = -p.heading;
      camera.update(elapsed / 1000, p);
      session.hud.update(session.state);
    } else {
      spin += (elapsed / 1000) * PREVIEW_SPIN;
      character.group.position.set(0, 0, 0);
      character.group.rotation.y = spin;
      camera.update(elapsed / 1000, { x: 0, y: 0, heading: 0, speed: 0 });
    }

    void renderer.render(scene, camera.camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  const title = new TitleScreen(
    document.body,
    { seed: readSeedFromLocation(location.hash), character: DEFAULT_APPEARANCE },
    (appearance) => character.set(appearance),
  );
  const choice = await title.wait();
  title.destroy();

  history.replaceState(null, '', writeSeedToHash(location.hash, choice.seed));
  camera.setBaseDistance(BASE_DISTANCE);
  session = {
    state: createSimState(seedFromString(choice.seed), choice.character),
    hud: new Hud(document.body, choice.seed),
  };
}

void boot();
