import { beforeAll, describe, expect, it } from 'vitest';
import { resolveAppearance } from '../src/sim/character.ts';
import {
  createPlayerState,
  heal,
  HEAL_BY_SOURCE,
  hurt,
  JUMP_SPEED,
  MAX_HEALTH,
  swims,
} from '../src/sim/on-foot.ts';
import { initPhysics, type Ground } from '../src/sim/physics.ts';
import { hills, ramp, type Session, start, drive, accelerateTo, finishBoarding } from './sim-harness.ts';

/**
 * The player out of the car: the character controller of spec section 11.2 and
 * the health of spec section 11.5, both in the Rapier loop. `on-foot.ts` holds
 * the pure rules these drive.
 */
describe('on foot', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  /**
   * Press and release a key, so the rising edge the controller reads happens
   * once, and let any door it opened be shut again.
   */
  function press(session: Session, key: 'interact' | 'jump'): void {
    drive(session, 1, { [key]: true });
    drive(session, 1);
    finishBoarding(session);
  }

  /** Start a session, step out of the car and let the player settle on their feet. */
  function onFoot(ground: Ground, seed = 1): Session {
    const session = start(ground, seed);
    press(session, 'interact');
    drive(session, 30);
    return session;
  }

  it('steps out of the car beside it, on the ground', () => {
    const session = onFoot(hills());
    const p = session.state.player;
    const v = session.state.vehicle;
    expect(p.driving).toBe(false);
    expect(Math.hypot(p.x - v.x, p.y - v.z)).toBeLessThan(3);
    expect(p.grounded).toBe(true);
    expect(Math.abs(p.height - hills().heightAt(p.x, p.y))).toBeLessThan(0.4);
    session.physics.dispose();
  });

  it('starts a session on foot beside a car that opens without a break-in', () => {
    const session = start(hills());
    session.physics.alight(session.state);
    drive(session, 30);
    const p = session.state.player;
    const v = session.state.vehicle;
    expect(p.driving).toBe(false);
    expect(p.grounded).toBe(true);
    expect(Math.hypot(p.x - v.x, p.y - v.z)).toBeLessThan(3);
    press(session, 'interact');
    expect(session.state.theft).toBeNull();
    expect(p.driving).toBe(true);
    session.physics.dispose();
  });

  it('leaves the car where it was parked while the player walks away', () => {
    const session = onFoot(hills());
    const parked = { ...session.state.vehicle };
    drive(session, 240, { throttle: 1 });
    const v = session.state.vehicle;
    expect(Math.hypot(v.x - parked.x, v.z - parked.z)).toBeLessThan(0.001);
    expect(Math.hypot(session.state.player.x - v.x, session.state.player.y - v.z)).toBeGreaterThan(5);
    session.physics.dispose();
  });

  it('walks back to the car and gets in again', () => {
    const session = onFoot(hills());
    // Out of reach of the door: the key does nothing, however often it is pressed.
    drive(session, 240, { throttle: 1 });
    press(session, 'interact');
    expect(session.state.player.driving).toBe(false);

    // Back toward the car, which stands the other way.
    drive(session, 240, { throttle: -1 });
    press(session, 'interact');
    expect(session.state.player.driving).toBe(true);
    // The car is driveable again: it is a body, and the throttle moves it.
    const from = session.state.vehicle.x;
    drive(session, 120, { throttle: 1 });
    expect(Math.abs(session.state.vehicle.x - from)).toBeGreaterThan(1);
    session.physics.dispose();
  });

  it('does not open the door of a car at speed', () => {
    const session = start(ramp('asphalt', 0));
    expect(accelerateTo(session, 12)).toBe(true);
    press(session, 'interact');
    expect(session.state.player.driving).toBe(true);
    session.physics.dispose();
  });

  it('walks up a hill', () => {
    // The ground climbs with `x`, and the steering axis walks that way.
    const session = onFoot(ramp('asphalt', 0.3));
    const from = { x: session.state.player.x, height: session.state.player.height };
    drive(session, 180, { steer: 1 });
    const p = session.state.player;
    expect(p.x - from.x).toBeGreaterThan(2);
    expect(p.height - from.height).toBeGreaterThan(0.5);
    expect(p.grounded).toBe(true);
    session.physics.dispose();
  });

  it('sprints further than it walks in the same time', () => {
    const distances = [false, true].map((sprint) => {
      const session = onFoot(ramp('asphalt', 0));
      const from = session.state.player.y;
      drive(session, 180, { throttle: 1, sprint });
      const walked = Math.abs(session.state.player.y - from);
      session.physics.dispose();
      return walked;
    });
    const [walking, sprinting] = distances as [number, number];
    expect(walking).toBeGreaterThan(5);
    expect(sprinting).toBeGreaterThan(walking + 2);
  });

  it('jumps off the ground and lands back on it', () => {
    const session = onFoot(ramp('asphalt', 0));
    const ground = session.state.player.height;
    drive(session, 1, { jump: true });
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      drive(session, 1, { jump: true });
      peak = Math.max(peak, session.state.player.height - ground);
    }
    expect(peak).toBeGreaterThan(0.4);
    drive(session, 90);
    expect(session.state.player.grounded).toBe(true);
    expect(Math.abs(session.state.player.height - ground)).toBeLessThan(0.1);
    session.physics.dispose();
  });

  it('faces the way it walks', () => {
    const session = onFoot(ramp('asphalt', 0));
    drive(session, 60, { throttle: 1 });
    // Forward walks up the screen, which is toward -y on the map.
    expect(Math.abs(session.state.player.heading + Math.PI / 2)).toBeLessThan
      (0.01);
    drive(session, 60, { steer: 1 });
    expect(Math.abs(session.state.player.heading)).toBeLessThan(0.01);
    session.physics.dispose();
  });

  it('holds the ground under the player as they walk away from the car', () => {
    const session = onFoot(hills());
    const tiles = session.physics.groundTiles;
    drive(session, 900, { throttle: 1, sprint: true });
    expect(session.physics.groundTiles).toBe(tiles);
    expect(session.state.player.grounded).toBe(true);
    session.physics.dispose();
  });
});

describe('swimming', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  /** A beach: the sand runs down into a sea that stands at zero. */
  function beach(): Ground {
    return { heightAt: (x) => -0.25 * x, surfaceAt: () => 'sand', seaLevel: 0 };
  }

  /** Start on the dry sand, step out of the car and walk toward the water. */
  function wadeIn(ticks: number): Session {
    const session = start(beach());
    drive(session, 1, { interact: true });
    finishBoarding(session);
    drive(session, 30);
    drive(session, ticks, { steer: 1 });
    return session;
  }

  it('floats the player at the surface once the water is chest deep', () => {
    const session = wadeIn(300);
    const p = session.state.player;
    const stature = resolveAppearance(session.state.character).body.height;
    const floor = beach().heightAt(p.x, p.y);
    expect(swims(p.height, 0, stature)).toBe(true);
    // They are off the bottom, and their head is out of the water.
    expect(p.height - floor).toBeGreaterThan(0.5);
    expect(p.height).toBeGreaterThan(-stature);
    expect(p.height).toBeLessThan(-0.2);
    session.physics.dispose();
  });

  it('holds them there rather than sinking, however long they swim', () => {
    const session = wadeIn(300);
    const settled = session.state.player.height;
    drive(session, 400, { steer: 1 });
    const p = session.state.player;
    // They have swum well out: the sea floor is metres under them now.
    expect(beach().heightAt(p.x, p.y)).toBeLessThan(-4);
    expect(Math.abs(p.height - settled)).toBeLessThan(0.3);
    expect(Math.abs(p.vy)).toBeLessThan(0.2);
    session.physics.dispose();
  });

  it('swims slower than it walks, and cannot jump off the water', () => {
    const dry = wadeIn(20);
    const walked = dry.state.player.speed;
    dry.physics.dispose();
    const session = wadeIn(300);
    expect(session.state.player.speed).toBeLessThan(walked);
    expect(session.state.player.speed).toBeGreaterThan(0.5);
    drive(session, 1, { steer: 1, jump: true });
    expect(session.state.player.vy).toBeLessThan(JUMP_SPEED / 2);
    session.physics.dispose();
  });
});

describe('health', () => {
  it('heals only from the sources of spec section 11.5', () => {
    const player = createPlayerState();
    expect(player.health).toBe(MAX_HEALTH);
    hurt(player, 60);
    expect(player.health).toBe(MAX_HEALTH - 60);
    heal(player, 'pickup');
    expect(player.health).toBe(MAX_HEALTH - 60 + HEAL_BY_SOURCE.pickup);
    heal(player, 'rest');
    expect(player.health).toBe(MAX_HEALTH);
  });

  it('never falls below nothing or rises above full', () => {
    const player = createPlayerState();
    hurt(player, 1000);
    expect(player.health).toBe(0);
    hurt(player, -50);
    expect(player.health).toBe(0);
    heal(player, 'food');
    heal(player, 'food');
    heal(player, 'food');
    expect(player.health).toBe(MAX_HEALTH);
  });

  it('does not heal on its own over a day of ticks', async () => {
    await initPhysics();
    const session = start(hills());
    hurt(session.state.player, 40);
    drive(session, 600, { throttle: 1 });
    expect(session.state.player.health).toBe(MAX_HEALTH - 40);
    session.physics.dispose();
  });
});
