import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { bakedPoint, bakeWalks, BONES, FRAMES, PART_GUITAR, pedestrianBody } from '../src/render/pedestrian-rig.ts';
import { GAITS, STRIDE_HEIGHT } from '../src/sim/pedestrian-look.ts';

describe('the pedestrian rig and its walk cycles (spec sections 13.1, 22.1)', () => {
  const data = bakeWalks();
  // A foot and a hand in the bind pose, each on its own bone.
  const foot = new Vector3(0.05, 0.02, 0);
  const hand = new Vector3(0, 0.9, 0);

  it('builds one body a person tall, every vertex bound to one bone and one colour', () => {
    const body = pedestrianBody();
    body.computeBoundingBox();
    const box = body.boundingBox!;
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(box.max.y).toBeGreaterThan(STRIDE_HEIGHT - 0.05);
    expect(box.max.y).toBeLessThan(STRIDE_HEIGHT + 0.05);
    const bones = body.getAttribute('bone');
    const parts = body.getAttribute('part');
    for (let i = 0; i < bones.count; i++) {
      expect(Number.isInteger(bones.getX(i)) && bones.getX(i) >= 0 && bones.getX(i) < BONES.length).toBe(true);
      expect(parts.getX(i) >= 0 && parts.getX(i) <= PART_GUITAR).toBe(true);
      expect(body.getAttribute('skinIndex').getX(i)).toBe(bones.getX(i));
    }
    body.dispose();
  });

  it('bakes a frame of every gait into the texture, standing still in the bind pose', () => {
    expect(data.length).toBe(BONES.length * 4 * GAITS.length * FRAMES * 4);
    for (const bone of BONES) {
      const at = bakedPoint(data, 'stand', 0, bone, foot);
      expect(at.distanceTo(foot), bone).toBeLessThan(0.02);
    }
  });

  it('swings the legs against each other and each arm against its leg', () => {
    for (const gait of ['stroll', 'brisk', 'amble', 'run'] as const) {
      // A quarter of the way through the cycle the left thigh is furthest forward.
      const quarter = FRAMES / 4;
      const left = bakedPoint(data, gait, quarter, 'shinL', foot);
      const right = bakedPoint(data, gait, quarter, 'shinR', foot);
      expect(left.x, gait).toBeGreaterThan(foot.x + 0.1);
      expect(right.x, gait).toBeLessThan(foot.x - 0.1);
      expect(bakedPoint(data, gait, quarter, 'armL', hand).x, gait).toBeLessThan(0);
      expect(bakedPoint(data, gait, quarter, 'armR', hand).x, gait).toBeGreaterThan(0);
      // Half a cycle on, the two legs have changed places.
      expect(bakedPoint(data, gait, quarter * 3, 'shinR', foot).x).toBeCloseTo(left.x, 3);
    }
    // A run swings further than a stroll.
    const reach = (gait: 'stroll' | 'run'): number => bakedPoint(data, gait, FRAMES / 4, 'shinL', foot).x;
    expect(reach('run')).toBeGreaterThan(reach('stroll'));
  });
});
