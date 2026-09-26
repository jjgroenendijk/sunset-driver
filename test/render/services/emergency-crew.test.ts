import { describe, expect, it } from 'vitest';
import { unitShape } from '../../../src/render/services/emergency-mesh.ts';
import { emptyHose, hoseOf } from '../../../src/render/services/emergency-crew.ts';
import {
  CREW_HEALTH,
  CREW_SIZE,
  crewAboard,
  crewOf,
  hosing,
  hurtCrew,
  OUTLET_UP,
  placeCrew,
  stepUnitCrew,
  type CrewMember,
} from '../../../src/sim/city/emergency-crew.ts';
import { UNIT_BODY, WORK_TICKS, type EmergencyUnit } from '../../../src/sim/city/emergency.ts';
import { createSimState, type SimState } from '../../../src/sim/simulation.ts';

/** An engine at 0, 0 facing +x, standing at a scene it pulled up at on tick `start`. */
function engineAt(start: number, goalX: number, goalY: number): EmergencyUnit {
  return {
    id: 3,
    kind: 'engine',
    task: 'work',
    call: 0,
    x: 0,
    y: 0,
    heading: 0,
    height: 5,
    speed: 0,
    edges: [],
    distance: 0,
    stop: 0,
    planned: 0,
    goalX,
    goalY,
    homeX: 0,
    homeY: 0,
    until: start + WORK_TICKS.engine,
    doors: 0,
    deployed: false,
  };
}

/** A session with one unit standing at a scene, stepped from the tick it pulled up. */
function scene(unit: EmergencyUnit, start = 0): SimState {
  const state = createSimState(7);
  state.tick = start;
  state.emergency.units.push(unit);
  return state;
}

/** Step the crew of a unit for a run of ticks. */
function run(state: SimState, unit: EmergencyUnit, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    stepUnitCrew(state, unit);
    state.tick += 1;
  }
}

describe('the crew of an emergency unit (spec section 20.3)', () => {
  it('opens the doors before anybody climbs down, and puts nobody out before they stand open', () => {
    const unit = engineAt(0, 12, 6);
    const state = scene(unit);
    stepUnitCrew(state, unit);
    expect(unit.doors).toBeGreaterThan(0);
    expect(unit.doors).toBeLessThan(1);
    expect(state.emergency.crew).toHaveLength(0);
    run(state, unit, 60);
    expect(unit.doors).toBe(1);
    expect(state.emergency.crew).toHaveLength(CREW_SIZE.engine);
    // They climb down at the cab, on the flank that faces the scene.
    for (const member of state.emergency.crew) {
      expect(member.y).toBeGreaterThan(UNIT_BODY.engine.halfWidth);
      expect(member.x).toBeGreaterThan(0);
    }
  });

  it('walks the firefighters out to the hose and turns the water on when they get there', () => {
    const unit = engineAt(0, 12, 6);
    const state = scene(unit);
    run(state, unit, 60);
    expect(hosing(state, unit)).toBe(false);
    const first = crewOf(state, unit.id)[0] as CrewMember;
    const from = { x: first.x, y: first.y };
    run(state, unit, 30);
    const moved = crewOf(state, unit.id)[0] as CrewMember;
    expect(Math.hypot(moved.x - from.x, moved.y - from.y)).toBeGreaterThan(0.5);
    expect(moved.gait).toBe('run');
    // Once they are at their places they face the scene and the water is on.
    run(state, unit, 180);
    expect(hosing(state, unit)).toBe(true);
    for (const member of crewOf(state, unit.id)) {
      expect(member.task).toBe('work');
      expect(member.gait).toBe('aim');
      const facing = Math.atan2(6 - member.y, 12 - member.x);
      expect(Math.abs(Math.atan2(Math.sin(member.heading - facing), Math.cos(member.heading - facing)))).toBeLessThan(0.01);
    }
    // Two people, not one inside the other.
    const crew = crewOf(state, unit.id);
    expect(Math.hypot((crew[0] as CrewMember).x - (crew[1] as CrewMember).x, (crew[0] as CrewMember).y - (crew[1] as CrewMember).y)).toBeGreaterThan(1);
  });

  it('carries them back to the door at the end of the work and shuts it behind them', () => {
    const unit = engineAt(0, 12, 6);
    const state = scene(unit);
    run(state, unit, 300);
    const door = { x: (crewOf(state, unit.id)[0] as CrewMember).doorX, y: (crewOf(state, unit.id)[0] as CrewMember).doorY };
    expect(crewAboard(state, unit)).toBe(false);
    state.tick = unit.until;
    run(state, unit, 1);
    for (const member of crewOf(state, unit.id)) expect(member.task).toBe('back');
    expect(Math.hypot(door.x, door.y)).toBeGreaterThan(0);
    run(state, unit, 200);
    expect(state.emergency.crew).toHaveLength(0);
    expect(unit.doors).toBe(0);
    expect(crewAboard(state, unit)).toBe(true);
    expect(hosing(state, unit)).toBe(false);
  });

  it('lets a round put one of them down, and sends the rest back to the unit', () => {
    const unit = engineAt(0, 12, 6);
    const state = scene(unit);
    run(state, unit, 300);
    const crew = crewOf(state, unit.id);
    expect(crew).toHaveLength(2);
    const target = crew[0] as CrewMember;
    // A round that does not kill takes health off and leaves them at work.
    expect(hurtCrew(state, target.id, CREW_HEALTH / 2, 0)).toBe(false);
    expect((crewOf(state, unit.id)[0] as CrewMember).health).toBeCloseTo(CREW_HEALTH / 2, 5);
    expect(hurtCrew(state, target.id, CREW_HEALTH, 0)).toBe(true);
    // The body lies where they fell, and their mate abandons the scene.
    expect(state.emergency.fallen).toHaveLength(1);
    expect((state.emergency.fallen[0] as { body: { x: number } }).body.x).toBeCloseTo(target.x, 5);
    const left = crewOf(state, unit.id);
    expect(left).toHaveLength(1);
    expect((left[0] as CrewMember).task).toBe('back');
    expect(unit.until).toBeLessThanOrEqual(state.tick);
    // Shooting at them is a crime, as shooting at anybody else in the street is.
    expect(state.heat).toBeGreaterThan(0);
  });

  it('kneels the medics of an ambulance at the body they came for', () => {
    const unit: EmergencyUnit = { ...engineAt(0, 20, 0), id: 5, kind: 'ambulance', x: 14, y: 0, until: WORK_TICKS.ambulance };
    const state = scene(unit);
    state.pedestrians.casualties = [
      {
        id: 1,
        since: -600,
        first: -600,
        cause: 'shot',
        health: 0,
        x: 20,
        y: 0,
        height: 0,
        rest: 0,
        heading: 0,
        dir: 0,
        push: 0,
        lift: 0,
        reach: 0,
        down: -1,
        side: 1,
        cash: 0,
        gone: false,
        bumped: -1,
        ragdoll: null,
      },
    ];
    run(state, unit, 240);
    const crew = crewOf(state, unit.id);
    expect(crew).toHaveLength(CREW_SIZE.ambulance);
    for (const member of crew) {
      expect(member.role).toBe('medic');
      expect(member.kneeling).toBe(true);
      // One each side of the body, within a stride of it.
      expect(Math.hypot(member.x - 20, member.y - 0)).toBeLessThan(1.6);
    }
    expect((crew[0] as CrewMember).y).toBeCloseTo(-((crew[1] as CrewMember).y), 3);
  });

  it('runs each hose from the coupling on the engine to the nozzle, over the road', () => {
    const unit = engineAt(0, 6, -12);
    const state = scene(unit);
    placeCrew(state, unit);
    const coupling = unitShape('engine').couplings.find((c) => c.z < 0);
    expect(coupling).toBeDefined();
    const laid = emptyHose();
    for (const member of crewOf(state, unit.id)) {
      const hose = hoseOf(state, unit, member, laid).points;
      // The engine faces +x, so its own z is the map's y.
      expect(hose[0]).toBeCloseTo(coupling?.x ?? 0, 5);
      expect(hose[1]).toBeCloseTo(unit.height + OUTLET_UP, 5);
      expect(hose[2]).toBeCloseTo(coupling?.z ?? 0, 5);
      const end = hose.length - 3;
      expect([hose[end], hose[end + 1], hose[end + 2]]).toEqual([laid.nozzleX, laid.nozzleHeight, laid.nozzleY]);
      // Between the two ends it lies on the road, on the side of the scene.
      for (let i = 3; i < end; i += 3) {
        expect((hose[i + 1] as number) - unit.height).toBeLessThan(0.1);
        expect(hose[i + 2]).toBeLessThan(-UNIT_BODY.engine.halfWidth);
      }
      expect(laid.spraying).toBe(true);
    }
  });
});
