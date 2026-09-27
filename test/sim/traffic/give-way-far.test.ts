/**
 * Skipping who is far from the box (`FarCache` in `give-way-grid.ts`, issue #778).
 *
 * Giving way notes a car or a person whose edge misses the box, and skips them
 * for as long as their loop keeps them on that edge. What is pinned here is
 * that the skip changes nothing: the ticks a loop reports left on an edge are
 * ticks it really spends there, and giving way decides the same whether its
 * caches are kept or built again every tick.
 */
import { describe, expect, it } from 'vitest';
import { AmbientPedestrians } from '../../../src/sim/crowd/pedestrians.ts';
import { createSimState, type SimState } from '../../../src/sim/simulation.ts';
import { GiveWay } from '../../../src/sim/traffic/give-way.ts';
import { FarCache } from '../../../src/sim/traffic/give-way-grid.ts';
import { gridTraffic, gridTrafficRoads } from '../../support/traffic-grid.ts';

const SEED = 4;
const traffic = gridTraffic(SEED);
const crowd = new AmbientPedestrians(SEED, gridTrafficRoads());

describe('the ticks a loop keeps to its edge', () => {
  it('are spent on that edge by every car', () => {
    const cursor = { id: 0, step: 0, into: 0 };
    let checked = 0;
    for (let id = 0; id < traffic.vehicles.length; id += 7) {
      for (const start of [0, 1234, 40_000]) {
        traffic.cursorAt(id, start, cursor);
        const edge = traffic.edgeOf(cursor);
        const left = traffic.edgeLeft(cursor);
        expect(left).toBeGreaterThan(0);
        for (let k = 0; k < Math.min(left, 3000); k += 1 + (k >> 4)) {
          expect(traffic.edgeOf(traffic.cursorAt(id, start + k, cursor))).toBe(edge);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('are spent on that edge by every person, and are more than a moment', () => {
    let total = 0;
    let checked = 0;
    for (let id = 0; id < crowd.people.length; id += 11) {
      for (const start of [0, 777, 52_000]) {
        const edge = crowd.edgeAt(id, start);
        const left = crowd.edgeLeft(id, start);
        for (let k = 0; k < Math.min(left, 3000); k += 1 + (k >> 4)) expect(crowd.edgeAt(id, start + k)).toBe(edge);
        total += left;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
    // A step of a walk runs over several legs; counting only whole steps left nearly everyone at 0.
    expect(total / checked).toBeGreaterThan(60);
  });
});

describe('FarCache', () => {
  const missAll = (): boolean => false;
  const noted = (): FarCache => {
    const far = new FarCache();
    far.note(3, 100, -2, 0, 0, 200, missAll, () => 50);
    return far;
  };

  it('skips while the loop stays on its edge and the box stays near', () => {
    expect(noted().skips(3, 120, -2, 10, -10)).toBe(true);
  });

  it('stops skipping when the edge ends, the hold changes or the box moves', () => {
    expect(noted().skips(3, 150, -2, 0, 0)).toBe(false);
    expect(noted().skips(3, 120, -3, 0, 0)).toBe(false);
    expect(noted().skips(3, 120, -2, 500, 0)).toBe(false);
    expect(noted().skips(4, 120, -2, 0, 0)).toBe(false);
  });

  it('notes nobody whose edge meets even the least grown box', () => {
    const far = new FarCache();
    far.note(3, 100, 0, 0, 0, 200, () => true, () => 50);
    expect(far.skips(3, 101, 0, 0, 0)).toBe(false);
  });
});

/** A session on foot that walks east across the grid, a metre a tick. */
function walker(): SimState {
  const state = createSimState(SEED, undefined, 0);
  state.player.driving = false;
  state.vehicle.x = 5000;
  state.vehicle.z = 5000;
  return state;
}

describe('giving way with its caches', () => {
  it('decides what it decides with them built again every tick', () => {
    const kept = walker();
    const fresh = walker();
    const way = new GiveWay(traffic, crowd);
    for (let i = 0; i < 240; i++) {
      const x = -120 + i;
      way.step(kept, x, 0);
      new GiveWay(traffic, crowd).step(fresh, x, 0);
      kept.tick++;
      fresh.tick++;
      if (i % 40 === 39) {
        expect(JSON.stringify(kept.traffic.held)).toBe(JSON.stringify(fresh.traffic.held));
        expect(JSON.stringify(kept.pedestrians.held)).toBe(JSON.stringify(fresh.pedestrians.held));
      }
    }
    expect(kept.traffic.held.list.length).toBeGreaterThan(0);
  });
});
