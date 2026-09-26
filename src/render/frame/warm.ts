/**
 * Compiling the shaders of a session before it starts (spec sections 9.2, 10.6).
 *
 * three.js builds a WGSL program on the frame thread, and one costs about a
 * quarter of a second. A program is keyed on the material, the layout of the
 * geometry it is drawn over and the pass it is drawn in, so the first frame
 * that meets a combination the renderer has not met before stops the game. The
 * cure is to meet every combination here, behind the loading screen.
 *
 * Every combination is met by drawing frames through the post chain itself, one
 * batch of same-material objects at a time:
 *
 * - **Through the post chain, not `renderer.compileAsync`.** The chain draws
 *   the city into a render target of its own format, and the pipeline a
 *   material draws with there is another one than `compileAsync` builds for the
 *   canvas — a set the game never draws with at all. Warming through the chain
 *   compiles the pipelines the session actually uses, and the sun's shadow
 *   cascades and the water's mirror run in their own passes over whatever the
 *   frame holds, so a material's programs for those meet the same frame.
 * - **One material at a time, not the city at once.** The scene's objects are
 *   grouped by material, and one frame is drawn for each group with the rest
 *   held hidden. A frame costs what one material costs to compile, and an
 *   animation frame is waited for after each, so the loading screen keeps
 *   drawing its own progress however dear a material proves. The wait is also
 *   what gives each group a frame of its own: three.js draws a shadow map once
 *   per animation frame however many times the scene is rendered, so two groups
 *   drawn in one frame warm one shadow pass between them.
 * - **Every object of the material, drawn or not.** Hidden objects are shown
 *   and frustum culling comes off for the group's frame, and an empty
 *   instanced pool — most of what a session meets while driving — is given one
 *   instance for it. An object that streams or spawns afterwards is drawn with
 *   a program the renderer already holds: the chunk workers build every batch
 *   of a kind the same way, and an entity is drawn out of a pool that was made
 *   before the session started.
 * - **Every quality tier's post graph.** The four tiers come to three graphs,
 *   and one frame is drawn through each, so a tier change swaps a graph rather
 *   than builds one.
 *
 * The warm-up therefore runs last of everything the loading screen covers: a
 * program is compiled for the object it draws, not for the material alone, so
 * every view has to be in the scene before it starts.
 */
import type { Object3D } from 'three';
import { postGraphs, type PostChain } from '../look/post.ts';
import { QUALITY_TIERS } from './quality.ts';
import type { WorldScene } from '../world-scene.ts';

/** One material and every object the scene draws with it. */
interface MaterialGroup {
  objects: Object3D[];
}

/** An `Object3D` that is drawn with something, which is what the warm-up walks. */
type Drawn = Object3D & { material?: unknown };

/** The instanced-mesh fields the warm-up reads, which a plain `Object3D` lacks. */
type Pool = { isInstancedMesh?: boolean; count: number };

export async function warmPasses(
  world: WorldScene,
  post: PostChain,
  progress?: (done: number, total: number) => void,
): Promise<void> {
  const groups = materialGroups(world.scene);
  // The sheet spans the map but is drawn only where the camera can see water,
  // so an inland session never runs the mirror pass. Showing it here is what
  // compiles that pass; `WorldScene.look` hides it again in the first frame of
  // the session.
  world.showWater();
  let done = 0;
  while (done < groups.length) {
    // The sun's shadow maps are drawn for the first pass of a frame that asks
    // for them and reused by the rest, and `WorldScene.look` is what asks. The
    // warm-up draws its frames without it.
    world.drawShadow();
    drawGroup(groups[done] as MaterialGroup, post);
    done++;
    progress?.(done, groups.length);
    await new Promise((frame) => requestAnimationFrame(frame));
  }
  await warmGraphs(post);
}

/**
 * Draw one frame through the post graph of every quality tier, and put the
 * standing tier back. A tier change swaps graphs, and a graph met first while
 * driving is built and compiled on the frame thread: the change to the low
 * tier held the game still for 1.4 s (issue #436). The render scale stays
 * where it stands, because a program is keyed on the graph and not on the
 * size the frame is drawn at.
 */
async function warmGraphs(post: PostChain): Promise<void> {
  const standing = post.quality;
  for (const graph of postGraphs(QUALITY_TIERS.map((tier) => tier.post))) {
    post.quality = { ...graph, renderScale: standing.renderScale };
    post.render();
    await new Promise((frame) => requestAnimationFrame(frame));
  }
  post.quality = standing;
  // A graph built here may carry SMAA, whose tables arrive a turn later.
  await post.ready();
}

/**
 * The scene's draw objects, grouped by the material each is drawn with and in
 * the order the scene holds them, so two runs of one seed warm in one order.
 */
function materialGroups(scene: { traverse: (visit: (object: Object3D) => void) => void }): MaterialGroup[] {
  const groups: MaterialGroup[] = [];
  const byMaterial = new Map<unknown, MaterialGroup>();
  scene.traverse((object) => {
    const material = (object as Drawn).material;
    if (material === undefined) return;
    let group = byMaterial.get(material);
    if (group === undefined) {
      group = { objects: [] };
      byMaterial.set(material, group);
      groups.push(group);
    }
    group.objects.push(object);
  });
  return groups;
}

/**
 * Draw one material's objects for a frame and put the scene back as it was.
 * Hidden objects are shown, culling comes off and an empty pool is given one
 * instance, so the frame meets every combination the material is ever drawn
 * with — and nothing else is drawn, so the frame costs one material.
 */
function drawGroup(group: MaterialGroup, post: PostChain): void {
  const restore: (() => void)[] = [];
  for (const object of group.objects) {
    if (!object.visible) {
      object.visible = true;
      restore.push(() => {
        object.visible = false;
      });
    }
    if (object.frustumCulled) {
      object.frustumCulled = false;
      restore.push(() => {
        object.frustumCulled = true;
      });
    }
    // An instanced mesh that holds nothing draws nothing, and three.js keys a
    // program on the mesh itself, so an empty pool is a program the first car
    // of its class to drive past would build.
    const pool = object as unknown as Pool;
    if (pool.isInstancedMesh === true && pool.count === 0) {
      pool.count = 1;
      restore.push(() => {
        pool.count = 0;
      });
    }
  }
  post.render();
  for (const call of restore) call();
}
