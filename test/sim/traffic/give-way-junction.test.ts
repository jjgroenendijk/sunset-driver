import { describe, expect, it } from 'vitest';
import { GiveWay } from '../../../src/sim/traffic/give-way.ts';
import { heldTime } from '../../../src/sim/traffic/hold.ts';
import { createSimState, type SimState } from '../../../src/sim/simulation.ts';
import { footprintsTouch, type AmbientPose, type AmbientTraffic, type Footprint } from '../../../src/sim/traffic/traffic.ts';
import { specOf } from '../../../src/sim/vehicles/vehicle.ts';
import { GRID_SPACING, gridTraffic } from '../../support/traffic-grid.ts';

/**
 * Giving way at the junctions without lights of `traffic-grid.ts`
 * (`give-way-junction.ts`, issue #360): a car waits at the mouth for cross
 * traffic rather than driving through it. The seed is the one
 * `give-way.test.ts` reads; see there for why the scenarios depend on it.
 */
const SEED = 4;
const TICKS = 600;
/** Ticks at the start of a run left out: on the first tick every car is where its tour put it. */
const SETTLE = 120;
/** Metres each way of the player the cars are counted in. */
const VIEW = 110;
/** Metres from a junction's middle that a car counts as at it. */
const AT = 15;
/** Two cars at a junction meet at an angle when the cosine between their headings is below this. */
const ANGLED = 0.9;

const traffic = gridTraffic(SEED);
const graph = traffic.roads.graph;
/** The grid's crossings that take no light. */
const plain = graph.nodes.filter((node) => graph.degree(node.id) >= 3 && (traffic.signals?.junctionAt(node.id) ?? -1) < 0);

/** A session on foot in the middle of a block, where no car stops for the player. */
function session(): SimState {
  const state = createSimState(SEED, undefined, 0);
  state.player.driving = false;
  state.player.x = GRID_SPACING / 2;
  state.player.y = GRID_SPACING / 2;
  state.vehicle.x = 5000;
  state.vehicle.z = 5000;
  return state;
}

/** The cars in view, where the holds put them. */
function cars(state: SimState, lagged: boolean): Footprint[] {
  const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  const { x, y } = state.player;
  const out: Footprint[] = [];
  for (const id of traffic.near(x - VIEW, y - VIEW, x + VIEW, y + VIEW, [])) {
    const time = lagged ? heldTime(state.traffic.held, id, state.tick) : state.tick;
    traffic.poseAt(id, time, pose);
    if (Math.abs(pose.x - x) > VIEW || Math.abs(pose.y - y) > VIEW) continue;
    const spec = specOf((traffic.vehicles[id] as AmbientTraffic['vehicles'][number]).cls);
    out.push({ x: pose.x, y: pose.y, heading: pose.heading, halfLength: spec.halfLength, halfWidth: spec.halfWidth });
  }
  return out;
}

/** True when a footprint stands at a junction without lights. */
function atPlain(box: Footprint): boolean {
  return plain.some((node) => Math.abs(box.x - node.x) < AT && Math.abs(box.y - node.y) < AT);
}

/** Pairs of cars at junctions without lights that stand on each other at an angle, summed over a run. */
function crossings(giving: boolean): number {
  const state = session();
  const way = new GiveWay(traffic);
  let count = 0;
  for (let i = 0; i < TICKS; i++) {
    if (giving) way.step(state, state.player.x, state.player.y);
    state.tick++;
    if (i < SETTLE || i % 10 !== 0) continue;
    const boxes = cars(state, giving).filter(atPlain);
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const p = boxes[a] as Footprint;
        const q = boxes[b] as Footprint;
        if (Math.abs(Math.cos(p.heading - q.heading)) < ANGLED && footprintsTouch(p, q, 0)) count++;
      }
    }
  }
  return count;
}

describe('giving way at a junction without lights', () => {
  it('holds a car at the mouth while cross traffic goes through', () => {
    expect(plain.length).toBeGreaterThan(0);
    const loose = crossings(false);
    const kept = crossings(true);
    // Without it the tours drive cross traffic through each other.
    expect(loose).toBeGreaterThan(0);
    expect(kept).toBe(0);
  });
});
