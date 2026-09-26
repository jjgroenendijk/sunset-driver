/**
 * A worker that generates the world of a seed (spec section 9.1).
 *
 * Generation is the one thing a session cannot start without, and it takes
 * half a second or more. Run on the main thread it stops the frame loop dead:
 * the title screen freezes mid-swing and the loading screen cannot draw its
 * own progress. Run here it costs the frame nothing.
 *
 * The world is a pure function of the seed, so the world this builds is the
 * world the main thread would have built. `world-source.ts` is the other side
 * of this conversation.
 */
import type { WorldDescription } from '../../world/types.ts';
import { generateWorld } from '../../world/world.ts';

/** Generate this seed. One message, one answer, and the worker is done. */
export interface WorldCommand {
  seed: number;
}

/** The world that seed builds, as plain arrays and objects. */
export interface WorldReply {
  world: WorldDescription;
}

/**
 * What a dedicated worker's global scope offers, typed as `chunk-worker.ts`
 * types it and for the same reason: the project is built with the DOM library
 * and a worker library cannot be added beside it.
 */
interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

const scope = self as unknown as WorkerScope;

scope.addEventListener('message', (event: MessageEvent) => {
  const command = event.data as WorldCommand;
  scope.postMessage({ world: generateWorld(command.seed) } satisfies WorldReply);
});
