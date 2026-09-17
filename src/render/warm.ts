/**
 * Compiling the shaders of a session before it starts (spec sections 9.2, 10.6).
 *
 * three.js builds a WGSL program on the frame thread, and one costs about a
 * quarter of a second. A program is keyed on the material, the layout of the
 * geometry it is drawn over and the pass it is drawn in, so the first frame
 * that meets a combination the renderer has not met before stops the game. The
 * cure is to meet every combination here, behind the loading screen.
 *
 * Four things widen the warm-up past `renderer.compileAsync(scene, camera)`:
 *
 * - **Every object, not the ones in view.** `compileAsync` walks the scene
 *   through the camera's frustum, so it compiles what that camera can see. A
 *   low block standing a street behind the player is skipped, and the frame it
 *   first comes into view builds its program. Frustum culling is turned off for
 *   the warm-up and put back afterwards, so every batch the settled chunks hold
 *   is compiled whatever the camera is pointed at.
 * - **Every object, not the ones drawn.** A pool that holds nothing yet is
 *   hidden, and an empty instanced mesh draws no instance, so neither is
 *   walked at all. That is most of what a session meets while driving: an
 *   ambient car of a class that had not passed yet, a parked car, a police
 *   car, a pedestrian. Each pool is shown with one instance for the warm-up.
 * - **Every pass, not the view pass.** The sun's shadow cascades and the
 *   water's mirror draw the same materials through their own cameras, and each
 *   is a program of its own. Drawing frames here runs them.
 * - **Every quality tier.** The four tiers come to three post graphs, and a
 *   graph is built once and kept, so a tier change later swaps to a chain the
 *   renderer has already compiled.
 *
 * The warm-up therefore runs last of everything the loading screen covers: a
 * program is compiled for the object it draws, not for the material alone, so
 * every view has to be in the scene before it starts.
 */
import type { PerspectiveCamera } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { postGraphs, type PostChain } from './post.ts';
import { QUALITY_TIERS } from './quality.ts';
import type { WorldScene } from './world-scene.ts';

/**
 * Compile the shaders of every pass the session will draw, over every batch
 * the settled chunks hold. Call it once, behind the loading screen, after the
 * chunks around the player have settled.
 *
 * An animation frame is waited for between the graphs, so the loading screen is
 * drawn rather than held still.
 */
export async function warmPasses(
  renderer: WebGPURenderer,
  world: WorldScene,
  post: PostChain,
  camera: PerspectiveCamera,
): Promise<void> {
  const restore = drawEverything(world);
  try {
    await renderer.compileAsync(world.scene, camera);
    const standing = post.quality;
    for (const graph of postGraphs(QUALITY_TIERS.map((tier) => tier.post))) {
      // The render scale stays where it stands: what a program is keyed on is
      // the graph, not the size the frame is drawn at.
      post.quality = { ...graph, renderScale: standing.renderScale };
      // The sheet spans the map but is drawn only where the camera can see
      // water, so an inland session never runs the mirror pass. Showing it here
      // is what compiles that pass; `WorldScene.look` hides it again next frame.
      world.showWater();
      post.render();
      await new Promise((frame) => requestAnimationFrame(frame));
    }
    post.quality = standing;
  } finally {
    restore();
  }
}

/**
 * Draw every object in the scene for the warm-up, and answer the call that puts
 * the scene back as it was. Hidden objects are shown, empty instanced pools are
 * given one instance, and frustum culling comes off.
 *
 * An object that streams or spawns afterwards is drawn with a program the
 * renderer already holds: the chunk workers build every batch of a kind the
 * same way, and an entity is drawn out of a pool that was made before the
 * session started.
 */
function drawEverything(world: WorldScene): () => void {
  const undo: (() => void)[] = [];
  world.scene.traverse((object) => {
    if (object.frustumCulled) {
      object.frustumCulled = false;
      undo.push(() => {
        object.frustumCulled = true;
      });
    }
    if (!object.visible) {
      object.visible = true;
      undo.push(() => {
        object.visible = false;
      });
    }
    // An instanced mesh that holds nothing draws nothing, and three.js keys a
    // program on the mesh itself, so an empty pool is a program the first car
    // of its class to drive past would build.
    const pool = object as unknown as { isInstancedMesh?: boolean; count: number };
    if (pool.isInstancedMesh === true && pool.count === 0) {
      pool.count = 1;
      undo.push(() => {
        pool.count = 0;
      });
    }
  });
  return (): void => {
    for (const call of undo) call();
  };
}
