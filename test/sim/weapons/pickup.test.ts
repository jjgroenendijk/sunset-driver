import { describe, expect, it } from 'vitest';
import {
  dropCarried,
  dropPoliceCar,
  dropWeapon,
  PICKUP_LIFE,
  policeCarWeapon,
  POLICE_CAR_WEAPONS,
} from '../../../src/sim/weapons/pickup.ts';
import { cloneSimState, createSimState, stepSim, type SimState } from '../../../src/sim/simulation.ts';
import { AMMO_CAP, createLoadout, currentSlot, fitAttachment, giveWeapon } from '../../../src/sim/weapons/weapon.ts';
import { sweepSeeds } from '../../support/helpers.ts';

/** The drops and pickups of spec section 11.6, played without a physics world. */
const SEEDS = sweepSeeds(process.env.SWEEP_SEEDS ? 64 : 16);

/** A session with the player on foot at the origin. */
function onFoot(seed = 1): SimState {
  const state = createSimState(seed);
  state.player.driving = false;
  state.player.x = 0;
  state.player.y = 0;
  state.player.height = 0;
  return state;
}

describe('pickups', () => {
  it('drops what a body carried, attachments and rounds with it, and nothing twice', () => {
    const state = onFoot();
    const body = createLoadout();
    giveWeapon(body, 'glock-17');
    giveWeapon(body, 'beretta-92fs');
    giveWeapon(body, 'ak-47');
    fitAttachment(body, 'ak-47', 'suppressor');
    const dropped = dropCarried(state, body, 20, 0, 0);
    // Fists are not dropped: nobody picks up a pair of hands.
    expect(dropped.map((p) => p.weapon)).toEqual(['glock-17', 'beretta-92fs', 'ak-47']);
    expect(dropped[2]?.attachments).toEqual(['suppressor']);
    // The 9×19 pool lies with the first 9×19 weapon only.
    expect(dropped[0]?.rounds).toBe(body.ammo['9×19']);
    expect(dropped[1]?.rounds).toBe(0);
    // They lie apart rather than in one heap, and each has its own id.
    expect(new Set(dropped.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)).size).toBe(3);
    expect(new Set(dropped.map((p) => p.id)).size).toBe(3);
  });

  it('is taken by the player walking over it, and not from a seat', () => {
    const state = onFoot();
    dropWeapon(state, 'm4a1', 30, 60, ['optic', 'laser'], 0.5, 0, 0);
    state.player.driving = true;
    stepSim(state);
    expect(state.pickups).toHaveLength(1);
    state.player.driving = false;
    stepSim(state);
    expect(state.pickups).toHaveLength(0);
    // The hands held fists, so the rifle goes into them, fitted and loaded.
    expect(currentSlot(state.loadout)).toEqual({ id: 'm4a1', loaded: 30, attachments: ['optic', 'laser'] });
    expect(state.loadout.ammo['5.56×45']).toBe(60);
  });

  it('adds a second copy of a carried weapon to the pool, and leaves one that gives nothing', () => {
    const state = onFoot();
    giveWeapon(state.loadout, 'glock-17');
    state.loadout.ammo['9×19'] = AMMO_CAP['9×19'] - 10;
    dropWeapon(state, 'glock-17', 17, 0, [], 0, 0, 0);
    stepSim(state);
    expect(state.pickups).toHaveLength(0);
    expect(state.loadout.ammo['9×19']).toBe(AMMO_CAP['9×19']);
    // Full, and with nothing new fitted: the pistol stays on the ground.
    dropWeapon(state, 'glock-17', 17, 0, [], 0, 0, 0);
    stepSim(state);
    expect(state.pickups).toHaveLength(1);
    // A suppressor on it is something new, so now it is taken.
    dropWeapon(state, 'glock-17', 17, 0, ['suppressor'], 0, 0, 0);
    stepSim(state);
    expect(state.pickups).toHaveLength(1);
    expect(currentSlot(state.loadout).attachments).toEqual(['suppressor']);
  });

  it('is gone when it has lain its life out, however many lie', () => {
    const state = onFoot();
    dropWeapon(state, 'uzi', 32, 0, [], 50, 50, 0);
    state.tick += PICKUP_LIFE - 1;
    stepSim(state);
    expect(state.pickups).toHaveLength(1);
    stepSim(state);
    expect(state.pickups).toHaveLength(0);
    // A robbed gun store's stock all lies at once; nothing is thrown away to make room.
    for (let i = 0; i < 100; i++) dropWeapon(state, 'uzi', 32, 0, [], 50 + i, 50, 0);
    stepSim(state);
    expect(state.pickups).toHaveLength(100);
    state.tick += PICKUP_LIFE;
    stepSim(state);
    expect(state.pickups).toHaveLength(0);
  });

  it('finds a shotgun or an M4 in a police car, the same one every time', () => {
    const found = new Set<string>();
    for (const seed of SEEDS) {
      for (let car = 0; car < 4; car++) {
        const weapon = policeCarWeapon(seed, car);
        expect(POLICE_CAR_WEAPONS).toContain(weapon);
        expect(policeCarWeapon(seed, car)).toBe(weapon);
        found.add(weapon);
      }
    }
    expect(found.size).toBe(POLICE_CAR_WEAPONS.length);
    const state = onFoot(7);
    const pickup = dropPoliceCar(state, 3, 4, 4, 0);
    expect(pickup.weapon).toBe(policeCarWeapon(7, 3));
    expect(pickup.loaded).toBeGreaterThan(0);
    expect(pickup.rounds).toBeGreaterThan(0);
  });

  it('survives a round trip through JSON', () => {
    const state = onFoot();
    dropWeapon(state, 'spas-12', 8, 16, ['laser'], 9, 9, 0);
    const copy = cloneSimState(state);
    expect(copy.pickups).toEqual(state.pickups);
    expect(copy.nextPickup).toBe(1);
  });
});
