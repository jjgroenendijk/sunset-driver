import { Matrix4 } from 'three';
import type { Batch } from '../src/render/batch.ts';
import { describe, expect, it } from 'vitest';
import { cellGrid } from '../src/render/cells.ts';
import type { PackedPlants } from '../src/render/chunk-payload.ts';
import { EntityFade, FADE_BAND } from '../src/render/fade.ts';
import { createLampMaterials } from '../src/render/lamp-material.ts';
import { createPlantMaterial } from '../src/render/plant-material.ts';
import {
  ENTITY_CAPS,
  entityBudget,
  entityDistance,
  frameBudgetFrom,
  FRAME_BUDGET_MS,
  FULL_TIER,
  keptAt,
  QUALITY_TIERS,
  shadowDistance,
  thinned,
} from '../src/render/quality.ts';
import { postGraphs } from '../src/render/post.ts';
import { MIN_RENDER_SCALE } from '../src/render/renderer.ts';
import { SHADOW_DISTANCE, SHADOW_MAP_SIZE } from '../src/render/sky.ts';
import { REFLECTION_SCALE } from '../src/render/water-surface.ts';
import { FAR_RADIUS, NEAR_RADIUS, type TilePart } from '../src/render/streaming.ts';
import { PlantScenery } from '../src/render/vegetation.ts';
import { chunkBounds, CHUNK_SIZE } from '../src/world/chunks.ts';

describe('the quality tiers', () => {
  it('starts at full quality and only ever gets cheaper down the table', () => {
    expect(QUALITY_TIERS[0]).toBe(FULL_TIER);
    // The top tier is the game as it is drawn with no tier system at all.
    expect(FULL_TIER.post).toEqual({ renderScale: 1, bloom: true, smaa: true, grade: true });
    expect(FULL_TIER.rings).toEqual({ near: NEAR_RADIUS, far: FAR_RADIUS });
    expect(FULL_TIER.shadowMapSize).toBe(SHADOW_MAP_SIZE);
    expect(FULL_TIER.mirror).toBe(REFLECTION_SCALE);
    expect(FULL_TIER.density).toBe(1);

    for (let i = 1; i < QUALITY_TIERS.length; i++) {
      const above = QUALITY_TIERS[i - 1] as (typeof QUALITY_TIERS)[number];
      const tier = QUALITY_TIERS[i] as (typeof QUALITY_TIERS)[number];
      expect(tier.name).not.toBe(above.name);
      expect(tier.post.renderScale).toBeLessThanOrEqual(above.post.renderScale);
      expect(tier.rings.near).toBeLessThanOrEqual(above.rings.near);
      expect(tier.rings.far).toBeLessThanOrEqual(above.rings.far);
      expect(tier.shadowMapSize).toBeLessThanOrEqual(above.shadowMapSize);
      // The mirror never renders larger on a cheaper tier, and never goes away:
      // the reflection is what the sea is.
      expect(tier.mirror).toBeLessThanOrEqual(above.mirror);
      expect(tier.mirror).toBeGreaterThan(0);
      expect(tier.density).toBeLessThan(above.density);
      // An effect once off stays off: a cheaper tier never buys one back.
      expect(Number(tier.post.bloom)).toBeLessThanOrEqual(Number(above.post.bloom));
      expect(Number(tier.post.smaa)).toBeLessThanOrEqual(Number(above.post.smaa));
      // The near ring is always inside the far one, whatever the tier.
      expect(tier.rings.near).toBeLessThan(tier.rings.far);
    }
  });

  it('steps something real at every tier, and stops where the knobs run out', () => {
    // No tier repeats the one above it: a step the player cannot measure is a
    // window of frames spent for nothing.
    const shapes = QUALITY_TIERS.map((tier) => JSON.stringify({ ...tier, name: '' }));
    expect(new Set(shapes).size).toBe(QUALITY_TIERS.length);
    const last = QUALITY_TIERS[QUALITY_TIERS.length - 1] as (typeof QUALITY_TIERS)[number];
    expect(last.post.renderScale).toBe(MIN_RENDER_SCALE);
    // The grade is the look of spec section 10.6 and is never turned off.
    for (const tier of QUALITY_TIERS) expect(tier.post.grade).toBe(true);
  });

  it('draws entities to the edge of the ring the tier builds', () => {
    for (const tier of QUALITY_TIERS) {
      // Wherever in their chunk the player stands, ground this far off is in
      // the near ring, so nothing fades out that was never built.
      expect(entityDistance(tier)).toBe(tier.rings.near * CHUNK_SIZE);
      expect(entityDistance(tier)).toBeGreaterThan(FADE_BAND);
    }
    expect(entityDistance(FULL_TIER)).toBeGreaterThan(entityDistance(QUALITY_TIERS[3] as never));
  });

  it('stops the shadow of the sun before the plants start fading', () => {
    for (const tier of QUALITY_TIERS) {
      // The shadow pass cannot follow the dither, so a plant inside the band
      // would keep a whole shadow standing on empty ground. The shadow ends
      // first instead, which is also the cheaper way round.
      expect(shadowDistance(tier)).toBeLessThanOrEqual(entityDistance(tier) - FADE_BAND);
      expect(shadowDistance(tier)).toBeLessThanOrEqual(SHADOW_DISTANCE);
      expect(shadowDistance(tier)).toBeGreaterThan(0);
    }
    // The shadow reaches as far as the camera sees and no tier pulls the rings
    // in past that, so every tier keeps the whole range.
    expect(shadowDistance(FULL_TIER)).toBe(SHADOW_DISTANCE);
    expect(shadowDistance(QUALITY_TIERS[3] as never)).toBe(SHADOW_DISTANCE);
  });
});

describe('the post graphs of the tiers', () => {
  it('holds one graph per set of effects, whatever the render scale', () => {
    const graphs = postGraphs(QUALITY_TIERS.map((tier) => tier.post));
    // A graph is what a WGSL program is built from, and the render scale is not
    // part of it: the top two tiers draw the same effects at different sizes
    // and share one chain, so four tiers come to three graphs.
    expect(graphs.length).toBeLessThan(QUALITY_TIERS.length);
    const keys = graphs.map((graph) => `${graph.bloom}|${graph.grade}|${graph.smaa}`);
    expect(new Set(keys).size).toBe(graphs.length);
    // Every tier is drawn through one of them.
    for (const tier of QUALITY_TIERS) {
      const key = `${tier.post.bloom}|${tier.post.grade}|${tier.post.smaa}`;
      expect(keys).toContain(key);
    }
  });

  it('answers the graphs in the order they are first asked for', () => {
    const full = FULL_TIER.post;
    const graphs = postGraphs([full, { ...full, renderScale: 0.5 }, { ...full, bloom: false }]);
    expect(graphs).toHaveLength(2);
    expect(graphs[0]?.bloom).toBe(true);
    expect(graphs[1]?.bloom).toBe(false);
  });
});

describe('the entity caps', () => {
  it('caps a category at full quality and thins it below', () => {
    const plenty = 10_000;
    expect(entityBudget(FULL_TIER, 'plants', plenty)).toBe(ENTITY_CAPS.plants);
    expect(entityBudget(FULL_TIER, 'lamps', plenty)).toBe(ENTITY_CAPS.lamps);
    // A chunk with less than the cap is left alone, whatever the tier.
    expect(entityBudget(FULL_TIER, 'plants', 12)).toBe(12);
    for (const tier of QUALITY_TIERS) expect(entityBudget(tier, 'lamps', 1)).toBe(1);

    let last = plenty;
    for (const tier of QUALITY_TIERS) {
      const budget = entityBudget(tier, 'plants', plenty);
      expect(budget).toBeLessThan(last);
      expect(budget).toBeGreaterThan(0);
      last = budget;
    }
  });

  it('spreads what it keeps over the whole list rather than taking a prefix', () => {
    const list = Array.from({ length: 100 }, (_, i) => i);
    const kept = thinned(list, 10);
    expect(kept).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    // Nothing is kept twice, and the list ends near its own end.
    expect(new Set(kept).size).toBe(kept.length);

    // An awkward ratio still keeps exactly what was asked for, in order.
    const odd = thinned(list, 7);
    expect(odd).toHaveLength(7);
    for (let i = 1; i < odd.length; i++) expect(odd[i]).toBeGreaterThan(odd[i - 1] as number);

    // A limit at or over the length hands the list back untouched.
    expect(thinned(list, 100)).toBe(list);
    expect(thinned(list, 400)).toBe(list);
    expect(thinned([], 4)).toEqual([]);

    // Every index it picks is one the list holds.
    for (let count = 1; count <= 40; count++) {
      for (let kept2 = 1; kept2 <= count; kept2++) {
        for (let i = 0; i < kept2; i++) {
          const at = keptAt(i, count, kept2);
          expect(at).toBeGreaterThanOrEqual(0);
          expect(at).toBeLessThan(count);
        }
      }
    }
  });
});

describe('the frame budget', () => {
  it('takes the budget a session was started with off the query string', () => {
    expect(frameBudgetFrom('')).toBe(FRAME_BUDGET_MS);
    expect(frameBudgetFrom('?seed=sunset')).toBe(FRAME_BUDGET_MS);
    expect(frameBudgetFrom('?budget=6')).toBe(6);
    expect(frameBudgetFrom('?seed=sunset&budget=2.5')).toBe(2.5);
    // Anything unreadable, or outside a frame the tiers could serve, is ignored.
    for (const search of ['?budget=', '?budget=slow', '?budget=0', '?budget=-4', '?budget=1e6']) {
      expect(frameBudgetFrom(search)).toBe(FRAME_BUDGET_MS);
    }
  });
});

describe('a chunk thinned to its tier', () => {
  /** The cells of the chunk the plants stand in. */
  const grid = cellGrid(chunkBounds(0, 0), 'near');

  /** A chunk's worth of plants in a row across it, all of the first model the world grows. */
  function plantsOf(count: number): PackedPlants {
    const matrices = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) new Matrix4().makeTranslation((i * CHUNK_SIZE) / count, 0, 10).toArray(matrices, i * 16);
    return { models: new Uint16Array(count), matrices };
  }

  /** Plants a built part copies into its batches, once every step has run. */
  function instances(part: TilePart): number {
    for (const step of part.steps) step();
    return part.objects.reduce((sum, mesh) => sum + (mesh as Batch).parts, 0);
  }

  it('places what the tier allows and no more, in the same batches either way', () => {
    const scenery = new PlantScenery(new EntityFade(500));
    const plants = plantsOf(300);

    // The row crosses both cells of the near side of the chunk.
    const whole = scenery.build(grid, plants);
    expect(whole.drawCalls).toBe(2);
    expect(instances(whole)).toBe(300);
    whole.dispose();

    const limit = entityBudget(QUALITY_TIERS[3] as never, 'plants', 300);
    const thin = scenery.build(grid, plants, limit);
    // A thinned chunk costs the same draw calls: the tiers cut what is drawn,
    // not how many draws it takes (spec section 9.2).
    expect(thin.drawCalls).toBe(2);
    expect(instances(thin)).toBe(limit);
    expect(limit).toBeLessThan(300);
    thin.dispose();

    scenery.dispose();
  });
});

describe('the near-camera fade', () => {
  it('carries one distance and one focus for every category', () => {
    const fade = new EntityFade(entityDistance(FULL_TIER));
    expect(fade.distance).toBe(entityDistance(FULL_TIER));
    fade.distance = 250;
    expect(fade.distance).toBe(250);
    // Moving the focus is two numbers a frame and rebuilds nothing.
    fade.focus(120, -40);
    fade.focus(121, -40);
  });

  it('dresses a material to dither out rather than to blend', () => {
    const fade = new EntityFade(500);
    const plant = createPlantMaterial();
    expect(plant.opacityNode).toBeNull();
    fade.dress(plant);
    expect(plant.opacityNode).not.toBeNull();
    // The dither is the alpha test: a fragment is kept whole or thrown away,
    // so nothing has to be sorted back to front (spec section 9.2).
    expect(plant.alphaTestNode).not.toBeNull();
    expect(plant.transparent).toBe(false);
    plant.dispose();

    const lamps = createLampMaterials();
    fade.dress(lamps.lamp);
    expect(lamps.lamp.alphaTestNode).not.toBeNull();
    expect(lamps.lamp.transparent).toBe(false);
    lamps.dispose();
  });
});
