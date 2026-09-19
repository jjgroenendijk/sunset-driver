import { describe, expect, it } from 'vitest';
import {
  blowStrength,
  forgetHits,
  HIT_CAP,
  HIT_MEMORY,
  markHit,
  swingOf,
  swingProgress,
  swingTicks,
  type MeleeHit,
} from '../src/sim/melee.ts';
import { createLoadout, giveWeapon, weaponOf } from '../src/sim/weapon.ts';
import {
  poseFor,
  STRIKE_END,
  SWING_FOLLOW,
  SWING_WIND,
  swingAngle,
  WIND_END,
  type CharacterMotion,
} from '../src/render/character-pose.ts';
import { MeleeFx, SPARKS_PER_HIT } from '../src/render/melee-fx.ts';
import { AudioPlanner } from '../src/audio/plan.ts';
import { createSimState } from '../src/sim/simulation.ts';
import { EMPTY_INPUT } from '../src/sim/input.ts';

/**
 * The blows of spec section 11.6: how long a swing lasts, what it leaves on the
 * record, and the three that read it — the pose, the burst and the cue. The
 * Rapier half, which is what a swing reaches in the world, is
 * `sim-weapons.test.ts`.
 */
describe('melee', () => {
  function hit(tick: number, surface: MeleeHit['surface'] = 'hard'): MeleeHit {
    return { tick, x: 0, y: 0, h: 1, surface, strength: 1 };
  }

  it('swings for as long as the weapon takes to cycle, and no longer', () => {
    const bat = weaponOf('baseball-bat');
    const saw = weaponOf('chainsaw');
    // A bat cycles slower than a swing is drawn, so it is drawn in full; a
    // chainsaw cycles faster, so one swing ends where the next begins.
    expect(swingTicks(bat)).toBeGreaterThan(swingTicks(saw));
    expect(swingProgress(bat, 100, 100)).toBe(0);
    expect(swingProgress(bat, 100, 100 + swingTicks(bat) - 1)).toBeLessThan(1);
    expect(swingProgress(bat, 100, 100 + swingTicks(bat))).toBe(-1);
    // Before the swing, and with nothing ever swung.
    expect(swingProgress(bat, 100, 99)).toBe(-1);
    expect(swingProgress(bat, -1, 100)).toBe(-1);
    // A gun is never swung, however lately it was fired.
    expect(swingProgress(weaponOf('ak-47'), 100, 101)).toBe(-1);
  });

  it('reads the swing off the weapon in the hands', () => {
    const loadout = createLoadout();
    loadout.firedTick = 50;
    expect(swingOf(loadout, 52)).toBeGreaterThan(0);
    giveWeapon(loadout, 'ak-47');
    expect(swingOf(loadout, 52)).toBe(-1);
  });

  it('lands a heavier blow with a heavier weapon', () => {
    expect(blowStrength(weaponOf('fists'))).toBeLessThan(blowStrength(weaponOf('baseball-bat')));
    expect(blowStrength(weaponOf('baseball-bat'))).toBeLessThan(blowStrength(weaponOf('katana')));
    expect(blowStrength(weaponOf('chainsaw'))).toBe(1);
  });

  it('keeps a bounded run of the blows that landed, and forgets the old ones', () => {
    const hits: MeleeHit[] = [];
    for (let i = 0; i < HIT_CAP + 5; i++) markHit(hits, hit(i));
    expect(hits.length).toBe(HIT_CAP);
    // The oldest go, so what is left is the newest.
    expect((hits[hits.length - 1] as MeleeHit).tick).toBe(HIT_CAP + 4);
    forgetHits(hits, HIT_CAP + 4);
    expect(hits.length).toBeGreaterThan(0);
    forgetHits(hits, HIT_CAP + 4 + HIT_MEMORY);
    expect(hits.length).toBe(0);
  });

  it('draws the arm back, through, and home again', () => {
    expect(swingAngle(0)).toBeCloseTo(0, 6);
    // Drawn back behind the body, then carried past it, then at rest.
    expect(swingAngle(WIND_END)).toBeCloseTo(-SWING_WIND, 6);
    expect(swingAngle(STRIKE_END)).toBeCloseTo(SWING_FOLLOW, 6);
    expect(swingAngle(1)).toBeCloseTo(0, 6);
    // The strike is the quickest part of the swing: it covers the most ground
    // in the least of it.
    const strike = Math.abs(swingAngle(STRIKE_END) - swingAngle(WIND_END)) / (STRIKE_END - WIND_END);
    const wind = Math.abs(swingAngle(WIND_END) - swingAngle(0)) / WIND_END;
    expect(strike).toBeGreaterThan(wind);
  });

  it('lays the swing over whatever the body was doing', () => {
    const motion: CharacterMotion = { speed: 0, grounded: true, vy: 0, depth: 0, stature: 1.8 };
    const still = poseFor('stand', 0, motion);
    expect(still.yawR).toBe(0);
    expect(still.lunge).toBe(0);
    const mid = poseFor('stand', 0, { ...motion, swing: STRIKE_END });
    expect(mid.yawR).toBeCloseTo(swingAngle(STRIKE_END), 6);
    // The off arm swings the other way, the torso turns with the arm, the
    // weapon arm comes up in front, and the body steps into the blow.
    expect(Math.sign(mid.yawL)).toBe(-Math.sign(mid.yawR));
    expect(Math.sign(mid.twist)).toBe(Math.sign(mid.yawR));
    expect(mid.armR).toBeLessThan(0);
    expect(mid.lunge).toBeGreaterThan(0);
    // A walking body keeps its legs through the swing.
    const walking = poseFor('walk', 1, { ...motion, speed: 3, swing: STRIKE_END });
    expect(walking.thighL).not.toBe(0);
    expect(walking.yawR).toBeCloseTo(mid.yawR, 6);
  });

  it('throws a burst for each blow, once', () => {
    const fx = new MeleeFx();
    const hits = [hit(10, 'person')];
    fx.update(hits, 7, 10);
    const thrown = fx.flying;
    expect(thrown).toBeGreaterThan(0);
    expect(thrown).toBeLessThanOrEqual(SPARKS_PER_HIT);
    // The same record on the next frame is the same blow, not another one.
    fx.update(hits, 7, 10);
    expect(fx.flying).toBe(thrown);
    // And a blow that landed on a tick the frame stepped through is not missed.
    fx.update([...hits, hit(12, 'hard')], 7, 13);
    expect(fx.flying).toBeGreaterThan(thrown);
    // A record that has gone backwards is a load: nothing of the old one stands.
    fx.update([], 7, 5);
    expect(fx.flying).toBe(0);
    fx.dispose();
  });

  it('plays a cue for each blow, by what was struck', () => {
    const state = createSimState(3);
    // A swing is thrown on foot: a person struck while driving is the car's.
    state.player.driving = false;
    const planner = new AudioPlanner();
    planner.resync(state);
    state.tick += 1;
    markHit(state.hits, { ...hit(state.tick, 'person'), x: state.player.x, y: state.player.y });
    markHit(state.hits, { ...hit(state.tick, 'vehicle'), x: state.player.x, y: state.player.y });
    markHit(state.hits, { ...hit(state.tick, 'hard'), x: state.player.x, y: state.player.y });
    const cues = planner.plan(state, EMPTY_INPUT, state.player).cues;
    expect(cues.map((cue) => cue.kind)).toEqual(['thud', 'clang', 'knock']);
    // Two blows of one swing are not the same sound twice over.
    expect(cues[0]?.pitch).not.toBe(cues[1]?.pitch);
    // The same record on the next frame is silent: the blows have been heard.
    state.tick += 1;
    expect(planner.plan(state, EMPTY_INPUT, state.player).cues.length).toBe(0);
  });
});
