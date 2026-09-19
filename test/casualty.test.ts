import { describe, expect, it } from 'vitest';
import { casualtyPose, emptyCasualtyPose, restDistance, restTicks, upright } from '../src/sim/casualty-motion.ts';
import {
  BODY_CAP,
  collectBodies,
  hurtPerson,
  PERSON_HEALTH,
  stepCasualties,
  type Blow,
} from '../src/sim/casualty.ts';
import { carDamage, KILL_SPEED, SHOVE_SPEED, strikeCrowd } from '../src/sim/car-strike.ts';
import { personOnRay } from '../src/sim/crowd-contact.ts';
import { CRIME_HEAT, raiseHeat } from '../src/sim/crime.ts';
import { AmbientPedestrians, crowdPoseOf, type PedestrianPose } from '../src/sim/pedestrians.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';
import { specOf, DEFAULT_CLASS } from '../src/sim/vehicle.ts';
import { stableJson } from './helpers.ts';
import { gridTrafficRoads } from './traffic-grid.ts';

/**
 * The people of the crowd who are hit (spec section 13.1): what a round, a
 * blow and a car do to them, how they fall, and what follows.
 */
const SEED = 4711;
const TICK = 9_000;

const roads = { ...gridTrafficRoads(), heightAt: () => 0 };
const crowd = new AmbientPedestrians(SEED, roads);
const pose = (): PedestrianPose => ({ x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' });

function fresh(): SimState {
  const state = createSimState(SEED);
  state.tick = TICK;
  return state;
}

/** A person somewhere in the crowd, at {@link TICK}, and where they stand. */
function someone(state: SimState, index = 0): { id: number; at: PedestrianPose } {
  const ids = crowd.near(-400, -400, 400, 400, []);
  const id = ids[index * 7] as number;
  const at = crowdPoseOf(crowd, state.pedestrians, id, state.tick, pose()) as PedestrianPose;
  return { id, at: { ...at } };
}

const SHOT: Blow = { cause: 'shot', damage: 30, dir: 0, push: 1.5, lift: 0 };

describe('casualties (spec section 13.1)', () => {
  it('wounds a person: they fall, lie a while, get up and move off', () => {
    const state = fresh();
    const { id, at } = someone(state);
    const record = hurtPerson(state, crowd, id, at, SHOT);
    expect(record?.health).toBe(PERSON_HEALTH - SHOT.damage);
    expect(record?.down).toBeGreaterThan(0);
    // Out of the crowd: nobody draws them walking their loop.
    expect(crowdPoseOf(crowd, state.pedestrians, id, TICK, pose())).toBeUndefined();
    expect(state.heat).toBeCloseTo(raiseHeat(0, CRIME_HEAT.assault), 6);
    const r = record as NonNullable<typeof record>;
    const phases = new Set<string>();
    const out = emptyCasualtyPose();
    for (let t = TICK; t < TICK + restTicks(r) + r.down + 40 * 60; t += 5) phases.add(casualtyPose(r, t, out).phase);
    expect(phases).toContain('fall');
    expect(phases).toContain('lie');
    expect(phases).toContain('rise');
    expect([...phases].some((p) => p === 'run' || p === 'limp')).toBe(true);
  });

  it('kills a person: they stay down, carry cash, and it is a killing', () => {
    const state = fresh();
    const { id, at } = someone(state);
    const record = hurtPerson(state, crowd, id, at, { ...SHOT, damage: 500 });
    expect(record?.health).toBe(0);
    expect(record?.down).toBe(-1);
    expect(record?.cash).toBeGreaterThan(0);
    expect(state.heat).toBeCloseTo(raiseHeat(0, CRIME_HEAT.assault + CRIME_HEAT.killing), 6);
    // Somebody calls it in.
    expect(state.emergency.calls.some((call) => call.kind === 'ambulance')).toBe(true);
    const r = record as NonNullable<typeof record>;
    expect(casualtyPose(r, TICK + 60 * 60 * 10, emptyCasualtyPose()).phase).toBe('lie');
  });

  it('never carries a body through a wall', () => {
    const state = fresh();
    const { id, at } = someone(state);
    const wall = { reach: () => 1.5, heightAt: () => 0 };
    const record = hurtPerson(state, crowd, id, at, { cause: 'car', damage: 500, dir: 0, push: 20, lift: 4 }, wall);
    const r = record as NonNullable<typeof record>;
    expect(restDistance(r)).toBeLessThanOrEqual(1.5);
    const end = casualtyPose(r, TICK + 600, emptyCasualtyPose());
    expect(Math.hypot(end.x - at.x, end.y - at.y)).toBeLessThanOrEqual(1.5 + 1e-9);
  });

  it('meets the first person along a line, and nobody behind them', () => {
    const state = fresh();
    const { id, at } = someone(state);
    const hit = personOnRay(crowd, state.pedestrians, TICK, at.x - 10, at.height + 1.2, at.y, 1, 0, 0, 40);
    expect(hit).toBeDefined();
    expect(hit?.t).toBeLessThanOrEqual(10);
    // A line aimed above their head meets nobody at all.
    const high = personOnRay(crowd, state.pedestrians, TICK, at.x - 10, at.height + 3, at.y, 1, 0, 0, 40);
    expect(high?.id === id).toBe(false);
  });

  it('takes the cash off a body the player stands over, and an ambulance takes the body', () => {
    const state = fresh();
    const { id, at } = someone(state);
    const record = hurtPerson(state, crowd, id, at, { ...SHOT, damage: 500, push: 0 }) as NonNullable<ReturnType<typeof hurtPerson>>;
    const cash = record.cash;
    state.tick += 120;
    const where = casualtyPose(record, state.tick, emptyCasualtyPose());
    state.player.driving = false;
    state.player.x = where.x;
    state.player.y = where.y;
    const money = state.money;
    stepCasualties(state, crowd);
    expect(state.money).toBe(money + cash);
    expect(record.cash).toBe(0);
    expect(collectBodies(state, where.x, where.y, 5)).toBe(1);
    expect(record.gone).toBe(true);
  });

  it('keeps somebody lying on the ground down when they are hit again', () => {
    const state = fresh();
    const { id, at } = someone(state);
    const first = hurtPerson(state, crowd, id, at, { ...SHOT, damage: 40 }) as NonNullable<ReturnType<typeof hurtPerson>>;
    state.tick += restTicks(first) + 5;
    const lying = casualtyPose(first, state.tick, emptyCasualtyPose());
    expect(lying.phase).toBe('lie');
    const again = hurtPerson(state, crowd, id, lying, { cause: 'car', damage: 10, dir: 0, push: 0.5, lift: 0 });
    const r = again as NonNullable<typeof again>;
    // Not stood up to fall again, so a car going over them is not a new strike.
    for (let t = state.tick; t < state.tick + 60; t++) expect(upright(casualtyPose(r, t, emptyCasualtyPose()))).toBe(false);
  });

  it(`keeps no more than ${BODY_CAP} bodies`, () => {
    const state = fresh();
    for (let i = 0; i < BODY_CAP + 3; i++) {
      const { id, at } = someone(state, i);
      hurtPerson(state, crowd, id, at, { ...SHOT, damage: 500 });
      state.tick++;
    }
    const lying = state.pedestrians.casualties.filter((r) => !r.gone && r.health <= 0);
    expect(lying.length).toBe(BODY_CAP);
  });
});

describe('the car against the crowd (spec section 13.1)', () => {
  const spec = specOf(DEFAULT_CLASS);

  /** A car driven at `speed` along the map's x axis, its middle on a person. */
  function hitAt(speed: number): { state: SimState; id: number } {
    const state = fresh();
    const { id, at } = someone(state);
    state.player.driving = true;
    state.vehicle.x = at.x;
    state.vehicle.z = at.y;
    state.vehicle.y = at.height + spec.halfHeight;
    state.vehicle.vx = speed;
    return { state, id };
  }

  it('only pushes a person aside at a crawl', () => {
    const { state, id } = hitAt(SHOVE_SPEED - 1);
    strikeCrowd(state, crowd, spec, undefined);
    expect(state.pedestrians.casualties.some((r) => r.id === id)).toBe(false);
    expect(state.pedestrians.startled.some((r) => r.id === id)).toBe(true);
  });

  it('knocks a person down in town traffic, and the forgiving curve leaves them alive', () => {
    const { state, id } = hitAt(12);
    const strike = strikeCrowd(state, crowd, spec, undefined);
    const record = state.pedestrians.casualties.find((r) => r.id === id);
    expect(record).toBeDefined();
    expect(record?.health).toBeGreaterThan(0);
    expect(record?.lift).toBeGreaterThan(0);
    expect(strike.loss).toBeGreaterThan(0);
    expect(state.heat).toBeGreaterThanOrEqual(raiseHeat(0, CRIME_HEAT.reckless));
  });

  it('kills at a very high speed, and throws the body over the bonnet', () => {
    const { state, id } = hitAt(KILL_SPEED + 4);
    strikeCrowd(state, crowd, spec, undefined);
    const record = state.pedestrians.casualties.find((r) => r.id === id) as NonNullable<ReturnType<typeof hurtPerson>>;
    expect(record.health).toBe(0);
    const flying = casualtyPose(record, TICK + 20, emptyCasualtyPose());
    expect(flying.phase).toBe('air');
    expect(flying.lift).toBeGreaterThan(0);
  });

  it('rises with speed, and is the same in a replay', () => {
    expect(carDamage(SHOVE_SPEED - 0.1)).toBe(0);
    expect(carDamage(10)).toBeLessThan(carDamage(15));
    expect(carDamage(KILL_SPEED)).toBe(100);
    const a = hitAt(15);
    const b = hitAt(15);
    strikeCrowd(a.state, crowd, spec, undefined);
    strikeCrowd(b.state, crowd, spec, undefined);
    expect(stableJson(a.state.pedestrians)).toBe(stableJson(b.state.pedestrians));
  });
});
