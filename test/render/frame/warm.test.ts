/**
 * The frames the warm-up draws (`src/render/frame/warm.ts`).
 *
 * A program is built the first time the renderer meets a material, a geometry
 * layout and a pass together, and the shadow pass is one of those passes. What
 * is pinned here is what a group's frame needs to meet it: the sun's shadow
 * maps asked for, and a three.js frame of the group's own. three.js draws the
 * scene pass and the shadow maps once per frame of its own, so two material
 * groups drawn inside one frame warm one shadow pass between them, and the
 * second group's shadow program is built while the player drives (issue #364).
 * Several groups may share an animation frame, as long as each starts a
 * three.js frame (issue #799).
 */
import { Mesh, MeshBasicMaterial, Scene } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostChain } from '../../../src/render/look/post.ts';
import { warmPasses } from '../../../src/render/frame/warm.ts';
import type { WorldScene } from '../../../src/render/world-scene.ts';

/** One frame of the warm-up, as the fakes below saw it. */
interface Frame {
  /** Were the sun's shadow maps asked for since the frame before? */
  shadowAsked: boolean;
  /** three.js frames started before this one was drawn. */
  frame: number;
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
    vi.restoreAllMocks();
  });

  /** Warm a scene of `materials` materials and answer every frame it drew. */
  async function warm(materials: number, cost: number): Promise<Frame[]> {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const frames: Frame[] = [];
    let shadowAsked = false;
    let frame = 0;
    const post = {
      quality: { renderScale: 1, bloom: true, smaa: false, grade: true },
      render(): void {
        frames.push({ shadowAsked, frame, waits });
        shadowAsked = false;
        now += cost;
      },
      nextFrame(): void {
        frame++;
      },
      async ready(): Promise<void> {},
    } as unknown as PostChain;
    const world = {
      scene: sceneOfMaterials(materials),
      showWater(): void {},
      drawShadow(): void {
        shadowAsked = true;
      },
    } as unknown as WorldScene;
    await warmPasses(world, post);
    return frames;
  }

  it('asks for the shadow maps in a three.js frame of its own for every material', async () => {
    const materials = 6;
    const groups = (await warm(materials, 1)).slice(0, materials);
    expect(groups.map((frame) => frame.shadowAsked)).toEqual(groups.map(() => true));
    expect(new Set(groups.map((frame) => frame.frame)).size).toBe(materials);
  });

  it('draws cheap materials in one animation frame and lets the browser paint after a dear one', async () => {
    const materials = 6;
    const cheap = (await warm(materials, 1)).slice(0, materials);
    expect(new Set(cheap.map((frame) => frame.waits)).size).toBe(1);
    const dear = (await warm(materials, 100)).slice(0, materials);
    expect(new Set(dear.map((frame) => frame.waits)).size).toBe(materials);
  });

  it('shows the water sheet and draws the post graphs after the groups', async () => {
    let shown = false;
    const post = {
      quality: { renderScale: 1, bloom: true, smaa: false, grade: true },
      render(): void {},
      nextFrame(): void {},
      async ready(): Promise<void> {},
    } as unknown as PostChain;
    const render = vi.spyOn(post, 'render');
    const world = {
      scene: sceneOfMaterials(2),
      showWater(): void {
        shown = true;
      },
      drawShadow(): void {},
    } as unknown as WorldScene;
    await warmPasses(world, post);
    // The sheet is in the frame, or an inland session compiles the mirror the
    // first time the sea comes into view.
    expect(shown).toBe(true);
    expect(render.mock.calls.length).toBeGreaterThan(2);
  });
});
