import { beforeAll, describe, expect, it } from 'vitest';
import { TICK_RATE } from '../../src/sim/clock.ts';
import { EMPTY_INPUT } from '../../src/sim/input.ts';
import { initPhysics, SimPhysics, type Ground } from '../../src/sim/physics/physics.ts';
import { cloneSimState, stepSim } from '../../src/sim/simulation.ts';
import {
  ALARM_HEAT_PER_SECOND,
  HOTWIRE_CAP,
  hotwireFloor,
  type TheftState,
  wouldHit,
} from '../../src/sim/vehicles/theft.ts';
import { CRIME_HEAT, raiseHeat } from '../../src/sim/police/crime.ts';
import { stableJson } from '../support/helpers.ts';
import { hills, type Session, start, drive, finishBoarding } from '../support/sim-harness.ts';

/**
 * The theft of spec section 11.4, played in the Rapier loop rather than on its
 * own: what `theft.test.ts` checks about the rules, this checks about a session
 * running them. The point of every case here is that the world does not stop
 * while a lock is being worked at.
 */
describe('theft', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  /** Press and release a key, and let any door it opened be shut again. */
  function press(session: Session, key: 'interact' | 'jump'): void {
    drive(session, 1, { [key]: true });
    drive(session, 1);
    finishBoarding(session);
  }

  /**
   * A session on foot beside a car worth stealing, its lock untouched. The
   * player steps out of the car they started in first, so the sports car is
   * put down at the kerb beside them rather than under them.
   */
  function besideLocked(ground: Ground, seed = 1): Session {
    const session = start(ground, seed);
    press(session, 'interact');
    drive(session, 15);
    session.physics.spawn(session.state, 0, 0, 0, 'sports');
    drive(session, 15);
    expect(session.state.player.driving).toBe(false);
    expect(session.state.vehicle.hotwired).toBe(false);
    return session;
  }

  /**
   * Work the lock for as long as it takes and answer the ticks it took. A
   * player who waits presses on the rising edge of every window; one who does
   * nothing never presses at all.
   */
  function pickLock(session: Session, waits: boolean): number {
    const state = session.state;
    const started = (state.theft as TheftState).startedTick;
    let down = false;
    for (let i = 0; i <= HOTWIRE_CAP + 2; i++) {
      const theft = state.theft;
      const hit: boolean = waits && theft !== null && !down && wouldHit(theft, state.seed, state.tick);
      down = hit;
      drive(session, 1, { interact: hit });
      if (state.theft === null) return state.tick - 1 - started;
    }
    return Infinity;
  }

  it('does not open a car worth stealing on the key', () => {
    const session = besideLocked(hills());
    press(session, 'interact');
    expect(session.state.player.driving).toBe(false);
    expect(session.state.theft).not.toBeNull();
    session.physics.dispose();
  });

  it('starts a session in an open car, whatever it is worth', () => {
    const session = start(hills());
    session.physics.spawn(session.state, 0, 0, 0, 'sports');
    expect(session.state.vehicle.hotwired).toBe(true);
    expect(session.state.theft).toBeNull();
    expect(session.state.player.driving).toBe(true);
    session.physics.dispose();
  });

  it('opens an ordinary car on the key, with no lock to work at', () => {
    const session = start(hills());
    press(session, 'interact');
    drive(session, 30);
    press(session, 'interact');
    expect(session.state.theft).toBeNull();
    expect(session.state.player.driving).toBe(true);
    session.physics.dispose();
  });

  it('keeps the world running while the lock is worked at, and holds the player at the door', () => {
    const session = besideLocked(hills());
    press(session, 'interact');
    const p = session.state.player;
    const tick = session.state.tick;
    const at = { x: p.x, y: p.y };
    // Every key a walk is made of, held down for two seconds of ticks.
    drive(session, 120, { throttle: 1, steer: 1, sprint: true, jump: true });
    expect(session.state.tick).toBe(tick + 120);
    expect(session.state.theft).not.toBeNull();
    expect(Math.hypot(p.x - at.x, p.y - at.y)).toBeLessThan(0.05);
    expect(p.driving).toBe(false);
    session.physics.dispose();
  });

  it('puts the player in the car once the lock gives way, and drives it', () => {
    const session = besideLocked(hills());
    press(session, 'interact');
    const ticks = pickLock(session, true);
    expect(ticks).toBeLessThanOrEqual(hotwireFloor());
    // The lock is open, and the player climbs in through the door it held shut.
    expect(session.state.boarding?.way).toBe('in');
    finishBoarding(session);
    expect(session.state.player.driving).toBe(true);
    expect(session.state.vehicle.hotwired).toBe(true);
    const from = session.state.vehicle.x;
    drive(session, 120, { throttle: 1 });
    expect(Math.abs(session.state.vehicle.x - from)).toBeGreaterThan(1);
    session.physics.dispose();
  });

  it('gives the lock away at the cap to a player who never presses', () => {
    const session = besideLocked(hills());
    press(session, 'interact');
    expect(pickLock(session, false)).toBe(HOTWIRE_CAP);
    finishBoarding(session);
    expect(session.state.player.driving).toBe(true);
    session.physics.dispose();
  });

  it('works a lock once and not again', () => {
    const session = besideLocked(hills());
    press(session, 'interact');
    pickLock(session, true);
    finishBoarding(session);
    drive(session, 30);
    press(session, 'interact');
    drive(session, 30);
    expect(session.state.player.driving).toBe(false);
    press(session, 'interact');
    expect(session.state.theft).toBeNull();
    expect(session.state.player.driving).toBe(true);
    session.physics.dispose();
  });

  it('raises heat for the alarm it sounded and the theft itself (spec section 14)', () => {
    // Nothing but a crime raises it: a session that drives around draws none.
    const session = besideLocked(hills());
    drive(session, 60);
    expect(session.state.heat).toBe(0);
    press(session, 'interact');
    const ticks = pickLock(session, true);
    // The theft itself, plus the alarm for every tick it sounded. The lock is
    // made on the press and first worked at the tick after, so the alarm is
    // heard for exactly the ticks the working took. What a second of it is
    // worth is pinned headless in `theft.test.ts`.
    expect(session.state.heat).toBeGreaterThan(CRIME_HEAT.theft);
    expect(session.state.heat).toBeCloseTo(raiseHeat(0, CRIME_HEAT.theft + (ticks / TICK_RATE) * ALARM_HEAT_PER_SECOND), 6);
    session.physics.dispose();
  });

  it('carries a theft in progress through a save and back', () => {
    const session = besideLocked(hills());
    press(session, 'interact');
    drive(session, 60);
    const saved = cloneSimState(session.state);
    const physics = new SimPhysics(hills(), saved);
    physics.adopt(saved);
    for (let i = 0; i < 120; i++) {
      stepSim(session.state, EMPTY_INPUT, session.physics);
      stepSim(saved, EMPTY_INPUT, physics);
    }
    expect(stableJson(saved.theft)).toBe(stableJson(session.state.theft));
    expect(saved.heat).toBeCloseTo(session.state.heat, 6);
    physics.dispose();
    session.physics.dispose();
  });
});
