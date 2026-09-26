import { describe, expect, it } from 'vitest';
import type { CasualtyGround } from '../../../src/sim/crowd/casualty.ts';
import { TICKS_PER_DAY } from '../../../src/sim/clock.ts';
import { COOL_DELAY, effortFor } from '../../../src/sim/police/crime.ts';
import { unitFire } from '../../../src/sim/police/officer-fire.ts';
import type { Place } from '../../../src/sim/player/on-foot.ts';
import { answerGoal, ANSWER_EVERY, ANSWER_NEAR, ANSWERING, incidentsNear } from '../../../src/sim/police/patrol.ts';
import { PoliceForce, quarryOf, report, type DistrictAt, type PoliceKind, type PoliceUnit } from '../../../src/sim/police/police.ts';
import { createSimState, type SimState } from '../../../src/sim/simulation.ts';
import { crimeGrounds, type CrimeGround, type StreetCrime } from '../../../src/sim/city/street-crime.ts';
import type { District } from '../../../src/world/types.ts';
import { stableJson } from '../../support/helpers.ts';
import { GRID_SPACING, gridTrafficRoads } from '../../support/traffic-grid.ts';

/**
 * What spec section 14 asks of the police past the chase itself: a car sees
 * nothing through a building, a crew in a stopped car fires back, and a
 * patrol answers the city's own street crime while nobody is after the
 * player. Run headless on the grid of `traffic-grid.ts`; a wall is a ground
 * whose every ray stops short.
 */
const roads = gridTrafficRoads();
const downtown: DistrictAt = () => ({ zone: 'core', wealth: 1 });

/** Every ray stops a metre out: the player stands behind a building from anywhere. */
const walled: CasualtyGround = { reach: (_x, _h, _y, _dir, max) => Math.min(max, 1), heightAt: () => 0 };
/** Nothing stands anywhere. */
const open: CasualtyGround = { reach: (_x, _h, _y, _dir, max) => max, heightAt: () => 0 };

function onFoot(seed: number, x = 0, y = 0): SimState {
  const state = createSimState(seed);
  state.player.driving = false;
  state.player.x = x;
  state.player.y = y;
  return state;
}

function unitAt(id: number, kind: PoliceKind, x: number, y: number): PoliceUnit {
  return {
    id,
    kind,
    task: 'chase',
    x,
    y,
    heading: 0,
    height: 0,
    speed: 0,
    health: 1.4,
    edges: [],
    distance: 0,
    planned: 0,
    goalX: x,
    goalY: y,
    crew: 2,
    doors: 0,
    doorTick: -1_000_000,
    fired: -1_000_000,
    incident: -1,
  };
}

describe('sight (spec section 14)', () => {
  /** Ticks since the police last saw the player, after one step with a car 30 m off. */
  function sighted(kind: PoliceKind, ground: CasualtyGround): number {
    const state = onFoot(3);
    report(state, effortFor(1));
    state.tick += COOL_DELAY / 2;
    state.police.units.push(unitAt(0, kind, 30, 0));
    // A car within the range of the crew gets out, so it is told not to stop.
    state.police.units[0]!.speed = 20;
    new PoliceForce(roads, downtown).step(state, ground);
    return state.tick - state.police.seenTick;
  }

  it('sees a player in the open', () => {
    expect(sighted('patrol', open)).toBe(0);
  });

  it('sees nothing through a building, so the heat is left to cool', () => {
    expect(sighted('patrol', walled)).toBe(COOL_DELAY / 2);
  });

  it('lets the helicopter look down over the roofs', () => {
    expect(sighted('helicopter', walled)).toBe(0);
  });
});

describe('fire from a car (spec sections 11.6 and 14)', () => {
  /** Tracers the crew of one stopped car fires in ten seconds, and the health the player is left with. */
  function volley(stars: number, ground: CasualtyGround | undefined, speed = 0, seed = 8): { rounds: number; health: number; json: string } {
    const state = onFoot(seed);
    report(state, effortFor(stars));
    const unit = unitAt(0, 'patrol', 15, 0);
    unit.speed = speed;
    for (let i = 0; i < 600; i++) {
      unitFire(state, unit, quarryOf(state), ground);
      state.tick += 1;
    }
    const rounds = state.tracers.filter((t) => t.by === 'police').length;
    return { rounds, health: state.player.health, json: stableJson(state.tracers) };
  }

  it('fires out of a stopped car at a player it can see, and lands some of it', () => {
    const shot = volley(2, open);
    expect(shot.rounds).toBeGreaterThan(5);
    expect(shot.health).toBeLessThan(createSimState(8).player.health);
  });

  it('holds fire under two stars, from a moving car, and through a building', () => {
    expect(volley(1, open).rounds).toBe(0);
    expect(volley(2, open, 12).rounds).toBe(0);
    expect(volley(2, walled).rounds).toBe(0);
  });

  it('fires the same rounds twice from the same seed, and others from another', () => {
    expect(volley(3, open).json).toBe(volley(3, open).json);
    expect(volley(3, open).json).not.toBe(volley(3, open, 0, 9).json);
  });
});

describe('policing the world (spec section 14)', () => {
  const districts: District[] = [{ id: 0, name: 'Downtown', zone: 'core', x: 0, y: 0, density: 0.9, wealth: 0.6, culture: 'none' }];
  // Every corner is put on the nearest crossing of the grid, where a car can reach it.
  const snap = (x: number, y: number): Place => ({
    x: Math.max(-2, Math.min(2, Math.round(x / GRID_SPACING))) * GRID_SPACING,
    y: Math.max(-2, Math.min(2, Math.round(y / GRID_SPACING))) * GRID_SPACING,
    heading: 0,
  });
  const grounds: CrimeGround[] = crimeGrounds(4, districts, snap);

  /** Ticks an incident has to stay in the diary for the tests below: long enough for a car to arrive. */
  const STAY = 25 * 60;

  /** The first incident of the diary that stays in it {@link STAY} ticks, and a session standing near it. */
  function beside(seed: number): { crime: StreetCrime; state: SimState } {
    const near = (tick: number): StreetCrime[] => {
      const probe = onFoot(seed);
      probe.tick = tick;
      return incidentsNear(probe, grounds, quarryOf(probe));
    };
    for (let tick = 0; tick < 6 * TICKS_PER_DAY; tick += ANSWER_EVERY) {
      for (const crime of near(tick)) {
        if (!near(tick + STAY).some((later) => later.id === crime.id)) continue;
        const state = onFoot(seed, crime.x + 40, crime.y);
        state.tick = tick;
        return { crime, state };
      }
    }
    throw new Error('no incident in six days');
  }

  function run(state: SimState, force: PoliceForce, ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      force.step(state, undefined, grounds);
      state.tick += 1;
    }
  }

  it('sends a car to an incident near the player, from out of sight, and it closes on it', () => {
    const { crime, state } = beside(4);
    const force = new PoliceForce(roads, downtown);
    run(state, force, 1);
    const unit = state.police.units.find((u) => u.incident === crime.id);
    expect(unit?.task).toBe('answer');
    const goal = answerGoal(crime);
    const gap = (): number => Math.hypot(unit!.x - goal.x, unit!.y - goal.y);
    // It comes in out of sight, on the far side of the incident from the player.
    expect(Math.hypot(unit!.x - state.player.x, unit!.y - state.player.y)).toBeGreaterThan(ANSWER_NEAR);
    const start = gap();
    run(state, force, STAY - 1);
    expect(unit!.task).toBe('answer');
    expect(gap()).toBeLessThan(start / 2);
    expect(state.heat).toBe(0);
    expect(state.police.units.filter((u) => u.task === 'answer').length).toBeLessThanOrEqual(ANSWERING);
  });

  it('drives off once the player has left the incident behind', () => {
    const { crime, state } = beside(4);
    const force = new PoliceForce(roads, downtown);
    run(state, force, 1);
    state.player.x = crime.x + ANSWER_NEAR + 200;
    run(state, force, ANSWER_EVERY + 1);
    const unit = state.police.units.find((u) => u.id === 0);
    expect(unit === undefined || unit.task === 'leave').toBe(true);
  });

  it('drops the call the moment a chase starts: the car joins it', () => {
    const { state } = beside(4);
    const force = new PoliceForce(roads, downtown);
    run(state, force, 1);
    expect(state.police.units.length).toBeGreaterThan(0);
    report(state, effortFor(1));
    run(state, force, 1);
    for (const unit of state.police.units) {
      expect(unit.incident).toBe(-1);
      expect(unit.task === 'answer' || unit.task === 'leave').toBe(false);
    }
  });

  it('answers the same way twice from the same seed', () => {
    const trace = (): string => {
      const { state } = beside(4);
      run(state, new PoliceForce(roads, downtown), 10 * 60);
      return stableJson(state.police.units);
    };
    expect(trace()).toBe(trace());
  });
});
