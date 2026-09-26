import { describe, expect, it } from 'vitest';
import { hearPolice } from '../../../src/audio/police-ears.ts';
import type { Cue } from '../../../src/audio/cue.ts';
import type { Cry } from '../../../src/audio/cry.ts';
import { CUFF_TICKS, maySurrender, pressesToFree, stepArrest } from '../../../src/sim/police/arrest.ts';
import { effortFor, heatStars } from '../../../src/sim/police/crime.ts';
import { EMPTY_INPUT, type InputFrame } from '../../../src/sim/input.ts';
import { CREW, createOfficer, hurtOfficer, mayFire, OFFICER_HEALTH, officerWeapon } from '../../../src/sim/police/officer.ts';
import { officerFire } from '../../../src/sim/police/officer-fire.ts';
import { PoliceForce, quarryOf, report, type DistrictAt, type PoliceUnit } from '../../../src/sim/police/police.ts';
import { ARREST_BRIBE, respawn, SURRENDER_BRIBE } from '../../../src/sim/player/respawn.ts';
import { createSimState, type SimState } from '../../../src/sim/simulation.ts';
import { arrestLine } from '../../../src/ui/hud/arrest-line.ts';
import { stableJson } from '../../support/helpers.ts';
import { gridTrafficRoads } from '../../support/traffic-grid.ts';
import { compareStrings } from '../../../src/core/sort.ts';

/**
 * The police on foot of spec section 14, run headless on the grid of
 * `traffic-grid.ts`, with no walls: a crew bails out, cuffs, is broken free
 * of, takes a surrender, shoots by the stars and gets back in its car.
 */
const roads = gridTrafficRoads();

/** Out of downtown, so no beat is walked and every officer came out of a car. */
const suburb: DistrictAt = () => ({ zone: 'suburban', wealth: 1 });

function session(seed: number, heat: number): { state: SimState; force: PoliceForce } {
  const state = createSimState(seed);
  state.player.driving = false;
  state.player.x = 0;
  state.player.y = 0;
  report(state, effortFor(heat));
  return { state, force: new PoliceForce(roads, suburb) };
}

/** One tick as `stepSim` runs it: the cuffs first, then the police. */
function tick(state: SimState, force: PoliceForce, input: InputFrame = EMPTY_INPUT): void {
  stepArrest(state, input);
  force.step(state);
  state.tick += 1;
}

/** Run until the first car is out, then stand the player next to it with the car stopped. */
function pulledUp(seed: number, heat: number): { state: SimState; force: PoliceForce; unit: PoliceUnit } {
  const { state, force } = session(seed, heat);
  while (state.police.units.length === 0) tick(state, force);
  const unit = state.police.units[0] as PoliceUnit;
  state.player.x = unit.x + 3;
  state.player.y = unit.y;
  unit.speed = 0;
  force.step(state);
  return { state, force, unit };
}

describe('the police on foot (spec section 14)', () => {
  it('lets the whole crew out of a car that pulls up near the player, and holds the car', () => {
    const { state, unit } = pulledUp(3, 1.5);
    const crew = state.police.officers.filter((o) => o.unit === unit.id);
    expect(crew).toHaveLength(CREW[unit.kind]);
    expect(unit.crew).toBe(0);
    expect(crew.every((o) => o.kind === 'patrol')).toBe(true);
  });

  it('cuffs a player who stands still, and the cuffs close into an arrest', () => {
    const { state, force } = pulledUp(3, 1.5);
    for (let i = 0; i < 20 && state.police.cuffs === null; i++) tick(state, force);
    expect(state.police.cuffs).not.toBeNull();
    expect(state.police.cuffs?.need).toBe(pressesToFree(state.heat));
    for (let i = 0; i <= CUFF_TICKS && !state.arrested; i++) tick(state, force);
    expect(state.arrested).toBe(true);
    const bribe = state.money;
    respawn(state, 'arrest', { x: 0, y: 0, heading: 0 });
    expect(bribe - state.money).toBe(Math.min(bribe, ARREST_BRIBE));
    expect(state.police.officers).toEqual([]);
  });

  it('lets a player who mashes the key break free, knocks the officer back and adds heat', () => {
    const { state, force } = pulledUp(5, 1.5);
    for (let i = 0; i < 20 && state.police.cuffs === null; i++) tick(state, force);
    const cuffs = state.police.cuffs;
    expect(cuffs).not.toBeNull();
    const officer = cuffs?.officer;
    const heat = state.heat;
    // A key already down when the cuffs go on is not a press: the first counts from the second tick.
    for (let i = 0; i < 2 * pressesToFree(heat) + 2 && state.police.cuffs !== null; i++) {
      tick(state, force, { ...EMPTY_INPUT, jump: i % 2 === 0 });
    }
    expect(state.police.cuffs).toBeNull();
    expect(state.arrested).toBe(false);
    expect(state.heat).toBeGreaterThan(heat);
    const shoved = state.police.officers.find((o) => o.id === officer);
    expect(shoved?.stunned).toBeGreaterThan(state.tick);
    // Nobody may take hold again during the grace.
    tick(state, force);
    expect(state.police.cuffs).toBeNull();
  });

  it('asks more presses to break free the higher the heat', () => {
    expect(pressesToFree(1.5)).toBeLessThan(pressesToFree(4.5));
  });

  it('takes a surrender at one or two stars for the smaller bribe, with nothing to break free of', () => {
    const { state, force } = pulledUp(7, 1.5);
    expect(maySurrender(state)).toBe(true);
    expect(arrestLine(state).text).toBe('X to give up');
    tick(state, force, { ...EMPTY_INPUT, surrender: true });
    expect(state.police.surrendered).toBe(true);
    for (let i = 0; i < 200 && !state.arrested; i++) tick(state, force);
    expect(state.arrested).toBe(true);
    const money = state.money;
    respawn(state, 'arrest', { x: 0, y: 0, heading: 0 });
    expect(money - state.money).toBe(Math.min(money, SURRENDER_BRIBE));
    expect(SURRENDER_BRIBE).toBeLessThan(ARREST_BRIBE);
    expect(state.police.surrendered).toBe(false);
  });

  it('takes no surrender at three stars', () => {
    const { state } = pulledUp(7, 3.2);
    expect(heatStars(state.heat)).toBe(3);
    expect(maySurrender(state)).toBe(false);
  });

  it('draws a bigger gun as the stars go up, and shoots only from two stars', () => {
    expect(officerWeapon('patrol', 2)).toBe('glock-17');
    expect(officerWeapon('patrol', 3)).toBe('remington-870');
    expect(officerWeapon('swat', 5)).toBe('m4a1');
    const calm = createSimState(1);
    calm.heat = 1.5;
    expect(mayFire(calm)).toBe(false);
    calm.heat = 2.2;
    expect(mayFire(calm)).toBe(true);
  });

  it('fires police tracers at a player in sight at three stars, and none at one', () => {
    for (const [heat, fires] of [
      [1.5, false],
      [3.2, true],
    ] as const) {
      const state = createSimState(11);
      state.player.driving = false;
      state.heat = heat;
      const officer = createOfficer(0, 'patrol', -1, 'pursue', 6, 0, 0, Math.PI);
      state.police.officers.push(officer);
      officerFire(state, officer, quarryOf(state), true, undefined);
      const police = state.tracers.filter((t) => t.by === 'police');
      expect(police.length > 0).toBe(fires);
      expect(officer.aiming).toBe(fires);
    }
  });

  it('puts down an officer who runs out of health: a body, a gun on the ground, and heat', () => {
    const state = createSimState(13);
    state.police.officers.push(createOfficer(4, 'swat', -1, 'pursue', 10, 0, 0, 0));
    expect(hurtOfficer(state, 4, OFFICER_HEALTH.patrol, 0)).toBe(false);
    expect(hurtOfficer(state, 4, OFFICER_HEALTH.swat, 0)).toBe(true);
    expect(state.police.officers).toEqual([]);
    expect(state.police.fallen).toHaveLength(1);
    expect(state.police.fallen[0]?.kind).toBe('swat');
    expect(state.pickups).toHaveLength(1);
    expect(state.heat).toBeGreaterThan(0);
    expect(state.police.barks.some((b) => b.kind === 'down')).toBe(true);
  });

  it('gets the crew back in once the player has driven off, and the car drives on', () => {
    const { state, force, unit } = pulledUp(3, 1.5);
    expect(unit.crew).toBe(0);
    state.player.driving = true;
    state.vehicle.x = unit.x + 200;
    state.vehicle.z = unit.y;
    state.vehicle.speed = 20;
    for (let i = 0; i < 10 * 60 && unit.crew < CREW[unit.kind]; i++) tick(state, force);
    expect(unit.crew).toBe(CREW[unit.kind]);
    expect(state.police.officers.filter((o) => o.unit === unit.id)).toEqual([]);
  });

  it('leaves a car standing when its whole crew is put down, and sends another', () => {
    const { state, force, unit } = pulledUp(3, 1.5);
    for (const officer of [...state.police.officers]) hurtOfficer(state, officer.id, OFFICER_HEALTH.patrol, 0);
    const at = { x: unit.x, y: unit.y };
    const before = state.police.units.length;
    for (let i = 0; i < 30 * 60 && state.police.units.length === before; i++) tick(state, force);
    expect(state.police.units.length).toBeGreaterThan(before);
    expect(unit.x).toBe(at.x);
    expect(unit.y).toBe(at.y);
  });

  it('is the same from the same seed', () => {
    const a = pulledUp(17, 2.5);
    const b = pulledUp(17, 2.5);
    for (let i = 0; i < 300; i++) {
      tick(a.state, a.force);
      tick(b.state, b.force);
    }
    expect(stableJson(a.state.police)).toBe(stableJson(b.state.police));
    expect(stableJson(a.state.tracers)).toBe(stableJson(b.state.tracers));
  });

  it('is heard: a gunshot for each police shot, and a shout or a radio call for each bark', () => {
    const state = createSimState(19);
    state.tick = 100;
    state.tracers.push(
      { tick: 100, pellet: 0, x: 1, y: 2, h: 1, ex: 5, ey: 2, eh: 1, end: 'none', by: 'police' },
      { tick: 100, pellet: 1, x: 1, y: 2, h: 1, ex: 5, ey: 3, eh: 1, end: 'none', by: 'police' },
      { tick: 100, pellet: 0, x: 1, y: 2, h: 1, ex: 5, ey: 2, eh: 1, end: 'none', by: 'player' },
    );
    state.police.barks.push({ tick: 100, kind: 'freeze', x: 3, y: 3 }, { tick: 99, kind: 'spotted', x: 0, y: 0 });
    const cues: Cue[] = [];
    const cries: Cry[] = [];
    hearPolice(state, 98, cues, cries);
    expect(cues.filter((c) => c.kind === 'gunshot')).toHaveLength(1);
    expect(cues.filter((c) => c.kind === 'squelch')).toHaveLength(1);
    expect(cries.map((c) => c.kind).sort(compareStrings)).toEqual(['radio', 'shout']);
  });
});
