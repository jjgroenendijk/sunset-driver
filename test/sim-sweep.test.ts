import { beforeAll, describe, expect, it } from 'vitest';
import { FixedStepClock, TICK_MS, TICK_RATE, TICKS_PER_DAY, gameTime } from '../src/sim/clock.ts';
import { EMPTY_INPUT, type InputFrame } from '../src/sim/input.ts';
import {
  createPlayerState,
  heal,
  HEAL_BY_SOURCE,
  hurt,
  MAX_HEALTH,
} from '../src/sim/on-foot.ts';
import { initPhysics, SimPhysics, type Ground } from '../src/sim/physics.ts';
import { cloneSimState, createSimState, stepSim, type SimState } from '../src/sim/simulation.ts';
import {
  ALARM_HEAT_PER_SECOND,
  HOTWIRE_CAP,
  hotwireFloor,
  THEFT_HEAT,
  type TheftState,
  wouldHit,
} from '../src/sim/theft.ts';
import { headingOf, rideHeight, SALOON } from '../src/sim/vehicle.ts';
import type { Surface } from '../src/world/surface.ts';
import { DRY, inputStream, stableJson, sweepSeeds } from './helpers.ts';

/**
 * The sweep drives the car of spec section 11.3 rather than a placeholder, so
 * what it checks is the Rapier world in the loop: the same inputs give the same
 * session, whatever the frame rate and whichever instance runs them.
 *
 * The ground is a hillside written here rather than a generated world. The
 * simulation reads the world through a {@link Ground} and nothing more, so a
 * seed sweep of cities would measure the city; this measures the simulation.
 * `seed-sweep.test.ts` is where the real ground is checked.
 */
const SEED_COUNT = process.env.SWEEP_SEEDS ? 24 : 2;
const TICKS = process.env.SWEEP_SEEDS ? 900 : 400;

/** A hillside: rolling enough that the suspension, the grades and the grip all do something. */
function hills(surface: Surface = 'asphalt'): Ground {
  return {
    heightAt: (x, y) => 2.5 * Math.sin(x / 37) + 1.5 * Math.cos(y / 51) + 0.35 * Math.sin(x / 8 + y / 11),
    surfaceAt: () => surface,
    seaLevel: DRY,
  };
}

/** A plain constant grade, for the checks that are about the gradient alone. */
function ramp(surface: Surface, slope: number): Ground {
  return { heightAt: (x) => x * slope, surfaceAt: () => surface, seaLevel: DRY };
}

/** A session on a ground, with the car already settled on its springs. */
interface Session {
  state: SimState;
  physics: SimPhysics;
}

function start(ground: Ground, seed = 1): Session {
  const state = createSimState(seed);
  const physics = new SimPhysics(ground, state);
  physics.spawn(state, 0, 0, 0);
  const session = { state, physics };
  drive(session, 60);
  return session;
}

function drive(session: Session, ticks: number, input: Partial<InputFrame> = {}): void {
  const frame = { ...EMPTY_INPUT, ...input };
  for (let i = 0; i < ticks; i++) stepSim(session.state, frame, session.physics);
}

/** Run a recorded stream from a fresh session and answer with the state it ended in. */
function replay(seed: number, inputs: readonly InputFrame[]): SimState {
  const state = createSimState(seed);
  const physics = new SimPhysics(hills(), state);
  physics.spawn(state, 0, 0, 0);
  for (const frame of inputs) stepSim(state, frame, physics);
  physics.dispose();
  return state;
}

/**
 * The same, with the player out of the car before the stream starts, so the
 * sweep covers the character controller of spec section 11.5 rather than
 * leaving it to the presses of interact the stream happens to make. It answers
 * with the metres walked on foot as well, so a run that never left the car
 * cannot pass for one that did.
 */
function walkReplay(seed: number, inputs: readonly InputFrame[]): { state: SimState; walked: number } {
  const state = createSimState(seed);
  const physics = new SimPhysics(hills(), state);
  physics.spawn(state, 0, 0, 0);
  for (let i = 0; i < 60; i++) stepSim(state, EMPTY_INPUT, physics);
  stepSim(state, { ...EMPTY_INPUT, interact: true }, physics);
  let walked = 0;
  let x = state.player.x;
  let y = state.player.y;
  for (const frame of inputs) {
    stepSim(state, frame, physics);
    if (!state.player.driving) walked += Math.hypot(state.player.x - x, state.player.y - y);
    x = state.player.x;
    y = state.player.y;
  }
  physics.dispose();
  return { state, walked };
}

/** Drive until the car passes a speed, and answer how far it got. Gives up after a minute. */
function accelerateTo(session: Session, speed: number): boolean {
  for (let i = 0; i < 3600 && session.state.vehicle.speed < speed; i++) drive(session, 1, { throttle: 1 });
  return session.state.vehicle.speed >= speed;
}

/** Run the sim with a given frame pacing (ms per render frame) for a wall-clock duration. */
function runPaced(seed: number, inputs: readonly InputFrame[], frameMs: number): SimState {
  const state = createSimState(seed);
  const physics = new SimPhysics(hills(), state);
  physics.spawn(state, 0, 0, 0);
  const clock = new FixedStepClock();
  let tick = 0;
  let elapsed = 0;
  const total = inputs.length * TICK_MS;
  while (elapsed < total + frameMs) {
    const steps = clock.advance(frameMs);
    for (let i = 0; i < steps && tick < inputs.length; i++) stepSim(state, inputs[tick++] as InputFrame, physics);
    elapsed += frameMs;
  }
  // Drain any remaining ticks so every pacing reaches the same tick.
  while (tick < inputs.length) stepSim(state, inputs[tick++] as InputFrame, physics);
  physics.dispose();
  return state;
}

describe(`simulation sweep (${SEED_COUNT} seeds)`, () => {
  const seeds = sweepSeeds(SEED_COUNT);

  beforeAll(async () => {
    await initPhysics();
  });

  it('replays a recorded input stream to identical state', () => {
    for (const seed of seeds) {
      const inputs = inputStream(seed, TICKS);
      expect(stableJson(replay(seed, inputs))).toBe(stableJson(replay(seed, inputs)));
    }
  });

  it('replays a walk to identical state, with the character in the loop', () => {
    for (const seed of seeds) {
      const inputs = inputStream(seed, TICKS);
      const run = walkReplay(seed, inputs);
      expect(stableJson(run.state)).toBe(stableJson(walkReplay(seed, inputs).state));
      // The player did walk, so what was replayed is a character in the loop
      // and not someone who got straight back into the car.
      expect(run.walked, `seed ${seed}`).toBeGreaterThan(2);
    }
  });

  it('yields identical state at the same tick at 30, 60 and 144 fps', () => {
    for (const seed of seeds) {
      const inputs = inputStream(seed, TICKS);
      const s30 = runPaced(seed, inputs, 1000 / 30);
      const s60 = runPaced(seed, inputs, 1000 / 60);
      const s144 = runPaced(seed, inputs, 1000 / 144);
      expect(s30.tick).toBe(s60.tick);
      expect(stableJson(s30)).toBe(stableJson(s60));
      expect(stableJson(s60)).toBe(stableJson(s144));
    }
  });

  it('two independent instances agree at the same tick', () => {
    for (const seed of seeds) {
      const inputs = inputStream(seed, TICKS);
      const a = replay(seed, inputs);
      const b = cloneSimState(replay(seed, inputs));
      expect(stableJson(a)).toBe(stableJson(b));
    }
  });

  it('drives the car somewhere, so the sweep is checking a moving vehicle', () => {
    const inputs = inputStream(seeds[0] as number, TICKS);
    const state = createSimState(seeds[0] as number);
    const physics = new SimPhysics(hills(), state);
    physics.spawn(state, 0, 0, 0);
    // Metres of ground covered, not distance from where it set off: a car that
    // drives a loop ends where it started and has still been driven.
    let path = 0;
    let x = state.player.x;
    let y = state.player.y;
    for (const frame of inputs) {
      stepSim(state, frame, physics);
      path += Math.hypot(state.player.x - x, state.player.y - y);
      x = state.player.x;
      y = state.player.y;
    }
    physics.dispose();
    expect(path).toBeGreaterThan(50);
  });
});

describe('driving', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('stands the car on the ground it is given', () => {
    for (const slope of [0, 0.1, -0.15]) {
      const session = start(ramp('asphalt', slope));
      const v = session.state.vehicle;
      const ground = slope * v.x;
      expect(v.wheels.every((w) => w.contact), `slope ${slope}`).toBe(true);
      // At rest the springs carry the weight, so the body sits a little below
      // the height it hangs at with the wheels off the ground.
      expect(v.y - ground, `slope ${slope}`).toBeGreaterThan(rideHeight(SALOON) - 0.3);
      expect(v.y - ground, `slope ${slope}`).toBeLessThan(rideHeight(SALOON) + 0.05);
      session.physics.dispose();
    }
  });

  it('steers toward the side the input steers toward', () => {
    const session = start(ramp('asphalt', 0));
    accelerateTo(session, 10);
    const before = headingOf(session.state.vehicle);
    drive(session, 90, { throttle: 0.4, steer: 1 });
    // The map's heading grows toward +y, which is the driver's right hand.
    expect(headingOf(session.state.vehicle)).toBeGreaterThan(before + 0.2);
    session.physics.dispose();
  });

  it('climbs slower than it runs on the flat, and faster downhill', () => {
    const speeds = [0.12, 0, -0.12].map((slope) => {
      const session = start(ramp('asphalt', slope));
      drive(session, 600, { throttle: 1 });
      const speed = session.state.vehicle.speed;
      session.physics.dispose();
      return speed;
    });
    const [climbing, flat, descending] = speeds as [number, number, number];
    expect(climbing).toBeLessThan(flat - 1);
    expect(descending).toBeGreaterThan(flat + 1);
  });

  it('takes longer to stop running downhill than running uphill', () => {
    const distances = [-0.1, 0.1].map((slope) => {
      const session = start(ramp('asphalt', slope));
      expect(accelerateTo(session, 20), `slope ${slope}`).toBe(true);
      const from = session.state.vehicle.x;
      for (let i = 0; i < 900 && session.state.vehicle.speed > 0.5; i++) drive(session, 1, { throttle: -1 });
      const travelled = Math.abs(session.state.vehicle.x - from);
      session.physics.dispose();
      return travelled;
    });
    const [downhill, uphill] = distances as [number, number];
    expect(downhill).toBeGreaterThan(uphill);
  });

  it('grips asphalt best, then dirt, then open ground, then sand', () => {
    const surfaces: Surface[] = ['asphalt', 'dirt', 'ground', 'sand'];
    const turns = surfaces.map((surface) => {
      const session = start(ramp(surface, 0));
      expect(accelerateTo(session, 18), surface).toBe(true);
      const before = headingOf(session.state.vehicle);
      drive(session, 120, { throttle: 0.3, steer: 1 });
      const turned = headingOf(session.state.vehicle) - before;
      session.physics.dispose();
      return turned;
    });
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i] as number, `${surfaces[i]} against ${surfaces[i - 1]}`).toBeLessThan(turns[i - 1] as number);
    }
  });

  it('leaves a parked car where it was parked, even on a hill', () => {
    const session = start(ramp('asphalt', 0.1));
    const from = session.state.vehicle.x;
    drive(session, 900);
    expect(Math.abs(session.state.vehicle.x - from)).toBeLessThan(0.5);
    session.physics.dispose();
  });

  it('carries a session through its record and back', () => {
    const ground = hills();
    const session = start(ground);
    drive(session, 300, { throttle: 1, steer: 1 });

    // The record is plain data: it survives JSON, and a physics world built
    // from it puts the car back where the record says it was.
    const revived = cloneSimState(JSON.parse(JSON.stringify(session.state)) as SimState);
    const physics = new SimPhysics(ground, revived);
    physics.step(revived, EMPTY_INPUT);
    session.physics.step(session.state, EMPTY_INPUT);

    const a = session.state.vehicle;
    const b = revived.vehicle;
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(0.01);
    expect(Math.abs(a.speed - b.speed)).toBeLessThan(0.05);
    physics.dispose();
    session.physics.dispose();
  });

  it('holds the ground under the car as it drives away from where it started', () => {
    const session = start(hills());
    const tiles = session.physics.groundTiles;
    expect(accelerateTo(session, 25)).toBe(true);
    drive(session, 900, { throttle: 1 });
    // The car has left the tiles it started on, and it is still on the ground.
    expect(session.physics.groundTiles).toBe(tiles);
    expect(session.state.vehicle.wheels.some((w) => w.contact)).toBe(true);
    session.physics.dispose();
  });
});

describe('on foot', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  /** Press and release a key, so the rising edge the controller reads happens once. */
  function press(session: Session, key: 'interact' | 'jump'): void {
    drive(session, 1, { [key]: true });
    drive(session, 1);
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

  function press(session: Session, key: 'interact' | 'jump'): void {
    drive(session, 1, { [key]: true });
    drive(session, 1);
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
    expect(session.state.player.driving).toBe(true);
    session.physics.dispose();
  });

  it('works a lock once and not again', () => {
    const session = besideLocked(hills());
    press(session, 'interact');
    pickLock(session, true);
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
    expect(session.state.heat).toBeGreaterThan(THEFT_HEAT);
    expect(session.state.heat).toBeCloseTo(THEFT_HEAT + (ticks / TICK_RATE) * ALARM_HEAT_PER_SECOND, 6);
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

describe('clock', () => {
  it('steps exactly once per 1/60 s regardless of frame pacing', () => {
    for (const frameMs of [1000 / 30, 1000 / 60, 1000 / 144, 7.3, 23.9]) {
      const clock = new FixedStepClock();
      let steps = 0;
      let elapsed = 0;
      while (elapsed < 10_000) {
        steps += clock.advance(frameMs);
        elapsed += frameMs;
      }
      expect(Math.abs(steps - 600)).toBeLessThanOrEqual(2);
    }
  });
  it('caps steps per frame after a stall', () => {
    const clock = new FixedStepClock();
    expect(clock.advance(5000)).toBe(8);
    expect(clock.advance(0)).toBe(0);
  });
  it('maps ticks to a 24-minute day', () => {
    expect(TICKS_PER_DAY).toBe(86_400);
    expect(gameTime(0)).toMatchObject({ day: 0, hour: 0, minute: 0 });
    expect(gameTime(TICKS_PER_DAY / 2)).toMatchObject({ day: 0, hour: 12, minute: 0 });
    expect(gameTime(TICKS_PER_DAY + 90 * 60)).toMatchObject({ day: 1, hour: 1, minute: 30 });
  });
});
