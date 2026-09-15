import { describe, expect, it } from 'vitest';
import { SURFACE_RAISE, KERB_RISE } from '../src/render/road-section.ts';
import { ZONE_LOOKS } from '../src/sim/pedestrian-look.ts';
import { CARRIAGEWAY_RISE, PAVEMENT_RISE, pavementOffset } from '../src/sim/pedestrian-route.ts';
import {
  AmbientPedestrians,
  createPedestrianState,
  releaseFar,
  startledOf,
  startledPose,
  type PedestrianCursor,
  type PedestrianPose,
} from '../src/sim/pedestrians.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { Point } from '../src/world/types.ts';
import { stableJson, sweepSeeds } from './helpers.ts';
import { GRID_SPACING, gridTrafficRoads } from './traffic-grid.ts';

/** People each seed follows tick by tick. */
const FOLLOWED = process.env.SWEEP_SEEDS ? 40 : 8;
const SEEDS = sweepSeeds(process.env.SWEEP_SEEDS ? 6 : 2);

const pose = (): PedestrianPose => ({ x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' });
// Flat, so the height a person stands at is the rise of what they stand on.
const roads = { ...gridTrafficRoads(), heightAt: () => 0 };
const crowdOf = (seed: number): AmbientPedestrians => new AmbientPedestrians(seed, roads);

describe('ambient pedestrians (spec sections 5.3, 13.1)', () => {
  it('evaluates a person on demand at tick N exactly where stepping them from tick 0 puts them', () => {
    for (const seed of SEEDS) {
      const crowd = crowdOf(seed);
      expect(crowd.people.length, `seed ${seed}`).toBeGreaterThan(100);
      const stride = Math.max(1, Math.floor(crowd.people.length / FOLLOWED));
      for (let id = 0; id < crowd.people.length; id += stride) {
        const person = crowd.people[id] as AmbientPedestrians['people'][number];
        const cursor: PedestrianCursor = crowd.cursorAt(id, 0);
        // Past a whole loop, so the wrap back to the start is covered.
        const end = person.period + 613;
        for (let tick = 1; tick <= end; tick++) {
          crowd.advance(cursor);
          if (tick % 1009 !== 0 && tick !== end) continue;
          expect(cursor, `seed ${seed}, person ${id}, tick ${tick}`).toEqual(crowd.cursorAt(id, tick));
          expect(crowd.pose(cursor, pose())).toEqual(crowd.poseAt(id, tick, pose()));
        }
      }
    }
  });

  it('is the same crowd for the same seed and a different crowd for another', () => {
    const [a, b] = SEEDS as [number, number];
    const summary = (crowd: AmbientPedestrians): string =>
      stableJson(crowd.people.map((p) => [p.look, p.side, p.phase, p.period, Array.from(p.route.edges)]));
    expect(summary(crowdOf(a))).toBe(summary(crowdOf(a)));
    expect(summary(crowdOf(a))).not.toBe(summary(crowdOf(b)));
  });

  it('walks the pavements, steps down only to cross a road, and comes round the loop smoothly', () => {
    const crowd = crowdOf(SEEDS[0] as number);
    const cursor: PedestrianCursor = { id: 0, at: 0 };
    const walked = roads.roads.filter((road) => TIERS[road.tier].pavement > 0);
    let onPavement = 0;
    let crossing = 0;
    for (const person of crowd.people) {
      expect(person.route.length).toBeGreaterThan(0);
      for (let tick = 0; tick < 30_000; tick += 997) {
        crowd.cursorAt(person.id, tick, cursor);
        const p = crowd.pose(cursor, pose());
        const rise = p.height;
        const off = Math.min(...walked.map((road) => distanceTo(road.points, p.x, p.y) - TIERS[road.tier].width / 2));
        // A pose read across the kerb stands between the two heights, and is neither.
        if (rise > PAVEMENT_RISE - 1e-9) {
          // On a pavement: outside every carriageway, and no further out than the pavement.
          onPavement++;
          expect(off, `person ${person.id} at tick ${tick}`).toBeGreaterThan(0);
          expect(off).toBeLessThan(Math.max(...walked.map((road) => TIERS[road.tier].verge + TIERS[road.tier].pavement)) + 0.5);
        } else if (rise < CARRIAGEWAY_RISE + 1e-9) {
          // Crossing: only ever inside a junction or across a road beside one.
          crossing++;
          expect(nearestCrossing(p), `person ${person.id} at tick ${tick}`).toBeLessThan(2 * pavementOffset({ tier: 'arterial' }));
        }
      }
      // The next pose is never more than a walk away, across a corner or the wrap of the loop.
      if (person.id % 25 !== 0) continue;
      let last = crowd.poseAt(person.id, 0, pose());
      for (let tick = 30; tick <= person.period + 30; tick += 30) {
        const next = crowd.poseAt(person.id, tick, pose());
        expect(Math.hypot(next.x - last.x, next.y - last.y), `person ${person.id} at tick ${tick}`).toBeLessThan(1.5);
        last = next;
      }
    }
    expect(onPavement).toBeGreaterThan(crossing * 3);
    expect(crossing).toBeGreaterThan(0);
  });

  it('stands on the pavement the road section draws', () => {
    expect(PAVEMENT_RISE).toBeCloseTo(SURFACE_RAISE + KERB_RISE, 6);
  });

  it('fills a busy district and thins a quiet one, and dresses each by its zone', () => {
    const split = new AmbientPedestrians(SEEDS[0] as number, roads, (x) => (x < 0 ? { zone: 'core', density: 1 } : { zone: 'suburban', density: 1 }));
    const west = split.people.filter((p) => ZONE_LOOKS.core.tops.includes(p.look.top)).length;
    const east = split.people.filter((p) => ZONE_LOOKS.suburban.tops.includes(p.look.top)).length;
    expect(west + east).toBe(split.people.length);
    expect(east).toBeGreaterThan(0);
    expect(west).toBeGreaterThan(east * 2);
    // On tick 0 a person stands on the run they were placed on, where their loop keeps it.
    let dressed = 0;
    let checked = 0;
    for (const person of split.people) {
      const at = split.poseAt(person.id, 0, pose());
      if (Math.abs(at.x) < GRID_SPACING / 2) continue;
      checked++;
      if (ZONE_LOOKS[at.x < 0 ? 'core' : 'suburban'].tops.includes(person.look.top)) dressed++;
    }
    expect(dressed / checked).toBeGreaterThan(0.7);
  });

  it('takes a whole number of strides round a loop, so the walk cycle never jumps', () => {
    const crowd = crowdOf(SEEDS[1] as number);
    for (const person of crowd.people.slice(0, 50)) {
      expect(crowd.poseAt(person.id, person.period - person.phase, pose()).cycle).toBeCloseTo(0, 9);
    }
  });

  it('startles the people in reach off their loops, and lets them go when they are far away', () => {
    const crowd = crowdOf(SEEDS[0] as number);
    const tick = 12_345;
    const at = crowd.poseAt(7, tick, pose());
    const state = createPedestrianState();
    const count = crowd.startle(state, tick, at.x + 1, at.y, 12, 'flee');
    expect(count).toBeGreaterThan(0);
    expect(state.startled.length).toBe(count);
    expect(state.startled.map((r) => r.id)).toEqual([...state.startled.map((r) => r.id)].sort((a, b) => a - b));
    const record = startledOf(state, 7);
    expect(record).toBeDefined();
    // They run off, away from the shot, and stand still once the reaction is over.
    const soon = startledPose(record!, tick + 60, pose());
    expect(Math.hypot(soon.x - at.x - 1, soon.y - at.y)).toBeGreaterThan(4);
    expect(soon.gait).toBe('run');
    const later = startledPose(record!, tick + 100_000, pose());
    expect(later.speed).toBe(0);
    expect(later.gait).toBe('stand');
    // A second shot does not startle them again.
    expect(crowd.startle(state, tick + 1, at.x, at.y, 12, 'scatter')).toBe(0);
    releaseFar(state, tick + 100_000, at.x, at.y, 20);
    expect(state.startled.length).toBe(0);
  });
});

/** Metres to the nearest place two walked roads meet or one ends. */
function nearestCrossing(p: PedestrianPose): number {
  let best = Infinity;
  for (const node of roads.graph.nodes) best = Math.min(best, Math.hypot(node.x - p.x, node.y - p.y));
  return best;
}

function distanceTo(points: readonly Point[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const l2 = vx * vx + vy * vy;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * vx + (y - a.y) * vy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - a.x - vx * t, y - a.y - vy * t));
  }
  return best;
}
