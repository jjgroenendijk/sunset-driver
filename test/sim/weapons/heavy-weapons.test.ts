/**
 * The heavy and the thrown weapons of spec section 11.6, and first person
 * aiming: what a burst leaves on the record, a Molotov's fire on the ground,
 * the flamethrower's stream, the shot that climbs with the view, and the
 * sound each weapon makes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '../../../src/sim/physics/physics.ts';
import { EMPTY_INPUT } from '../../../src/sim/input.ts';
import { createPlayerState } from '../../../src/sim/player/on-foot.ts';
import { createLoadout, giveWeapon, stepWeapons, weaponOf, type WeaponId } from '../../../src/sim/weapons/weapon.ts';
import { createSimState } from '../../../src/sim/simulation.ts';
import { AudioPlanner, shotCue } from '../../../src/audio/plan.ts';
import { kickOf, zoomOf } from '../../../src/render/weapons/viewmodel.ts';
import { shotPitch } from '../../../src/pointer-aim.ts';
import { drive, finishBoarding, hills, start, type Session } from '../../support/sim-harness.ts';

describe('the heavy weapons', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  function armed(id: WeaponId): Session {
    const session = start(hills());
    drive(session, 1, { interact: true });
    finishBoarding(session);
    drive(session, 30);
    giveWeapon(session.state.loadout, id);
    return session;
  }

  /** Drop a projectile of `weapon` a little above the ground ahead and step until it has gone off. */
  function burst(session: Session, weapon: WeaponId): void {
    const { state } = session;
    state.projectiles.push({
      weapon,
      x: state.player.x + 6,
      y: state.player.y,
      h: state.player.height + 1,
      vx: 0,
      vy: 0,
      vh: -3,
      thrownTick: state.tick,
    });
    for (let i = 0; i < 600 && state.projectiles.length > 0; i++) drive(session, 1);
  }

  it('writes where a rocket went off onto the record, for the frame and the mix', () => {
    const session = armed('rpg-7');
    burst(session, 'rpg-7');
    const blast = session.state.blasts.at(-1);
    expect(blast?.weapon).toBe('rpg-7');
    expect(blast?.radius).toBe(weaponOf('rpg-7').projectile?.blastRadius);
    session.physics.dispose();
  });

  it('leaves the ground alight where a Molotov breaks, for a shorter while than a wreck', () => {
    const session = armed('molotov');
    const { state } = session;
    const before = state.fires.blazes.length;
    burst(session, 'molotov');
    expect(state.fires.blazes).toHaveLength(before + 1);
    const blaze = state.fires.blazes.at(-1);
    expect(blaze).toBeDefined();
    const seconds = ((blaze?.out ?? 0) - (blaze?.lit ?? 0)) / 60;
    expect(seconds).toBeGreaterThanOrEqual(12);
    expect(seconds).toBeLessThanOrEqual(20);
    session.physics.dispose();
  });

  it('writes a smoke grenade going off, though it hurts nobody', () => {
    const session = armed('smoke-grenade');
    const health = session.state.player.health;
    burst(session, 'smoke-grenade');
    expect(session.state.blasts.at(-1)?.weapon).toBe('smoke-grenade');
    expect(session.state.player.health).toBe(health);
    session.physics.dispose();
  });

  it('throws a flamethrower\'s stream as tongues of fire, never as rounds', () => {
    const session = armed('flamethrower');
    drive(session, 1, { fire: true });
    const tongues = session.state.tracers.filter((t) => t.tick === session.state.tick - 1 || t.tick === session.state.tick);
    expect(tongues).toHaveLength(weaponOf('flamethrower').pellets);
    expect(tongues.every((t) => t.flame === true)).toBe(true);
    session.physics.dispose();
  });
});

describe('first person aiming', () => {
  it('climbs the shot by the pitch the input carries, and levels it without one', () => {
    const player = createPlayerState();
    player.driving = false;
    const level = createLoadout();
    giveWeapon(level, 'remington-700');
    level.aiming = true;
    const up = structuredClone(level);
    const flat = stepWeapons(level, { ...EMPTY_INPUT, fire: true, aim: true }, player, 1, 10);
    const raised = stepWeapons(up, { ...EMPTY_INPUT, fire: true, aim: true, pitch: 0.4 }, player, 1, 10);
    expect(Math.abs(flat?.rays[0]?.dh ?? 1)).toBeLessThan(0.02);
    expect(raised?.rays[0]?.dh).toBeCloseTo(Math.sin(0.4), 1);
  });

  it('meets the line of sight: a level view aims a hair up, a view down aims down', () => {
    expect(shotPitch(0, 60)).toBeGreaterThan(0);
    expect(shotPitch(0, 60)).toBeLessThan(0.02);
    expect(shotPitch(-0.3, 5)).toBeLessThan(-0.15);
  });

  it('zooms only an aimed gun, and a scope furthest', () => {
    const loadout = createLoadout();
    giveWeapon(loadout, 'glock-17');
    expect(zoomOf(loadout)).toBe(1);
    loadout.aiming = true;
    const pistol = zoomOf(loadout);
    giveWeapon(loadout, 'barrett-m82');
    expect(zoomOf(loadout)).toBeGreaterThan(pistol);
    giveWeapon(loadout, 'baseball-bat');
    expect(zoomOf(loadout)).toBe(1);
  });

  it('kicks a rocket launcher hardest and a flamethrower hardly at all', () => {
    expect(kickOf(weaponOf('rpg-7'))).toBe(1);
    expect(kickOf(weaponOf('flamethrower'))).toBeLessThan(kickOf(weaponOf('glock-17')));
  });
});

describe('the sound of each weapon', () => {
  it('gives each family a cue of its own', () => {
    expect(shotCue(weaponOf('glock-17'))).toBe('gunshot');
    expect(shotCue(weaponOf('remington-870'))).toBe('shotgun');
    expect(shotCue(weaponOf('ak-47'))).toBe('rifle');
    expect(shotCue(weaponOf('barrett-m82'))).toBe('magnum');
    expect(shotCue(weaponOf('desert-eagle'))).toBe('magnum');
    expect(shotCue(weaponOf('flamethrower'))).toBe('flame');
    expect(shotCue(weaponOf('rpg-7'))).toBe('launch');
    expect(shotCue(weaponOf('m79'))).toBe('thunk');
    expect(shotCue(weaponOf('grenade'))).toBe('swing');
    expect(shotCue(weaponOf('katana'))).toBe('swing');
    expect(shotCue({ ...weaponOf('glock-17'), suppressed: true })).toBe('suppressed');
  });

  it('plays a burst once: a bang for a grenade, glass for a Molotov, a hiss for smoke', () => {
    const state = createSimState(1);
    const planner = new AudioPlanner();
    const listen = { x: 0, y: 0, heading: 0 };
    planner.plan(state, EMPTY_INPUT, listen);
    state.tick += 1;
    state.blasts.push({ tick: state.tick, x: 5, y: 0, h: 0, weapon: 'grenade', radius: 8 });
    state.blasts.push({ tick: state.tick, x: -5, y: 0, h: 0, weapon: 'molotov', radius: 4 });
    state.blasts.push({ tick: state.tick, x: 0, y: 5, h: 0, weapon: 'tear-gas', radius: 7 });
    const kinds = planner.plan(state, EMPTY_INPUT, listen).cues.map((cue) => cue.kind);
    expect(kinds.filter((kind) => kind === 'explosion')).toHaveLength(2);
    expect(kinds).toContain('glass');
    expect(kinds).toContain('hiss');
    state.tick += 1;
    expect(planner.plan(state, EMPTY_INPUT, listen).cues.filter((cue) => cue.kind === 'explosion')).toHaveLength(0);
  });
});
