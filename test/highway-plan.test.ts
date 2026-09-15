import { describe, expect, it } from 'vitest';
import { COUNTRY_DECK, HIGHWAY_RAMP, INTERCHANGE_CLEAR, planHighway } from '../src/world/highway-plan.ts';
import { CLEARANCE } from '../src/world/overpass.ts';
import { RoadNetwork } from '../src/world/road-network.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { Point, RoadCurve } from '../src/world/types.ts';

/** A straight line along x from 0 to `length`, with a point every `step` metres. */
function line(length: number, step = 30): Point[] {
  const points: Point[] = [];
  for (let x = 0; x <= length; x += step) points.push({ x, y: 0 });
  return points;
}

const city = (): boolean => true;
const country = (): boolean => false;

describe('the plan of a highway', () => {
  it('stays on the ground at each interchange and runs on a level deck between them in the city', () => {
    const points = line(1500);
    const last = points.length - 1;
    const plan = planHighway(points, [], [], [0, last], [], city);
    const lift = plan.lift as number[];
    for (let i = 0; i < points.length; i++) {
      if ((points[i] as Point).x <= INTERCHANGE_CLEAR || (points[i] as Point).x >= 1500 - INTERCHANGE_CLEAR) expect(lift[i]).toBe(0);
    }
    expect(Math.max(...lift)).toBe(CLEARANCE);
    // No ramp climbs harder than a highway may.
    for (let i = 0; i < last; i++) expect(Math.abs((lift[i + 1] as number) - (lift[i] as number)) / 30).toBeLessThanOrEqual(TIERS.highway.maxGrade + 1e-9);
    expect(plan.slots.length).toBeGreaterThan(20);
    for (const s of plan.slots) {
      expect(plan.bridges).toContain(s);
      for (let k = s - 1; k <= s + 2; k++) expect(lift[k]).toBe(CLEARANCE);
    }
  });

  it('rises on one short deck in the middle of each stretch in the country', () => {
    const points = line(1500);
    const plan = planHighway(points, [], [], [0, points.length - 1], [], country);
    const lift = plan.lift as number[];
    const level = points.filter((_, i) => lift[i] === CLEARANCE).map((p) => p.x);
    expect(Math.max(...level) - Math.min(...level)).toBeLessThanOrEqual(COUNTRY_DECK);
    expect((Math.max(...level) + Math.min(...level)) / 2).toBeCloseTo(750, -2);
    const raised = points.filter((_, i) => (lift[i] as number) > 0).map((p) => p.x);
    expect(Math.max(...raised) - Math.min(...raised)).toBeLessThan(COUNTRY_DECK + 2 * HIGHWAY_RAMP + 60);
  });

  it('stays on the ground where it passes under an earlier highway, and leaves no deck on a short stretch', () => {
    const points = line(1500);
    const under = planHighway(points, [], [], [0, points.length - 1], [750], city);
    const lift = under.lift as number[];
    expect(lift[25]).toBe(0);
    expect(planHighway(line(300), [], [], [0, 10], [], city).lift).toBeUndefined();
  });
});

describe('the clearance of a highway', () => {
  it('lets a later road cross it under a slot and nowhere else', () => {
    const points = line(1500);
    const plan = planHighway(points, [], [], [0, points.length - 1], [], city);
    const network = new RoadNetwork(4000, () => 0);
    network.add({ tier: 'highway', points, bridges: plan.bridges, tunnels: [], interchanges: [0, points.length - 1], slots: plan.slots, lift: plan.lift });


    const slot = (plan.slots[plan.slots.length >> 1] as number) + 0.5;
    const at = slot * 30;
    expect(network.stepOk({ x: at, y: -40 }, { x: at, y: 40 }, 'street')).toBe(true);
    expect(network.stepOk({ x: 115, y: -40 }, { x: 115, y: 40 }, 'street')).toBe(false);
  });
});
