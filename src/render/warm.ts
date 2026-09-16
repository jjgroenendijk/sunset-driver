/**
 * What is paid for behind the loading screen rather than on the street (spec
 * sections 9.2, 10.6): every post graph drawn once, and the quality tier
 * handed to the two halves that draw at it.
 *
 * WebGPU builds a pass's shaders the first time it draws with it, on the frame
 * thread. A session that meets its first mirror, cascade or post chain while
 * the player is driving stutters; one that met them here does not.
 */
import type { PostChain } from './post.ts';
import { postGraphs } from './post.ts';
import { QUALITY_TIERS, type QualityChange } from './quality.ts';
import type { WorldScene } from './world-scene.ts';

/**
 * Draw one frame through each post graph, with the water in view, before the
 * session starts.
 *
 * The four quality tiers come to three graphs, and a graph is built once and
 * kept, so a tier change later swaps to a chain the renderer has compiled. The
 * water sheet is shown for each of these frames, which is what compiles the
 * mirror pass on an inland session that would otherwise meet it the first time
 * it drives to the sea. The render scale stays where it stands: what a program
 * is keyed on is the graph, not the size the frame is drawn at.
 *
 * An animation frame is waited for between them, so the loading screen is drawn
 * rather than held still.
 */
export async function warmPasses(world: WorldScene, post: PostChain): Promise<void> {
  const standing = post.quality;
  for (const graph of postGraphs(QUALITY_TIERS.map((tier) => tier.post))) {
    post.quality = { ...graph, renderScale: standing.renderScale };
    world.showWater();
    post.render();
    await new Promise((frame) => requestAnimationFrame(frame));
  }
  post.quality = standing;
}

/**
 * Hand a tier to the two halves that draw at it, and say so (spec section 9.2).
 *
 * The line in the console is how a tier change is read back after the fact:
 * the player sees a frame that holds its rate, and the log says what it cost.
 */
export function applyQuality(world: WorldScene, post: PostChain, change: QualityChange, budget: number): void {
  world.quality = change.to;
  post.quality = change.to.post;
  console.info(
    `quality: ${change.from.name} -> ${change.to.name} at ${change.frameMs.toFixed(1)} ms a frame ` +
      `(budget ${budget} ms)`,
  );
}
