/**
 * The frames the warm-up draws (`src/render/warm.ts`).
 *
 * A program is built the first time the renderer meets a material, a geometry
 * layout and a pass together, and the shadow pass is one of those passes. What
 * is pinned here is what a group's frame needs to meet it: the sun's shadow
 * maps asked for, and an animation frame of the group's own. three.js draws a
 * shadow map for the first pass of an animation frame that asks and hands the
 * same map to every later one, so two material groups drawn inside one frame
 * warm one shadow pass between them, and the second group's shadow program is
 * built while the player drives (issue #364).
 */
import { Mesh, MeshBasicMaterial, Scene } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PostChain } from '../src/render/post.ts';
import { warmPasses } from '../src/render/warm.ts';
import type { WorldScene } from '../src/render/world-scene.ts';

/** One frame of the warm-up, as the fakes below saw it. */
interface Frame {
  /** Were the sun's shadow maps asked for since the frame before? */
  shadowAsked: boolean;
  /** Animation frames waited for before this one was drawn. */
  waits: number;
}

/** A scene of `count` meshes, each drawn with a material of its own. */
function sceneOfMaterials(count: number): Scene {
  const scene = new Scene();
  for (let i = 0; i < count; i++) scene.add(new Mesh(undefined, new MeshBasicMaterial()));
  return scene;
}

describe('the shader warm-up', () => {
  let waits = 0;
  let rafs: typeof globalThis.requestAnimationFrame;

  beforeEach(() => {
    waits = 0;
    rafs = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((run: FrameRequestCallback): number => {
      waits++;
      queueMicrotask(() => run(waits));
      return waits;
    }) as typeof globalThis.requestAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = rafs;
  });

  it('asks for the shadow maps and waits a frame for every material it draws', async () => {
    const materials = 6;
    const scene = sceneOfMaterials(materials);
    const frames: Frame[] = [];
    let shadowAsked = false;
    let shown = false;

    const post = {
      quality: { renderScale: 1, bloom: true, smaa: false, grade: true },
      render(): void {
        frames.push({ shadowAsked, waits });
        shadowAsked = false;
      },
      async ready(): Promise<void> {},
    } as unknown as PostChain;
    const world = {
      scene,
      showWater(): void {
        shown = true;
      },
      drawShadow(): void {
        shadowAsked = true;
      },
    } as unknown as WorldScene;

    await warmPasses(world, post);

    // The sheet is in the frame, or an inland session compiles the mirror the
    // first time the sea comes into view.
    expect(shown).toBe(true);
    const groups = frames.slice(0, materials);
    // Every material's frame is drawn with the shadow maps asked for, and in an
    // animation frame no other material's is drawn in.
    expect(groups.map((frame) => frame.shadowAsked)).toEqual(groups.map(() => true));
    expect(new Set(groups.map((frame) => frame.waits)).size).toBe(materials);
    // The frames after the groups are the post graphs of the quality tiers.
    expect(frames.length).toBeGreaterThan(materials);
  });
});
