import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../src/sim/clock.ts';
import {
  ALARM_HEAT_PER_SECOND,
  createTheft,
  HOTWIRE_CAP,
  HOTWIRE_PINS,
  hotwireFloor,
  isLocked,
  markerAt,
  MISS_PENALTY,
  needsHotwire,
  SWEEP_TICKS,
  TARGET_HALF,
  targetFor,
  stepTheft,
  type TheftState,
  wouldHit,
} from '../src/sim/theft.ts';
import { createVehicleState, isAircraft, ROSTER, specOf, VEHICLE_CLASSES } from '../src/sim/vehicle.ts';
import { sweepSeeds } from './helpers.ts';

/**
 * The hotwire minigame of spec section 11.4, played headless. The rules are
 * pure, so what the spec asks of them is checked here rather than through a
 * Rapier world: `sim-sweep.test.ts` is where a theft is played in the loop.
 *
 * Every check below is run over a spread of seeds and start ticks, because the
 * windows a lock asks for are a function of both.
 */
const SEEDS = sweepSeeds(process.env.SWEEP_SEEDS ? 24 : 6);
const STARTS = [0, 1, 97, 28_800, 1_234_567];

/** How a player presses: answers whether the key goes down at this tick. */
type Play = (theft: TheftState, seed: number, tick: number) => boolean;

/**
 * Play a lock to the end and answer the ticks it took. A press is a rising
 * edge, so a finger that stays down is a press once: the play is asked for a
 * press and the tick after one is never a press again.
 */
function play(seed: number, start: number, how: Play): { theft: TheftState; ticks: number } {
  const theft = createTheft(specOf('sports'), start);
  let down = false;
  for (let tick = start; tick <= start + HOTWIRE_CAP; tick++) {
    const press: boolean = !down && how(theft, seed, tick);
    down = press;
    stepTheft(theft, seed, tick, press);
    if (theft.open) return { theft, ticks: tick - start };
  }
  return { theft, ticks: Infinity };
}

/** A player who waits for the window every time. */
const perfect: Play = (theft, seed, tick) => wouldHit(theft, seed, tick);

/** A player who never touches the key. */
const idle: Play = () => false;

/** A player who hits the key as fast as it will go. */
const masher: Play = () => true;

describe('what has to be stolen', () => {
  it('asks for a hotwire on the alarmed and the luxury, and on nothing else', () => {
    for (const cls of VEHICLE_CLASSES) {
      const spec = ROSTER[cls];
      expect(needsHotwire(spec), cls).toBe(spec.alarm || spec.luxury);
    }
  });

  it('leaves most of the roster to open on the key', () => {
    // Every aircraft is behind a lock (`aircraft-roster.ts`); the cars are the roster this is about.
    const cars = VEHICLE_CLASSES.filter((cls) => !isAircraft(cls));
    const worked = cars.filter((cls) => needsHotwire(ROSTER[cls]));
    expect(worked.length).toBeGreaterThan(0);
    expect(worked.length).toBeLessThan(cars.length / 2);
  });

  it('locks a vehicle worth stealing until it has been hotwired, and then never again', () => {
    const sports = specOf('sports');
    const v = createVehicleState(sports);
    expect(isLocked(v, sports)).toBe(true);
    v.hotwired = true;
    expect(isLocked(v, sports)).toBe(false);
  });

  it('never locks a vehicle that opens on the key', () => {
    const saloon = specOf('saloon');
    expect(isLocked(createVehicleState(saloon), saloon)).toBe(false);
  });
});

describe('the bar', () => {
  it('keeps every window a window clear of both ends, so it can be hit either way', () => {
    for (const seed of SEEDS) {
      for (const start of STARTS) {
        for (let pin = 0; pin < HOTWIRE_PINS; pin++) {
          const target = targetFor(seed, start, pin);
          expect(target).toBeGreaterThanOrEqual(TARGET_HALF);
          expect(target).toBeLessThanOrEqual(1 - TARGET_HALF);
        }
      }
    }
  });

  it('sweeps the whole bar and no further, there and back', () => {
    const theft = createTheft(specOf('sports'), 0);
    let low = Infinity;
    let high = -Infinity;
    for (let tick = 0; tick <= 4 * SWEEP_TICKS; tick++) {
      const at = markerAt(theft, tick);
      low = Math.min(low, at);
      high = Math.max(high, at);
    }
    expect(low).toBe(0);
    expect(high).toBeCloseTo(1, 6);
    expect(markerAt(theft, SWEEP_TICKS)).toBeCloseTo(1, 6);
    expect(markerAt(theft, 2 * SWEEP_TICKS)).toBeCloseTo(0, 6);
  });

  it('jams the marker at the near end while a miss is being paid for', () => {
    const seed = SEEDS[0] as number;
    const theft = createTheft(specOf('sports'), 0);
    // A press at the near end cannot be in a window, so it is a miss.
    stepTheft(theft, seed, 0, true);
    expect(theft.pins).toBe(0);
    for (let tick = 1; tick <= MISS_PENALTY; tick++) expect(markerAt(theft, tick)).toBe(0);
    expect(markerAt(theft, MISS_PENALTY + 1)).toBeGreaterThan(0);
  });
});

describe('a lock is always beaten', () => {
  it('opens under the floor for a player who waits for every window', () => {
    for (const seed of SEEDS) {
      for (const start of STARTS) {
        const { theft, ticks } = play(seed, start, perfect);
        expect(theft.open, `seed ${seed} at ${start}`).toBe(true);
        expect(theft.pins).toBe(HOTWIRE_PINS);
        expect(ticks, `seed ${seed} at ${start}`).toBeLessThanOrEqual(hotwireFloor());
      }
    }
  });

  it('leaves the floor well inside the cap, so there is room to be under pressure', () => {
    expect(hotwireFloor()).toBeLessThan(HOTWIRE_CAP);
  });

  it('gives way on its own at the cap to a player who never touches the key', () => {
    for (const seed of SEEDS) {
      for (const start of STARTS) {
        const { theft, ticks } = play(seed, start, idle);
        expect(theft.open, `seed ${seed} at ${start}`).toBe(true);
        expect(ticks).toBe(HOTWIRE_CAP);
      }
    }
  });

  it('cannot be lost by hitting the key at random', () => {
    for (const seed of SEEDS) {
      for (const start of STARTS) {
        const { theft, ticks } = play(seed, start, masher);
        expect(theft.open, `seed ${seed} at ${start}`).toBe(true);
        expect(ticks).toBeLessThanOrEqual(HOTWIRE_CAP);
      }
    }
  });

  it('rewards waiting over mashing', () => {
    for (const seed of SEEDS) {
      const start = STARTS[2] as number;
      expect(play(seed, start, perfect).ticks).toBeLessThan(play(seed, start, masher).ticks);
    }
  });
});

describe('the alarm', () => {
  it('raises heat for every second it sounds and stops when the lock opens', () => {
    const seed = SEEDS[0] as number;
    const { theft, ticks } = play(seed, 0, perfect);
    expect(theft.alarm).toBe(true);
    expect(theft.noise).toBeCloseTo(((ticks + 1) / TICK_RATE) * ALARM_HEAT_PER_SECOND, 6);
    // The lock is open: nothing further is added however long it is stepped.
    const was = theft.noise;
    stepTheft(theft, seed, ticks + 1, false);
    expect(theft.noise).toBe(was);
  });

  it('costs a slow theft more than a quick one', () => {
    const seed = SEEDS[0] as number;
    expect(play(seed, 0, idle).theft.noise).toBeGreaterThan(play(seed, 0, perfect).theft.noise);
  });

  it('makes no noise at all on a vehicle with no alarm', () => {
    // Luxury with no alarm: worth the work, and quiet while it is done.
    const quiet = { ...specOf('sports'), alarm: false };
    const theft = createTheft(quiet, 0);
    for (let tick = 0; tick < 120; tick++) stepTheft(theft, 7, tick, false);
    expect(theft.noise).toBe(0);
  });
});

describe('determinism', () => {
  it('asks the same presses of the same theft at the same tick of the same seed', () => {
    for (const seed of SEEDS) {
      for (const start of STARTS) {
        const a = play(seed, start, perfect);
        const b = play(seed, start, perfect);
        expect(JSON.stringify(a.theft)).toBe(JSON.stringify(b.theft));
        expect(a.ticks).toBe(b.ticks);
      }
    }
  });

  it('asks something else of another seed or another tick', () => {
    const first = targetFor(SEEDS[0] as number, 0, 0);
    const bySeed = SEEDS.map((seed) => targetFor(seed, 0, 0));
    const byTick = STARTS.map((start) => targetFor(SEEDS[0] as number, start, 0));
    expect(bySeed.some((t) => t !== first)).toBe(true);
    expect(byTick.some((t) => t !== first)).toBe(true);
  });
});
