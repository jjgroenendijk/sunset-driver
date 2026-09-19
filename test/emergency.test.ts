import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../src/sim/clock.ts';
import { createDamageState, FUSE_TICKS, ignite, SPREAD_RADIUS } from '../src/sim/damage.ts';
import {
  CALL_RANGE,
  CALL_SEVERITY,
  callAmbulance,
  EmergencyServices,
  clearAhead,
  HOSE_RANGE,
  onCall,
  stoppingSpeed,
  UNIT_BODY,
  UNITS_OUT,
  WORK_TICKS,
  type EmergencyUnit,
} from '../src/sim/emergency.ts';
import { douseFires, firesOf, light, stepFires } from '../src/sim/fire.ts';
import type { DistrictAt } from '../src/sim/police.ts';
import { cloneSimState, createSimState, type SimState } from '../src/sim/simulation.ts';
import { createVehicleState, specOf } from '../src/sim/vehicle.ts';
import { stableJson } from './helpers.ts';
import { gridTrafficRoads } from './traffic-grid.ts';

/**
 * The fires of spec section 11.3 and the emergency services of 20.3, run
 * headless: the rules are pure and the units drive a road graph, so an engine
 * is sent and driven here without Rapier and without a renderer. The grid of
 * `traffic-grid.ts` is the city.
 */
const roads = gridTrafficRoads();

/** A district that answers at once, so a test is not spent waiting for an engine. */
const downtown: DistrictAt = () => ({ zone: 'core', wealth: 1 });

/** A session standing in the middle of the grid, on foot, with nothing yet burning. */
function session(seed = 7): { state: SimState; service: EmergencyServices } {
  const state = createSimState(seed);
  state.player.driving = false;
  state.player.x = 0;
  state.player.y = 0;
  return { state, service: new EmergencyServices(roads, downtown) };
}

/** Put a car of the traffic on the record where the physics would have left it. */
function promote(state: SimState, id: number, x: number, y: number): SimState['traffic']['promoted'][number] {
  const vehicle = createVehicleState(specOf('saloon'));
  vehicle.x = x;
  vehicle.z = y;
  const promoted = { id, paint: 0, vehicle };
  state.traffic.promoted.push(promoted);
  return promoted;
}

/** Step a session the way `stepSim` does around the physics: the fires, then the service. */
function run(state: SimState, service: EmergencyServices, ticks: number, crash = 0): void {
  for (let i = 0; i < ticks; i++) {
    stepFires(state);
    service.step(state, i === 0 ? crash : 0);
    state.tick += 1;
  }
}

/** The units out, of one kind. */
function outOf(state: SimState, kind: EmergencyUnit['kind']): EmergencyUnit[] {
  return state.emergency.units.filter((unit: EmergencyUnit) => unit.kind === kind);
}

describe('fires (spec section 11.3)', () => {
  it('leaves a blaze where a wreck goes up, and the blaze burns itself out', () => {
    const { state } = session();
    const car = promote(state, 0, 40, 0);
    ignite(car.vehicle.damage, state.tick);
    // The fuse runs out and the car goes up, leaving the ground alight.
    for (let i = 0; i <= FUSE_TICKS; i++) {
      stepFires(state);
      state.tick += 1;
    }
    expect(car.vehicle.damage.stage).toBe('burnt');
    expect(state.fires.blazes).toHaveLength(1);
    const blaze = state.fires.blazes[0];
    expect(blaze?.x).toBe(40);
    // A blaze outlasts the car that started it by a long way.
    expect((blaze?.out ?? 0) - state.tick).toBeGreaterThan(FUSE_TICKS);
    state.tick = (blaze?.out ?? 0) + 1;
    stepFires(state);
    expect(state.fires.blazes).toHaveLength(0);
  });

  it('spreads from a blaze to the car standing next to it', () => {
    const { state } = session(3);
    light(state, 0, 0);
    const near = promote(state, 0, SPREAD_RADIUS - 1, 0);
    const far = promote(state, 1, SPREAD_RADIUS + 40, 0);
    for (let i = 0; i < 60 * TICK_RATE && near.vehicle.damage.stage !== 'burning'; i++) {
      stepFires(state);
      state.tick += 1;
    }
    expect(near.vehicle.damage.stage).toBe('burning');
    expect(far.vehicle.damage.stage).toBe('intact');
  });

  it('puts out the vehicles and the blazes a hose reaches, and leaves the rest', () => {
    const { state } = session();
    const near = promote(state, 0, 5, 0);
    const far = promote(state, 1, HOSE_RANGE + 20, 0);
    ignite(near.vehicle.damage, state.tick);
    ignite(far.vehicle.damage, state.tick);
    light(state, 3, 0);
    light(state, HOSE_RANGE + 30, 0);
    expect(douseFires(state, 0, 0, HOSE_RANGE)).toBe(2);
    expect(near.vehicle.damage.stage).toBe('smoking');
    expect(far.vehicle.damage.stage).toBe('burning');
    expect(state.fires.blazes).toHaveLength(1);
    // A doused car is a wreck, not a new car: what the fire cost it stays.
    expect(near.vehicle.damage.litTick).toBe(-1);
  });
});

describe('the emergency services (spec section 20.3)', () => {
  it('sends an engine to a burning car and puts the fire out', () => {
    const { state, service } = session();
    const car = promote(state, 0, 60, 0);
    ignite(car.vehicle.damage, state.tick);
    run(state, service, 2);
    // The fire is called in on the tick it is seen.
    expect(state.emergency.calls).toHaveLength(1);
    expect(state.emergency.calls[0]?.kind).toBe('engine');
    // The engine comes out and drives the road graph at the scene.
    run(state, service, 10 * TICK_RATE);
    const engine = outOf(state, 'engine')[0];
    expect(engine).toBeDefined();
    const opening = Math.hypot((engine?.x ?? 0) - 60, engine?.y ?? 0);
    run(state, service, 60 * TICK_RATE);
    const closed = outOf(state, 'engine')[0];
    expect(Math.hypot((closed?.x ?? 0) - 60, closed?.y ?? 0)).toBeLessThan(opening);
    // It reaches the scene, hoses it, and nothing is left burning.
    run(state, service, 120 * TICK_RATE);
    expect(firesOf(state)).toHaveLength(0);
    expect(state.fires.blazes).toHaveLength(0);
  });

  it('folds a second fire in the same street into the call already open', () => {
    const { state, service } = session();
    const first = promote(state, 0, 30, 0);
    const second = promote(state, 1, 30 + CALL_RANGE - 5, 0);
    const across = promote(state, 2, 30 + 4 * CALL_RANGE, 0);
    ignite(first.vehicle.damage, state.tick);
    ignite(second.vehicle.damage, state.tick);
    ignite(across.vehicle.damage, state.tick);
    run(state, service, 2);
    expect(state.emergency.calls).toHaveLength(2);
  });

  it('calls an ambulance to a crash worth watching, and to nothing less', () => {
    const quiet = session();
    run(quiet.state, quiet.service, 2, CALL_SEVERITY / 2);
    expect(quiet.state.emergency.calls).toHaveLength(0);
    const loud = session();
    run(loud.state, loud.service, 2, CALL_SEVERITY);
    expect(loud.state.emergency.calls).toHaveLength(1);
    expect(loud.state.emergency.calls[0]?.kind).toBe('ambulance');
    run(loud.state, loud.service, 30 * TICK_RATE);
    expect(outOf(loud.state, 'ambulance')).toHaveLength(1);
  });

  it('never has more than the service out at once', () => {
    const { state, service } = session();
    for (let i = 0; i < 12; i++) callAmbulance(state, i * 4 * CALL_RANGE, 0);
    run(state, service, 200 * TICK_RATE);
    expect(state.emergency.units.length).toBeLessThanOrEqual(UNITS_OUT);
  });

  it('gives up a fire that is out before anybody reached it', () => {
    const { state, service } = session();
    const car = promote(state, 0, 20, 0);
    ignite(car.vehicle.damage, state.tick);
    run(state, service, 2);
    expect(state.emergency.calls).toHaveLength(1);
    // The hose of nobody at all: the fire is put out where it stands.
    douseFires(state, 20, 0, HOSE_RANGE);
    run(state, service, 2);
    expect(state.emergency.calls).toHaveLength(0);
  });

  it('takes a unit off the map once it is done and far enough away', () => {
    const { state, service } = session();
    callAmbulance(state, 200, 0);
    run(state, service, 30 * TICK_RATE);
    expect(state.emergency.units).toHaveLength(1);
    // Work the scene, drive back out, and go.
    run(state, service, WORK_TICKS.ambulance + 120 * TICK_RATE);
    expect(state.emergency.units).toHaveLength(0);
    expect(state.emergency.calls).toHaveLength(0);
  });

  it('answers a replayed session with the same units on the same ticks', () => {
    const first = session(11);
    const second = session(11);
    for (const run_ of [first, second]) {
      const car = promote(run_.state, 0, 45, 60);
      ignite(car.vehicle.damage, run_.state.tick);
    }
    run(first.state, first.service, 90 * TICK_RATE);
    run(second.state, second.service, 90 * TICK_RATE);
    expect(stableJson(second.state.emergency)).toBe(stableJson(first.state.emergency));
    expect(stableJson(second.state.fires)).toBe(stableJson(first.state.fires));
    // A session stepped from a copy of the record answers the same way, which
    // is what a save being loaded does.
    const loaded = cloneSimState(first.state);
    const carried = new EmergencyServices(roads, downtown);
    run(loaded, carried, 20 * TICK_RATE);
    run(first.state, first.service, 20 * TICK_RATE);
    expect(stableJson(loaded.emergency)).toBe(stableJson(first.state.emergency));
  });

  it('answers a fire nobody is standing near, because a call is not about the player', () => {
    const { state, service } = session();
    const car = promote(state, 0, 180, 180);
    ignite(car.vehicle.damage, state.tick);
    // The player walks the other way and never sees any of it.
    state.player.x = -200;
    state.player.y = -200;
    run(state, service, 40 * TICK_RATE);
    expect(outOf(state, 'engine')).toHaveLength(1);
  });
});

describe('a unit on the road (spec section 20.3)', () => {
  /** A unit of a kind standing at the origin and facing along +x. */
  function standing(kind: EmergencyUnit['kind']): EmergencyUnit {
    return {
      id: 0, kind, task: 'respond', call: 0, x: 0, y: 0, heading: 0, height: 0, speed: 0, edges: [],
      distance: 0, stop: 0, planned: 0, goalX: 0, goalY: 0, homeX: 0, homeY: 0, until: -1,
    };
  }

  /** Set a car alight away from the player and step until an engine is out to it. */
  function sendEngine(state: SimState, service: EmergencyServices): EmergencyUnit | undefined {
    const car = promote(state, 0, 45, 60);
    ignite(car.vehicle.damage, state.tick);
    for (let i = 0; i < 20 * TICK_RATE && outOf(state, 'engine').length === 0; i++) run(state, service, 1);
    return outOf(state, 'engine')[0];
  }

  it('sees the player in its lane ahead, and not beside it or behind it', () => {
    const { state } = session();
    const unit = standing('engine');
    state.player.x = 20;
    state.player.y = 0.5;
    const clear = clearAhead(state, unit);
    expect(clear).toBeGreaterThan(0);
    expect(clear).toBeLessThan(20 - UNIT_BODY.engine.halfLength);
    // In the next lane over, or behind, the player is not in its way.
    state.player.y = 6;
    expect(clearAhead(state, unit)).toBe(clearAhead(state, { ...unit, heading: Math.PI }));
    state.player.x = -20;
    state.player.y = 0;
    expect(clearAhead(state, unit)).toBeGreaterThan(30);
  });

  it('stops short of a player standing in its way, and drives on once they step aside', () => {
    const { state, service } = session();
    const unit = sendEngine(state, service);
    expect(unit).toBeDefined();
    if (unit === undefined) return;
    // Let it get going, then stand in front of it.
    run(state, service, 3 * TICK_RATE);
    const ahead = 14;
    state.player.x = unit.x + Math.cos(unit.heading) * ahead;
    state.player.y = unit.y + Math.sin(unit.heading) * ahead;
    const was = { x: state.player.x, y: state.player.y };
    for (let i = 0; i < 4 * TICK_RATE; i++) {
      // Keep the player on the unit's line, so a turn in the road does not let it past.
      state.player.x = was.x;
      state.player.y = was.y;
      run(state, service, 1);
      expect(Math.hypot(unit.x - was.x, unit.y - was.y)).toBeGreaterThan(UNIT_BODY.engine.halfLength);
    }
    state.player.x = -300;
    state.player.y = -300;
    const held = { x: unit.x, y: unit.y };
    run(state, service, 3 * TICK_RATE);
    expect(Math.hypot(unit.x - held.x, unit.y - held.y)).toBeGreaterThan(5);
  });

  it('pulls away rather than jumping to speed, and brakes within the road it has', () => {
    const { state, service } = session();
    const unit = sendEngine(state, service);
    let last = 0;
    for (let i = 0; i < TICK_RATE; i++) {
      run(state, service, 1);
      expect((unit?.speed ?? 0) - last).toBeLessThan(0.1);
      last = unit?.speed ?? 0;
    }
    expect(stoppingSpeed(0)).toBe(0);
    expect(stoppingSpeed(10)).toBe(10);
  });

  it('has its lights and siren on to a call and at it, and off on the way home', () => {
    const unit = standing('ambulance');
    expect(onCall(unit)).toBe(true);
    expect(onCall({ ...unit, task: 'work' })).toBe(true);
    expect(onCall({ ...unit, task: 'leave' })).toBe(false);
  });
});

describe('a fresh damage state', () => {
  it('starts with nothing burning, so a new session calls nobody', () => {
    const damage = createDamageState();
    expect(damage.stage).toBe('intact');
    const { state, service } = session();
    run(state, service, 5 * TICK_RATE);
    expect(state.emergency.calls).toHaveLength(0);
    expect(state.emergency.units).toHaveLength(0);
  });
});
