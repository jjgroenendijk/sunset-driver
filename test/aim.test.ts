import { beforeAll, describe, expect, it } from 'vitest';
import { aimPoint, aimYaw, SNAP_RADIUS, SNAP_RADIUS_AIMED } from '../src/sim/aim.ts';
import { EMPTY_INPUT, type InputFrame } from '../src/sim/input.ts';
import { initPhysics } from '../src/sim/physics.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';
import { forgetTracers, TRACER_MEMORY } from '../src/sim/tracer.ts';
import { createLoadout, giveWeapon, stepWeapons } from '../src/sim/weapon.ts';
import { ENFORCER_HEALTH, type EnforcerUnit } from '../src/sim/enforcer.ts';
import { createPlayerState } from '../src/sim/on-foot.ts';
import { drive, hills, start } from './sim-harness.ts';

/** The mouse at a point of the map, and whatever else the test is pressing. */
function pointing(x: number, y: number, keys: Partial<InputFrame> = {}): InputFrame {
  return { ...EMPTY_INPUT, pointing: true, pointX: x, pointY: y, ...keys };
}

/** An enforcer standing at a point, with the health to be a target. */
function enforcerAt(state: SimState, x: number, y: number): void {
  state.enforcers.units.push({ id: state.enforcers.units.length, x, y, health: ENFORCER_HEALTH } as EnforcerUnit);
}

/** The mouse aim of spec section 11.5: where the pointer is, and the target it is pulled onto. */
describe('mouse aim', () => {
  it('aims where the pointer is when nothing stands near it', () => {
    const state = createSimState(1);
    const point = aimPoint(state, pointing(10, -4));
    expect(point).toEqual({ x: 10, y: -4, snapped: false });
    expect(aimYaw(state, pointing(10, 0))).toBeCloseTo(0);
    expect(aimYaw(state, pointing(0, 10))).toBeCloseTo(Math.PI / 2);
  });

  it('has no aim without a pointer, or with the pointer on the player', () => {
    const state = createSimState(1);
    expect(aimPoint(state, EMPTY_INPUT)).toBeUndefined();
    expect(aimYaw(state, pointing(0.1, 0))).toBeUndefined();
  });

  it('pulls the aim onto the nearest target inside the snap radius, and no further', () => {
    const state = createSimState(1);
    enforcerAt(state, 20, 0);
    enforcerAt(state, 20, 1.2);
    expect(aimPoint(state, pointing(20, 1))).toEqual({ x: 20, y: 1.2, snapped: true });
    const far = SNAP_RADIUS + 0.5;
    expect(aimPoint(state, pointing(20, -far))?.snapped).toBe(false);
    // Aiming reaches further, which is what holding the right button buys.
    expect(far).toBeLessThan(SNAP_RADIUS_AIMED);
    expect(aimPoint(state, pointing(20, -far, { aim: true }))?.snapped).toBe(true);
  });

  it('never pulls the aim onto somebody already down', () => {
    const state = createSimState(1);
    enforcerAt(state, 20, 0);
    (state.enforcers.units[0] as EnforcerUnit).health = 0;
    expect(aimPoint(state, pointing(20, 1))?.snapped).toBe(false);
  });

  it('fires the round the way it is aimed, not the way the player faces', () => {
    const loadout = createLoadout();
    giveWeapon(loadout, 'glock-17');
    const player = createPlayerState();
    player.heading = 0;
    const shot = stepWeapons(loadout, pointing(0, 10, { fire: true }), player, 7, 100, Math.PI / 2);
    const ray = shot?.rays[0];
    expect(ray).toBeDefined();
    expect(ray?.dy).toBeGreaterThan(0.95);
    expect(Math.abs(ray?.dx ?? 1)).toBeLessThan(0.3);
  });
});

/** The path of every round, kept on the record for the flash, the streak and the hit marker. */
describe('tracers', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('writes one tracer per pellet, from the muzzle toward the pointer', () => {
    const session = start(hills());
    drive(session, 1, { interact: true });
    drive(session, 30);
    const { state } = session;
    giveWeapon(state.loadout, 'remington-870');
    const x = state.player.x;
    const y = state.player.y;
    drive(session, 1, pointing(x, y - 15, { fire: true }));
    const fired = state.tracers;
    expect(fired.length).toBe(8);
    expect(fired.filter((t) => t.pellet === 0).length).toBe(1);
    for (const t of fired) expect(t.ey).toBeLessThan(t.y);
    // The player turns square to the shot.
    expect(state.player.heading).toBeCloseTo(-Math.PI / 2, 1);
    session.physics.dispose();
  });

  it('forgets a tracer once it is old', () => {
    const tracers = [{ tick: 10, pellet: 0, x: 0, y: 0, h: 0, ex: 1, ey: 0, eh: 0, end: 'none' as const }];
    forgetTracers(tracers, 10 + TRACER_MEMORY - 1);
    expect(tracers.length).toBe(1);
    forgetTracers(tracers, 10 + TRACER_MEMORY);
    expect(tracers.length).toBe(0);
  });
});
