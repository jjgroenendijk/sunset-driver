import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_INPUT, type InputFrame } from '../src/sim/input.ts';
import { MAX_HEALTH, type Place } from '../src/sim/on-foot.ts';
import { initPhysics, SimPhysics, type Ground } from '../src/sim/physics.ts';
import { ARREST_BRIBE, HOSPITAL_FEE, nearestStation } from '../src/sim/respawn.ts';
import { createSimState, START_MONEY, stepSim, type SimState } from '../src/sim/simulation.ts';
import { DEFAULT_WEAPON, giveWeapon } from '../src/sim/weapon.ts';
import { FATE_TICKS, fateLine } from '../src/ui/hud.ts';
import { stableJson } from './helpers.ts';
import { drive, hills, start } from './sim-harness.ts';

/** Two stations on the hillside, one near the start and one far from it. */
const STATIONS: readonly Place[] = [
  { x: 400, y: -300, heading: 0 },
  { x: -60, y: 40, heading: 1 },
];

function policed(): Ground {
  return { ...hills(), stations: STATIONS };
}

/**
 * Death, arrest and respawn of spec section 11.7, played in the Rapier loop.
 * The debug keys do what the damage and the police will do: a death is health
 * at 0, and an arrest is the record's `arrested` flag.
 */
describe('death and arrest', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('brings a dead player back where the session started, unarmed and a hospital fee poorer', () => {
    const session = start(policed());
    const { state } = session;
    state.origin = { x: 30, y: -20, heading: 2 };
    giveWeapon(state.loadout, 'ak-47');
    state.heat = 3;
    state.player.health = 0;
    const tick = state.tick;
    drive(session, 1);
    expect(state.player.driving).toBe(false);
    expect(state.player.x).toBe(30);
    expect(state.player.y).toBe(-20);
    expect(state.player.health).toBe(MAX_HEALTH);
    expect(state.loadout.slots.map((slot) => slot.id)).toEqual([DEFAULT_WEAPON]);
    expect(Object.values(state.loadout.ammo).every((rounds) => rounds === 0)).toBe(true);
    expect(state.money).toBe(START_MONEY - HOSPITAL_FEE);
    expect(state.heat).toBe(0);
    expect(state.respawn).toEqual({ cause: 'death', tick, cost: HOSPITAL_FEE });
    // The player stands on the ground and walks away from it.
    drive(session, 60, { throttle: 1 });
    expect(state.player.grounded).toBe(true);
    expect(Math.abs(state.player.height - policed().heightAt(state.player.x, state.player.y))).toBeLessThan(0.1);
    expect(state.player.y).toBeLessThan(-22);
    session.physics.dispose();
  });

  it('brings an arrested player back at the nearest station, a bribe poorer', () => {
    const session = start(policed());
    const { state } = session;
    giveWeapon(state.loadout, 'glock-17');
    state.arrested = true;
    drive(session, 1);
    const near = STATIONS[1] as Place;
    expect(state.player.x).toBe(near.x);
    expect(state.player.y).toBe(near.y);
    expect(state.player.driving).toBe(false);
    expect(state.arrested).toBe(false);
    expect(state.loadout.slots.map((slot) => slot.id)).toEqual([DEFAULT_WEAPON]);
    expect(state.money).toBe(START_MONEY - ARREST_BRIBE);
    expect(state.respawn?.cause).toBe('arrest');
    expect(fateLine(state)).toBe(`Busted  bribe $${ARREST_BRIBE}`);
    drive(session, FATE_TICKS);
    expect(fateLine(state)).toBe('');
    session.physics.dispose();
  });

  it('leaves the car where the run ended', () => {
    const session = start(policed());
    const { state } = session;
    const car = { x: state.vehicle.x, z: state.vehicle.z };
    state.player.health = 0;
    drive(session, 30);
    expect(Math.hypot(state.vehicle.x - car.x, state.vehicle.z - car.z)).toBeLessThan(0.5);
    session.physics.dispose();
  });

  it('takes no more than the player has, and a death over an arrest', () => {
    const session = start(policed());
    const { state } = session;
    state.money = 150;
    state.arrested = true;
    state.player.health = 0;
    drive(session, 1);
    expect(state.money).toBe(0);
    expect(state.respawn?.cause).toBe('death');
    expect(state.respawn?.cost).toBe(150);
    session.physics.dispose();
  });

  it('brings an arrest back where the session started in a world with no station', () => {
    const session = start(hills());
    const { state } = session;
    state.arrested = true;
    drive(session, 1);
    expect(state.player.x).toBe(state.origin.x);
    expect(state.player.y).toBe(state.origin.y);
    session.physics.dispose();
  });

  it('finds the nearest station, and the first of two at the same distance', () => {
    expect(nearestStation([], 0, 0)).toBeUndefined();
    const twins: Place[] = [
      { x: 10, y: 0, heading: 0 },
      { x: -10, y: 0, heading: 1 },
    ];
    expect(nearestStation(twins, 0, 0)).toBe(twins[0]);
    expect(nearestStation(STATIONS, 300, -200)).toBe(STATIONS[0]);
  });

  it('replays both paths to identical state', () => {
    // A stream that drives, then has the run end on a fixed tick. The trigger
    // is written into the record between two ticks, as the debug keys write it.
    const inputs: InputFrame[] = [];
    for (let i = 0; i < 360; i++) {
      inputs.push({ ...EMPTY_INPUT, throttle: i < 120 ? 1 : 0, steer: Math.sin(i / 30), fire: i % 50 === 0 });
    }
    const run = (): SimState => {
      const state = createSimState(7);
      const physics = new SimPhysics(policed(), state);
      physics.spawn(state, 0, 0, 0);
      for (let i = 0; i < inputs.length; i++) {
        if (i === 90) state.player.health = 0;
        if (i === 200) state.arrested = true;
        stepSim(state, inputs[i] as InputFrame, physics);
      }
      physics.dispose();
      return state;
    };
    const first = run();
    expect(first.respawn?.cause).toBe('arrest');
    expect(first.money).toBe(Math.max(0, START_MONEY - HOSPITAL_FEE - ARREST_BRIBE));
    expect(stableJson(run())).toBe(stableJson(first));
  });
});
