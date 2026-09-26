/**
 * The main thread's door onto `world-source-worker.ts`: the world of a seed,
 * built off the frame.
 *
 * One world is held at a time, because one is all a session plays in and one
 * is all the title screen draws. Asking for a seed already being built hands
 * back the same promise, so the title screen's map and the session that
 * follows it never build the same seed twice. Asking for another seed gives up
 * on the one in flight: the player changed their mind, and a worker left
 * running would take a core from the one that replaced it.
 */
import type { WorldDescription } from '../../world/types.ts';
import { generateWorld } from '../../world/world.ts';
import type { WorldCommand, WorldReply } from './world-source-worker.ts';

/** What a build in flight looks like from here. */
interface Build {
  seed: number;
  world: Promise<WorldDescription>;
  /** Stop the worker and reject the promise with {@link GIVEN_UP}. */
  cancel(): void;
}

/** Why a build's promise rejected when another seed replaced it. */
const GIVEN_UP = 'another seed was asked for';

export class WorldSource {
  private build: Build | null = null;

  /**
   * Start building `seed` now and pay no attention to the answer.
   *
   * This is what makes the wait after Start short: the seed the title screen
   * opens on is built while the player is still choosing a look, and Start
   * then finds it finished.
   */
  warm(seed: number): void {
    void this.get(seed).catch(() => undefined);
  }

  /** The world of `seed`, building it if nothing is already building it. */
  get(seed: number): Promise<WorldDescription> {
    const held = this.build;
    if (held !== null && held.seed === seed) return held.world;
    held?.cancel();
    this.build = startBuild(seed);
    return this.build.world;
  }

  /** Give up on whatever is in flight. */
  dispose(): void {
    this.build?.cancel();
    this.build = null;
  }
}

/**
 * Put one seed into a worker of its own. The worker answers once and is then
 * terminated: generation is a single job, not a service, and the layers the
 * chunk workers build are the memory worth keeping.
 *
 * Node has no `Worker` of this kind, and the previews and the tests import
 * this file, so generation falls back to the calling thread there.
 */
function startBuild(seed: number): Build {
  if (typeof Worker === 'undefined') {
    return { seed, world: Promise.resolve(generateWorld(seed)), cancel: () => {} };
  }
  const worker = new Worker(new URL('./world-source-worker.ts', import.meta.url), { type: 'module' });
  let give: ((reason: Error) => void) | undefined;
  const world = new Promise<WorldDescription>((resolve, reject) => {
    give = reject;
    worker.addEventListener('message', (event: MessageEvent) => {
      worker.terminate();
      resolve((event.data as WorldReply).world);
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      worker.terminate();
      reject(new Error(event.message === '' ? 'the world could not be built' : event.message));
    });
  });
  worker.postMessage({ seed } satisfies WorldCommand);
  return {
    seed,
    world,
    cancel: () => {
      worker.terminate();
      give?.(new Error(GIVEN_UP));
    },
  };
}
