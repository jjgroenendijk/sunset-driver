import { readSeedFromLocation, seedFromString, writeSeedToHash } from './core/seed.ts';
import { FollowCamera } from './render/camera.ts';
import { createRenderer, probeWebGpu } from './render/renderer.ts';
import { createPlaceholderScene } from './render/scene.ts';
import { FixedStepClock } from './sim/clock.ts';
import { createSimState, stepSim } from './sim/simulation.ts';
import { Hud } from './ui/hud.ts';
import { Keyboard } from './ui/keyboard.ts';

async function boot(): Promise<void> {
  const status = document.getElementById('status');
  const probe = await probeWebGpu();
  if (!probe.ok) {
    if (status) status.textContent = probe.reason;
    return;
  }

  const seedText = readSeedFromLocation(location.hash);
  history.replaceState(null, '', writeSeedToHash(location.hash, seedText));
  const seed = seedFromString(seedText);

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = await createRenderer(canvas);
  document.getElementById('splash')?.remove();
  canvas.hidden = false;

  const { scene, player } = createPlaceholderScene();
  const camera = new FollowCamera(window.innerWidth / window.innerHeight);
  const hud = new Hud(document.body, seedText);
  const keyboard = new Keyboard(window);
  const clock = new FixedStepClock();
  const state = createSimState(seed);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.resize(window.innerWidth / window.innerHeight);
  });

  let last = performance.now();
  const frame = (now: number): void => {
    const elapsed = now - last;
    last = now;
    const steps = clock.advance(elapsed);
    for (let i = 0; i < steps; i++) stepSim(state, keyboard.sample());

    const p = state.player;
    player.position.set(p.x, 0.6, p.y);
    player.rotation.y = -p.heading;
    camera.update(elapsed / 1000, p);
    hud.update(state);
    void renderer.render(scene, camera.camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void boot();
