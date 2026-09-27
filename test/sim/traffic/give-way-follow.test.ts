import { describe, expect, it } from 'vitest';
import { GiveWay } from '../../../src/sim/traffic/give-way.ts';
import { heldPose, heldStep, heldTime } from '../../../src/sim/traffic/hold.ts';
import { createSimState, type SimState } from '../../../src/sim/simulation.ts';
import { footprintsTouch, type AmbientPose, type AmbientTraffic, type Footprint, type TrafficCursor } from '../../../src/sim/traffic/traffic.ts';
import { specOf } from '../../../src/sim/vehicles/vehicle.ts';
import { GRID_SPACING, gridTraffic } from '../../support/traffic-grid.ts';

/**
 * Following a car through a junction without lights (`give-way-follow.ts`,
 * issue #748): of two cars that come in on the same road, the one behind does
 * not drive into the ground the one ahead turns across. On seed 2 of the grid,
 * without it, a car turning out of the next lane swept into the car beside it
 * at about tick 450.
 */
const SEED = 2;
const TICKS = 600;
/** Metres from a junction's middle that a car counts as at it. */
const AT = 15;
/** Two cars meet at an angle when the cosine between their headings is below this. */
const ANGLED = 0.9;
/** Metres per second under which a car counts as standing. */
const STANDING = 0.5;

const traffic = gridTraffic(SEED);
const graph = traffic.roads.graph;
const plain = graph.nodes.filter((node) => graph.degree(node.id) >= 3 && (traffic.signals?.junctionAt(node.id) ?? -1) < 0);

/** One car at a junction: where it stands, the road it came in on, and whether it moves. */
interface AtJunction {
  box: Footprint;
  from: number;
  moving: boolean;
}

/** The edge a car came into junction `node` by: the one it is on, or the one before it once it has left. */
function fromOf(id: number, node: number, cursor: TrafficCursor): number {
  const tour = (traffic.vehicles[id] as AmbientTraffic['vehicles'][number]).tour;
  const leg = tour.stepLeg[cursor.step] as number;
  const edge = tour.edges[leg] as number;
  if (graph.edges[edge]?.from !== node) return edge;
  return tour.edges[(leg + tour.edges.length - 1) % tour.edges.length] as number;
}

/** The cars at junction `node`, where the holds put them. */
function carsAt(state: SimState, node: { id: number; x: number; y: number }): AtJunction[] {
  const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  const cursor: TrafficCursor = { id: 0, step: 0, into: 0 };
  const out: AtJunction[] = [];
  for (const id of traffic.near(node.x - AT, node.y - AT, node.x + AT, node.y + AT, [])) {
    heldPose(traffic, state.traffic.held, id, state.tick, pose);
    if (Math.abs(pose.x - node.x) > AT || Math.abs(pose.y - node.y) > AT) continue;
    traffic.cursorAt(id, heldTime(state.traffic.held, id, state.tick), cursor);
    const spec = specOf((traffic.vehicles[id] as AmbientTraffic['vehicles'][number]).cls);
    const box = { x: pose.x, y: pose.y, heading: pose.heading, halfLength: spec.halfLength, halfWidth: spec.halfWidth };
    out.push({ box, from: fromOf(id, node.id, cursor), moving: pose.speed >= STANDING && heldStep(state.traffic.held, id) !== 1 });
  }
  return out;
}

/** Pairs of cars from one road in that stand on each other at an angle, one of them moving, summed over a run. */
function sweeps(): number {
  const state = createSimState(SEED, undefined, 0);
  state.player.driving = false;
  state.player.x = GRID_SPACING / 2;
  state.player.y = GRID_SPACING / 2;
  state.vehicle.x = 5000;
  state.vehicle.z = 5000;
  const way = new GiveWay(traffic);
  let count = 0;
  for (let i = 0; i < TICKS; i++) {
    way.step(state, state.player.x, state.player.y);
    state.tick++;
    if (i % 10 !== 0) continue;
    for (const node of plain) {
      if (Math.abs(node.x - state.player.x) > GRID_SPACING || Math.abs(node.y - state.player.y) > GRID_SPACING) continue;
      count += swept(carsAt(state, node));
    }
  }
  return count;
}

/** Pairs of cars of one junction from one road in that stand on each other at an angle, one of them moving. */
function swept(cars: readonly AtJunction[]): number {
  let count = 0;
  for (let a = 0; a < cars.length; a++) {
    for (let b = a + 1; b < cars.length; b++) {
      const p = cars[a] as AtJunction;
      const q = cars[b] as AtJunction;
      if (p.from !== q.from || !(p.moving || q.moving)) continue;
      if (Math.abs(Math.cos(p.box.heading - q.box.heading)) < ANGLED && footprintsTouch(p.box, q.box, 0)) count++;
    }
  }
  return count;
}

describe('following a car through a junction without lights', () => {
  it('keeps a car out of the ground the car ahead of it from its road turns across', () => {
    expect(plain.length).toBeGreaterThan(0);
    expect(sweeps()).toBe(0);
  });
});
