import { describe, expect, it } from 'vitest';
import { hurtPerson, PERSON_HEALTH } from '../src/sim/casualty.ts';
import { UNIT_BODY, type EmergencyUnit } from '../src/sim/emergency.ts';
import { GiveWay } from '../src/sim/give-way.ts';
import { heldTime } from '../src/sim/hold.ts';
import { AmbientPedestrians, crowdPoseOf, type PedestrianPose } from '../src/sim/pedestrians.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';
import { footprintsTouch, laneOffset, type AmbientPose, type AmbientTraffic, type Footprint } from '../src/sim/traffic.ts';
import { headingOf, specOf } from '../src/sim/vehicle.ts';
import { TIERS } from '../src/world/tiers.ts';
import { gridTraffic, gridTrafficRoads } from './traffic-grid.ts';

/**
 * Giving way (`give-way.ts`) on the made-up grid of `traffic-grid.ts`: the cars
 * and the people round the player keep off each other, and off what stands in
 * the road. The physics is left out; the holds are read the way it reads them.
 */
const SEED = 4711;
const TICKS = 600;
/** Metres each way of the player the cars and the people are drawn in. */
const VIEW = 110;

const traffic = gridTraffic(SEED);
const crowd = new AmbientPedestrians(SEED, gridTrafficRoads());

const walk = (): PedestrianPose => ({ x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' });

/** A session on foot at the middle of the grid, with the player's car left far off it. */
function session(): SimState {
  const state = createSimState(SEED, undefined, 0);
  state.player.driving = false;
  state.player.x = 0;
  state.player.y = 0;
  state.vehicle.x = 5000;
  state.vehicle.z = 5000;
  return state;
}

/** Every car of the traffic in view, where the holds put it. */
function cars(state: SimState, lagged: boolean): Footprint[] {
  const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  const out: Footprint[] = [];
  for (const id of traffic.near(-VIEW, -VIEW, VIEW, VIEW, [])) {
    const time = lagged ? heldTime(state.traffic.held, id, state.tick) : state.tick;
    traffic.poseAt(id, time, pose);
    if (Math.abs(pose.x) > VIEW || Math.abs(pose.y) > VIEW) continue;
    const spec = specOf((traffic.vehicles[id] as AmbientTraffic['vehicles'][number]).cls);
    out.push({ x: pose.x, y: pose.y, heading: pose.heading, halfLength: spec.halfLength, halfWidth: spec.halfWidth });
  }
  return out;
}

/** Pairs of cars standing on each other, and people standing in a car, summed over a run. */
function overlaps(giving: boolean): { cars: number; people: number } {
  const state = session();
  const way = new GiveWay(traffic, crowd);
  const count = { cars: 0, people: 0 };
  const pose = walk();
  for (let i = 0; i < TICKS; i++) {
    if (giving) way.step(state, 0, 0);
    state.tick++;
    if (i % 10 !== 0) continue;
    const boxes = cars(state, giving);
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) if (footprintsTouch(boxes[a] as Footprint, boxes[b] as Footprint, -0.1)) count.cars++;
    }
    for (const id of crowd.near(-VIEW, -VIEW, VIEW, VIEW, [])) {
      if (crowdPoseOf(crowd, state.pedestrians, id, state.tick, pose) === undefined) continue;
      if (Math.abs(pose.x) > VIEW || Math.abs(pose.y) > VIEW) continue;
      const person = { x: pose.x, y: pose.y, heading: 0, halfLength: 0.1, halfWidth: 0.1 };
      for (const box of boxes) if (footprintsTouch(person, box, 0)) count.people++;
    }
  }
  return count;
}

describe('giving way', () => {
  it('keeps the cars off each other and the people out of the cars', () => {
    const loose = overlaps(false);
    const kept = overlaps(true);
    // Without it the tours stand cars on cars and walk people through them.
    expect(loose.cars).toBeGreaterThan(0);
    expect(loose.people).toBeGreaterThan(0);
    // A car turning into a junction may touch another for a tick; nobody walks into a car.
    expect(kept.cars).toBeLessThanOrEqual(loose.cars / 10);
    expect(kept.people).toBe(0);
  });

  it('queues the traffic behind a car standing across its lane', () => {
    const state = session();
    // Across the inner eastbound lane of the arterial, between two junctions.
    const lane = laneOffset({ tier: 'arterial', lanes: TIERS.arterial.lanes }, 0);
    state.vehicle.x = 60;
    state.vehicle.z = lane;
    state.vehicle.qx = 0;
    state.vehicle.qy = Math.sin(-Math.PI / 4);
    state.vehicle.qz = 0;
    state.vehicle.qw = Math.cos(-Math.PI / 4);
    const spec = specOf(state.vehicle.cls);
    const parked: Footprint = { x: 60, y: lane, heading: headingOf(state.vehicle), halfLength: spec.halfLength, halfWidth: spec.halfWidth };
    const way = new GiveWay(traffic, crowd);
    let longest = 0;
    for (let i = 0; i < 600; i++) {
      way.step(state, 60, lane);
      state.tick++;
      for (const box of cars(state, true)) expect(footprintsTouch(box, parked, 0)).toBe(false);
      for (const hold of state.traffic.held.list) longest = Math.max(longest, hold.lag);
    }
    // Somebody stood behind it for most of the run.
    expect(longest).toBeGreaterThan(300);
  });

  it('queues the traffic behind a fire engine working a scene in its lane, and not under it', () => {
    // The engine stands in the outer eastbound lane of the arterial, between two junctions.
    const lane = laneOffset({ tier: 'arterial', lanes: TIERS.arterial.lanes }, 1);
    const body = UNIT_BODY.engine;
    const standing: Footprint = { x: 60, y: lane, heading: 0, halfLength: body.halfLength, halfWidth: body.halfWidth };
    /** Ticks a car of the traffic stands on the engine's ground over a run, with the engine there or not. */
    const run = (there: boolean): number => {
      const state = session();
      // The player stands in the middle of a block, where no car stops for them.
      state.player.x = 60;
      state.player.y = 60;
      const way = new GiveWay(traffic, crowd);
      // The engine pulls up once its ground is clear, as it would: it does not land on a car.
      let placed = false;
      let touched = 0;
      for (let i = 0; i < 900; i++) {
        way.step(state, 60, 0);
        state.tick++;
        const on = cars(state, true).some((box) => footprintsTouch(box, standing, 0));
        if (!placed && !on && i > 60 && there) {
          placed = true;
          state.emergency.units.push({
            id: 0, kind: 'engine', task: 'work', call: 0, x: 60, y: lane, heading: 0, height: 0, speed: 0, edges: [],
            distance: 0, stop: 0, planned: 0, goalX: 60, goalY: lane, homeX: 60, homeY: lane, until: -1,
          });
        }
        if (i > 60 && on) touched++;
      }
      return touched;
    };
    // Without it the traffic drives over that ground; with it, nobody does.
    expect(run(false)).toBeGreaterThan(0);
    expect(run(true)).toBe(0);
  });

  it('is a function of the record: a replay holds the same cars and people back', () => {
    const run = (): string => {
      const state = session();
      const way = new GiveWay(traffic, crowd);
      for (let i = 0; i < 300; i++) {
        way.step(state, 0, 0);
        state.tick++;
      }
      return JSON.stringify([state.traffic.held, state.pedestrians]);
    };
    expect(run()).toBe(run());
  });

  it('lets a car of the traffic hit a person without it being the player\'s crime', () => {
    const state = session();
    const id = crowd.near(-50, -50, 50, 50, [])[0] as number;
    const pose = crowdPoseOf(crowd, state.pedestrians, id, state.tick, walk()) as PedestrianPose;
    const record = hurtPerson(state, crowd, id, pose, { cause: 'car', damage: PERSON_HEALTH, dir: 0, push: 10, lift: 2, city: true });
    expect(record?.health).toBe(0);
    expect(state.heat).toBe(0);
  });
});
