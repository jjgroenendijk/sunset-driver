import { describe, expect, it } from 'vitest';
import {
  boxesOf,
  shapeOf,
  type BuildingPlan,
  type BuildingShape,
  type ShapeBox,
} from '../src/render/building-shape.ts';

/** A lot big enough that no plan is turned down for want of room. */
const ROOM = { width: 34, depth: 30, height: 120 };

/** Every plan a tall building can be massed in. */
const PLANS: readonly BuildingPlan[] = ['box', 'step', 'ell', 'u', 'court', 'podium', 'setbacks'];

/** The first seed that masses a building of this kind in this plan. */
function seedFor(plan: BuildingPlan, kind: 'tower' | 'mid-rise', shared = { left: false, right: false }): number {
  for (let seed = 1; seed < 4000; seed++) {
    if (shapeOf(seed, kind, ROOM, shared).plan === plan) return seed;
  }
  throw new Error(`no seed masses a ${kind} as ${plan}`);
}

/** Which kinds a plan is drawn for. */
const KIND_OF: Readonly<Record<BuildingPlan, 'tower' | 'mid-rise'>> = {
  box: 'tower',
  step: 'mid-rise',
  ell: 'tower',
  u: 'mid-rise',
  court: 'mid-rise',
  podium: 'tower',
  setbacks: 'tower',
};

describe('the shape a tall building is massed in', () => {
  it('masses one of every plan, and nothing else for the kinds that are not tall', () => {
    for (const plan of PLANS) expect(shapeOf(seedFor(plan, KIND_OF[plan]), KIND_OF[plan], ROOM).plan).toBe(plan);
    for (const kind of ['house', 'shop-row', 'warehouse', 'parking-garage', 'roadhouse'] as const) {
      for (let seed = 1; seed < 50; seed++) expect(shapeOf(seed, kind, ROOM).plan, kind).toBe('box');
    }
  });

  it('keeps every box inside the footprint, on the ground and under the top', () => {
    for (const plan of PLANS) {
      const kind = KIND_OF[plan];
      const shape = shapeOf(seedFor(plan, kind), kind, ROOM);
      const rect = { width: 24, depth: 20 };
      for (const box of boxesOf(shape, rect, 90, 0)) {
        const where = `${plan} box`;
        expect(box.x - box.width / 2, where).toBeGreaterThanOrEqual(-rect.width / 2 - 1e-6);
        expect(box.x + box.width / 2, where).toBeLessThanOrEqual(rect.width / 2 + 1e-6);
        expect(box.z - box.depth / 2, where).toBeGreaterThanOrEqual(-rect.depth / 2 - 1e-6);
        expect(box.z + box.depth / 2, where).toBeLessThanOrEqual(rect.depth / 2 + 1e-6);
        expect(box.from, where).toBeGreaterThanOrEqual(0);
        expect(box.to, where).toBeLessThanOrEqual(90 + 1e-6);
        expect(box.to, where).toBeGreaterThan(box.from);
      }
    }
  });

  it('covers the whole frontage with the box on the ground, so a row shares its walls', () => {
    for (const plan of PLANS) {
      const kind = KIND_OF[plan];
      const shape = shapeOf(seedFor(plan, kind), kind, ROOM);
      const rect = { width: 24, depth: 20 };
      // The frontage carries a wall from end to end. Every side edge carries
      // one from the front of the lot to the back of it, except an L's, which
      // cuts its notch out of one back corner — `planOf` only draws an L where
      // that corner has no neighbour against it.
      let left = false;
      let right = false;
      let frontage = 0;
      for (const box of boxesOf(shape, rect, 90, 0)) {
        if (box.from > 1e-6) continue;
        if (box.z - box.depth / 2 <= -rect.depth / 2 + 1e-6) {
          if (box.x - box.width / 2 <= -rect.width / 2 + 1e-6) left = true;
          if (box.x + box.width / 2 >= rect.width / 2 - 1e-6) right = true;
        }
        if (box.z + box.depth / 2 >= rect.depth / 2 - 1e-6) frontage += box.width;
      }
      expect(frontage, `${plan} frontage`).toBeCloseTo(rect.width, 6);
      expect(plan === 'ell' ? left || right : left && right, `${plan} side edges`).toBe(true);
    }
  });

  it('never cuts an L out of a lot that is walled on both sides', () => {
    for (let seed = 1; seed < 500; seed++) {
      expect(shapeOf(seed, 'tower', ROOM, { left: true, right: true }).plan).not.toBe('ell');
    }
    // Walled on one side, the notch goes on the other.
    for (const side of ['left', 'right'] as const) {
      const shared = { left: side === 'left', right: side === 'right' };
      const shape = shapeOf(seedFor('ell', 'tower', shared), 'tower', ROOM, shared);
      const arm = shape.parts[1] as { x: number };
      // The lot's `left` side edge is the one at local +x, and the wing stands
      // on the side that may not be cut into.
      expect(Math.sign(arm.x), side).toBe(side === 'left' ? 1 : -1);
    }
  });

  it('lays the same shape on any rectangle, so the silhouette holds at every detail', () => {
    for (const plan of PLANS) {
      const kind = KIND_OF[plan];
      const shape = shapeOf(seedFor(plan, kind), kind, ROOM);
      const small = boxesOf(shape, { width: 12, depth: 10 }, 60, 0);
      const large = boxesOf(shape, { width: 24, depth: 20 }, 120, 0);
      expect(large).toHaveLength(small.length);
      for (let i = 0; i < small.length; i++) {
        const a = small[i] as ShapeBox;
        const b = large[i] as ShapeBox;
        expect(b.width, plan).toBeCloseTo(a.width * 2, 6);
        expect(b.x, plan).toBeCloseTo(a.x * 2, 6);
        expect(b.to, plan).toBeCloseTo(a.to * 2, 6);
      }
    }
  });

  it('gives neighbours in one row their own storey and their own bay', () => {
    const storeys = new Set<number>();
    const bays = new Set<number>();
    for (let seed = 1; seed < 20; seed++) {
      const shape: BuildingShape = shapeOf(seed * 7919, 'tower', ROOM);
      storeys.add(Math.round(shape.floorHeight * 100));
      bays.add(Math.round(shape.bayWidth * 100));
      // Both run upward from the plainest: a narrower bay is another pier and
      // another window on every floor of every tower of the core.
      expect(shape.floorHeight).toBeGreaterThanOrEqual(4);
      expect(shape.bayWidth).toBeGreaterThanOrEqual(4.2);
    }
    expect(storeys.size).toBeGreaterThan(15);
    expect(bays.size).toBeGreaterThan(15);
  });
});
