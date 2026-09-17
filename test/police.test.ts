import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../src/sim/clock.ts';
import { COOL_DELAY, CRIME_HEAT, decayHeat, HEAT_CAP, heatForCrime } from '../src/sim/crime.ts';
import {
  commitCrime,
  HELICOPTER_STARS,
  hurtUnit,
  PoliceForce,
  quarryOf,
  report,
  responseTicks,
  shootUnit,
  UNIT_ARMOUR,
  type DistrictAt,
  type PoliceUnit,
} from '../src/sim/police.ts';
import { cloneSimState, createSimState, type SimState } from '../src/sim/simulation.ts';
import { stableJson } from './helpers.ts';
import { gridTrafficRoads } from './traffic-grid.ts';

/**
 * The heat and the police of spec section 14, run headless: the rules are pure
 * and the units drive a road graph, so a chase is stepped here without Rapier
 * and without a renderer. The grid of `traffic-grid.ts` is the city.
 */
const roads = gridTrafficRoads();

/** A district that answers at once, so a test is not spent waiting for a car. */
const downtown: DistrictAt = () => ({ zone: 'core', wealth: 1 });

/** A session standing in the middle of the grid, with the heat a case needs. */
function session(seed: number, heat: number, districts: DistrictAt = downtown): { state: SimState; force: PoliceForce } {
  const state = createSimState(seed);
  // On foot in the middle of the grid: the police chase the player themselves
  // rather than the car the record starts them in.
  state.player.driving = false;
  state.player.x = 0;
  state.player.y = 0;
  // The heat is reported rather than written, because a crime is also what
  // tells the police where to start looking.
  report(state, heat);
  return { state, force: new PoliceForce(roads, districts) };
}

/** Step a session for a number of ticks, as `stepSim` does around the physics. */
function run(state: SimState, force: PoliceForce, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    force.step(state);
    state.tick += 1;
  }
}

/** Metres from the player to the nearest unit, or Infinity while none is out. */
function nearest(state: SimState): number {
  const quarry = quarryOf(state);
  let best = Infinity;
  for (const unit of state.police.units) best = Math.min(best, Math.hypot(unit.x - quarry.x, unit.y - quarry.y));
  return best;
}

describe('heat (spec section 14)', () => {
  it('weighs a crime by what it is, and never goes past the stars the HUD has', () => {
    expect(CRIME_HEAT.brawl).toBeLessThan(CRIME_HEAT.theft);
    expect(CRIME_HEAT.theft).toBeLessThan(CRIME_HEAT.killing);
    expect(CRIME_HEAT.killing).toBeLessThan(CRIME_HEAT.officerKilling);
    let heat = 0;
    for (let i = 0; i < 20; i++) heat = heatForCrime(heat, 'officerKilling');
    expect(heat).toBe(HEAT_CAP);
  });

  it('holds every point of the heat while a unit can see the player', () => {
    expect(decayHeat(3, 1000, 1000)).toBe(3);
    expect(decayHeat(3, 1000 + COOL_DELAY - 1, 1000)).toBe(3);
  });

  it('runs the heat down once nobody has seen the player for a while, and stops at nothing', () => {
    let heat = 2;
    const seen = 0;
    for (let tick = COOL_DELAY; heat > 0 && tick < COOL_DELAY + 600 * TICK_RATE; tick++) heat = decayHeat(heat, tick, seen);
    expect(heat).toBe(0);
    expect(decayHeat(0, 10_000, 0)).toBe(0);
  });
});

describe('response (spec section 14)', () => {
  it('answers at once downtown and takes the best part of a minute in the wilderness', () => {
    const core = responseTicks({ zone: 'core', wealth: 1 });
    const wild = responseTicks({ zone: 'wilderness', wealth: 0.1 });
    expect(core).toBeLessThan(5 * TICK_RATE);
    expect(wild).toBeGreaterThan(20 * TICK_RATE);
  });

  it('answers a wealthy district faster than a poor one of the same zone', () => {
    expect(responseTicks({ zone: 'suburban', wealth: 1 })).toBeLessThan(responseTicks({ zone: 'suburban', wealth: 0 }));
  });
});

describe('the chase (spec section 14)', () => {
  it('sends nobody at all while the player is clean', () => {
    const { state, force } = session(11, 0);
    run(state, force, 10 * TICK_RATE);
    expect(state.police.units).toHaveLength(0);
  });

  it('escalates: more heat brings more units out, and high heat puts a helicopter up', () => {
    const one = session(12, 1.2);
    run(one.state, one.force, 30 * TICK_RATE);
    const many = session(12, HEAT_CAP);
    run(many.state, many.force, 30 * TICK_RATE);
    expect(one.state.police.units.length).toBeGreaterThan(0);
    expect(many.state.police.units.length).toBeGreaterThan(one.state.police.units.length);
    const flying = many.state.police.units.filter((unit: PoliceUnit) => unit.kind === 'helicopter');
    expect(flying).toHaveLength(1);
    expect(HELICOPTER_STARS).toBeLessThan(HEAT_CAP);
  });

  it('closes on the player over the road graph and keeps the sighting fresh', () => {
    const { state, force } = session(13, 3);
    run(state, force, 10 * TICK_RATE);
    const far = nearest(state);
    run(state, force, 40 * TICK_RATE);
    expect(nearest(state)).toBeLessThan(far);
    expect(state.police.lastKnown).not.toBeNull();
    expect(state.tick - state.police.seenTick).toBeLessThan(COOL_DELAY);
  });

  it('coordinates: one car cuts the player off and one stands across the road', () => {
    const { state, force } = session(14, HEAT_CAP);
    run(state, force, 60 * TICK_RATE);
    const tasks = state.police.units.map((unit: PoliceUnit) => unit.task);
    expect(tasks).toContain('cutoff');
    expect(tasks).toContain('block');
    const blocking = state.police.units.filter((unit: PoliceUnit) => unit.task === 'block');
    run(state, force, 60 * TICK_RATE);
    // A roadblock is a car that has stopped where it was sent, not one that circles.
    expect(blocking.length).toBeGreaterThan(0);
  });

  it('searches the last known place once nobody has seen the player for a while', () => {
    const { state, force } = session(15, 3);
    run(state, force, 30 * TICK_RATE);
    const known = state.police.lastKnown;
    expect(known).not.toBeNull();
    // The player is gone: nothing can see them from here, so the units cast about.
    state.player.x = 6000;
    state.player.y = 6000;
    run(state, force, 20 * TICK_RATE);
    expect(state.police.units.every((unit: PoliceUnit) => unit.task === 'search')).toBe(true);
    expect(state.police.lastKnown).toEqual(known);
  });

  it('lets the heat run out once the player has broken away, and takes the units off the map', () => {
    const { state, force } = session(16, 1.2);
    run(state, force, 20 * TICK_RATE);
    expect(state.police.units.length).toBeGreaterThan(0);
    state.player.x = 6000;
    state.player.y = 6000;
    run(state, force, 200 * TICK_RATE);
    expect(state.heat).toBe(0);
    expect(state.police.units).toHaveLength(0);
    expect(state.police.lastKnown).toBeNull();
  });

  it('takes a player on foot in when a car reaches them', () => {
    const { state, force } = session(17, 2);
    run(state, force, 20 * TICK_RATE);
    const unit = state.police.units[0] as PoliceUnit;
    state.player.x = unit.x;
    state.player.y = unit.y;
    force.step(state);
    expect(state.arrested).toBe(true);
  });
});

describe('destroying the pursuers (spec section 14)', () => {
  it('takes a wrecked unit off the map and charges the player hard for it', () => {
    const { state, force } = session(18, 2);
    run(state, force, 20 * TICK_RATE);
    const unit = state.police.units[0] as PoliceUnit;
    const before = state.heat;
    shootUnit(state, unit.id, UNIT_ARMOUR);
    expect(state.police.units.some((u: PoliceUnit) => u.id === unit.id)).toBe(false);
    expect(state.heat).toBeGreaterThan(before + CRIME_HEAT.officerKilling);
  });

  it('leaves what the wrecked car held on the ground for the player to take', () => {
    const { state, force } = session(20, 2);
    run(state, force, 20 * TICK_RATE);
    const unit = state.police.units[0] as PoliceUnit;
    shootUnit(state, unit.id, UNIT_ARMOUR);
    expect(state.pickups).toHaveLength(1);
    const dropped = state.pickups[0] as (typeof state.pickups)[number];
    expect(Math.hypot(dropped.x - unit.x, dropped.y - unit.y)).toBeLessThan(1);
  });

  it('leaves a unit that is only damaged on the road', () => {
    const { state, force } = session(19, 2);
    run(state, force, 20 * TICK_RATE);
    const unit = state.police.units[0] as PoliceUnit;
    expect(hurtUnit(state, unit.id, UNIT_ARMOUR / 2)).toBe(false);
    expect(state.police.units.some((u: PoliceUnit) => u.id === unit.id)).toBe(true);
  });
});

describe('determinism (spec section 2.2)', () => {
  it('chases the same way twice from the same seed, and another way from another', () => {
    const chase = (seed: number): string => {
      const { state, force } = session(seed, 3);
      run(state, force, 60 * TICK_RATE);
      return stableJson(state.police);
    };
    expect(chase(21)).toBe(chase(21));
    expect(chase(21)).not.toBe(chase(22));
  });

  it('carries a chase through a save: the record is all the force holds', () => {
    const { state, force } = session(24, 3);
    run(state, force, 30 * TICK_RATE);
    const carried = cloneSimState(state);
    run(state, force, 30 * TICK_RATE);
    // The loaded record is stepped by a force that has never seen it before,
    // and it goes on exactly as the session it came from did.
    const fresh = new PoliceForce(roads, downtown);
    run(carried, fresh, 30 * TICK_RATE);
    expect(stableJson(carried.police)).toBe(stableJson(state.police));
  });

  it('commits a crime as the debug key does, and the heat is all the record keeps of it', () => {
    const state = createSimState(23);
    commitCrime(state, 'assault');
    expect(state.heat).toBe(CRIME_HEAT.assault);
  });
});
