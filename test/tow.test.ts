import { describe, expect, it } from 'vitest';
import { TRAFFIC_VIEW } from '../src/render/traffic.ts';
import { createDamageState, type DamageStage } from '../src/sim/damage.ts';
import { createSimState, stepSim, type SimState } from '../src/sim/simulation.ts';
import { addPromoted, type PromotedVehicle } from '../src/sim/traffic.ts';
import { stepTowing, TOW_REACH, TOW_WAIT } from '../src/sim/tow.ts';
import { createVehicleState, specOf } from '../src/sim/vehicle.ts';

/** A promoted vehicle standing at a place, in whatever state the fire left it. */
function wreck(id: number, x: number, y: number, stage: DamageStage, blownTick: number): PromotedVehicle {
  const vehicle = createVehicleState(specOf('saloon'), x, y, 0, 0);
  vehicle.damage = { ...createDamageState(), stage, blownTick, integrity: stage === 'burnt' ? 0 : 0.4 };
  return { id, paint: 0x3f7d63, vehicle };
}

/** A session standing at the origin on foot, with the given records in it. */
function session(tick: number, ...records: PromotedVehicle[]): SimState {
  const state = createSimState(1);
  state.tick = tick;
  state.player.driving = false;
  state.player.x = 0;
  state.player.y = 0;
  for (const record of records) addPromoted(state.traffic, record);
  return state;
}

const FAR = TOW_REACH + 10;
const OLD = TOW_WAIT + 1;

describe('the wrecks the city tows away (spec section 20.2)', () => {
  it('never takes one the player could see it go', () => {
    // A wreck that vanished on screen would read as a bug, not as a tow truck.
    expect(TOW_REACH).toBeGreaterThan(TRAFFIC_VIEW);
    expect(TOW_WAIT).toBeGreaterThan(0);
  });

  it('takes a shell that has stood long enough with the player far away', () => {
    const state = session(OLD, wreck(4, FAR, 0, 'burnt', 0));
    expect(stepTowing(state)).toBe(1);
    expect(state.traffic.promoted).toEqual([]);
  });

  it('leaves a shell the player is standing near, however long it has been there', () => {
    const state = session(OLD * 10, wreck(4, TOW_REACH - 1, 0, 'burnt', 0));
    expect(stepTowing(state)).toBe(0);
    expect(state.traffic.promoted).toHaveLength(1);
  });

  it('leaves a shell that went up a moment ago, however far away it is', () => {
    const state = session(TOW_WAIT - 1, wreck(4, FAR, 0, 'burnt', 0));
    expect(stepTowing(state)).toBe(0);
    expect(state.traffic.promoted).toHaveLength(1);
  });

  it('leaves a car the player abandoned in one piece where they left it', () => {
    // Spec section 20.2: an abandoned car is still there when you return. Only
    // a wreck goes with the truck.
    for (const stage of ['intact', 'dented', 'smoking', 'burning'] as DamageStage[]) {
      const state = session(OLD * 10, wreck(4, FAR, 0, stage, -1));
      expect(stepTowing(state), stage).toBe(0);
      expect(state.traffic.promoted.length, stage).toBe(1);
    }
  });

  it('measures from the car when the player is driving, not from where they got out', () => {
    const state = session(OLD, wreck(4, FAR, 0, 'burnt', 0));
    state.player.driving = true;
    state.vehicle.x = FAR;
    state.vehicle.z = 0;
    expect(stepTowing(state)).toBe(0);
    state.vehicle.x = 0;
    expect(stepTowing(state)).toBe(1);
  });

  it('takes several in one tick and leaves the rest in id order', () => {
    const state = session(
      OLD,
      wreck(2, FAR, 0, 'burnt', 0),
      wreck(5, 0, 0, 'burnt', 0),
      wreck(7, 0, FAR, 'burnt', 0),
      wreck(9, FAR, FAR, 'intact', -1),
    );
    expect(stepTowing(state)).toBe(2);
    expect(state.traffic.promoted.map((record) => record.id)).toEqual([5, 9]);
  });

  it('clears a wreck out of a running session, and is the only thing that ever does', () => {
    // The tick is stepped after the towing, so the run below clears the wreck
    // on the tick its wait is up and not one before it.
    const state = session(TOW_WAIT - 3, wreck(4, FAR, 0, 'burnt', 0), wreck(6, FAR, FAR, 'dented', -1));
    for (let i = 0; i < 3; i++) stepSim(state);
    expect(state.traffic.promoted.map((record) => record.id), 'taken before its time').toEqual([4, 6]);
    stepSim(state);
    expect(state.traffic.promoted.map((record) => record.id)).toEqual([6]);
  });
});
