import { describe, expect, it } from 'vitest';
import { AIRSIDE_EVERY, AIRSIDE_STARS, airsideAt, COMPOUND_STARS, stepAirside, theftOf } from '../src/sim/airside.ts';
import { CRIME_HEAT, effortFor, heatStars, raiseHeat } from '../src/sim/crime.ts';
import { helicopterFire } from '../src/sim/officer-fire.ts';
import { HELICOPTER_STARS, quarryOf, report, type PoliceUnit } from '../src/sim/police.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';
import type { Airfield } from '../src/world/types.ts';

/**
 * The airport the police guard (spec section 14): trespass on the airside, the
 * military compound, the theft of a military aircraft, and the gun of the
 * police helicopter.
 */

/** An airport along the x axis: a runway to the south, an apron and the compound to the north. */
const AIRPORT: Airfield = {
  id: 0,
  kind: 'airport',
  x: 0,
  y: 0,
  heading: 0,
  halfU: 500,
  halfV: 150,
  level: 10,
  gate: { x: 0, y: 220 },
  road: 0,
  parts: [
    { kind: 'runway', u: 0, v: -100, halfU: 450, halfV: 20, height: 0 },
    { kind: 'apron', u: 0, v: 25, halfU: 200, halfV: 50, height: 0 },
    { kind: 'compound', u: -390, v: 26, halfU: 90, halfV: 52, height: 0 },
    { kind: 'terminal', u: 0, v: 97, halfU: 110, halfV: 15, height: 14 },
  ],
  stands: [],
};

function standingAt(x: number, y: number, height = 10): SimState {
  const state = createSimState(4);
  state.player.driving = false;
  state.player.x = x;
  state.player.y = y;
  state.player.height = height;
  return state;
}

/** The stars a player standing somewhere for a minute is left at. */
function starsAfterAMinute(x: number, y: number, height = 10): number {
  const state = standingAt(x, y, height);
  for (let i = 0; i < 60 * 60; i++) {
    stepAirside(state, [AIRPORT]);
    state.tick += 1;
  }
  return heatStars(state.heat);
}

describe('the airside (spec section 14)', () => {
  it('tells the runway and the compound from the terminal and the ground outside', () => {
    expect(airsideAt([AIRPORT], 100, -100)).toBe('airside');
    expect(airsideAt([AIRPORT], 50, 30)).toBe('airside');
    expect(airsideAt([AIRPORT], -400, 30)).toBe('compound');
    expect(airsideAt([AIRPORT], 0, 97)).toBeUndefined();
    expect(airsideAt([AIRPORT], 0, 400)).toBeUndefined();
  });

  it('raises the heat on the airside, and only as far as its stars', () => {
    expect(starsAfterAMinute(100, -100)).toBe(AIRSIDE_STARS);
    expect(starsAfterAMinute(-400, 30)).toBe(COMPOUND_STARS);
    expect(starsAfterAMinute(0, 400)).toBe(0);
    // Flying over it is not standing on it.
    expect(starsAfterAMinute(100, -100, 200)).toBe(0);
  });

  it('reports a trespasser once in a while, not every tick', () => {
    const state = standingAt(100, -100);
    for (let i = 0; i < AIRSIDE_EVERY; i++) {
      stepAirside(state, [AIRPORT]);
      state.tick += 1;
    }
    expect(state.heat).toBeCloseTo(raiseHeat(0, CRIME_HEAT.trespass), 6);
  });

  it('weighs the theft of a military aircraft at the stars the helicopter comes at', () => {
    expect(theftOf('fighter')).toBe('militaryTheft');
    expect(theftOf('heli-attack')).toBe('militaryTheft');
    expect(theftOf('bizjet')).toBe('theft');
    expect(theftOf('saloon')).toBe('theft');
    expect(heatStars(raiseHeat(0, CRIME_HEAT.militaryTheft))).toBeGreaterThanOrEqual(HELICOPTER_STARS);
  });
});

describe('the police helicopter gun (spec section 14)', () => {
  function helicopter(x: number, y: number): PoliceUnit {
    return {
      id: 7,
      kind: 'helicopter',
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
      fired: -1_000_000,
      incident: -1,
    };
  }

  /** Rounds the helicopter fires in ten seconds at a player at a heat. */
  function rounds(stars: number, distance: number): number {
    const state = standingAt(0, 0, 0);
    report(state, effortFor(stars));
    const unit = helicopter(distance, 0);
    for (let i = 0; i < 600; i++) {
      helicopterFire(state, unit, quarryOf(state));
      state.tick += 1;
    }
    return state.tracers.filter((t) => t.by === 'police').length;
  }

  it('fires down at a player at high heat, in range, and not otherwise', () => {
    expect(rounds(HELICOPTER_STARS, 60)).toBeGreaterThan(10);
    expect(rounds(HELICOPTER_STARS - 1, 60)).toBe(0);
    expect(rounds(HELICOPTER_STARS, 400)).toBe(0);
  });
});
