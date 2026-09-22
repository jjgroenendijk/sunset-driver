import { beforeAll, describe, expect, it } from 'vitest';
import { groundUnder } from '../src/render/boarder.ts';
import { boardingFrame, DOOR_OPEN, type BoardingInput } from '../src/render/boarding.ts';
import { CharacterModel } from '../src/render/character.ts';
import { doorOf, seatOf } from '../src/render/vehicle-mesh.ts';
import {
  BOARD_TICKS,
  boardingProgress,
  boardingTicks,
  createBoarding,
  doorAlong,
  MOUNT_TICKS,
  sideOf,
  startBoarding,
  walkShare,
  type BoardingState,
} from '../src/sim/boarding.ts';
import { resolveAppearance } from '../src/sim/character.ts';
import { exitPlace } from '../src/sim/on-foot.ts';
import { initPhysics } from '../src/sim/physics.ts';
import { cloneSimState } from '../src/sim/simulation.ts';
import { createPlayerState } from '../src/sim/on-foot.ts';
import { createVehicleState, ROSTER, specOf, VEHICLE_CLASSES, type VehicleClass } from '../src/sim/vehicle.ts';
import { drive, finishBoarding, hills, start } from './sim-harness.ts';

/**
 * Getting into a vehicle and out of it: the record of `src/sim/boarding.ts`
 * that holds the player while the door is worked, and the body
 * `src/render/boarding.ts` draws doing it.
 */
const model = new CharacterModel({ body: 1, skin: 0, hair: 0, hairColour: 0, outfit: 0 });

/** The record of a move into or out of a vehicle of `cls` standing at the origin, facing +x. */
function recordOf(cls: VehicleClass, way: 'in' | 'out', side = -1): BoardingState {
  const spec = specOf(cls);
  if (way === 'out') return createBoarding('out', 0, -1);
  const player = { ...createPlayerState(), x: -1, y: side * (spec.halfWidth + 1.4) };
  return startBoarding(player, createVehicleState(spec, 0, 0, 0, 0), spec, 0);
}

function input(cls: VehicleClass, way: 'in' | 'out', progress: number, side = -1): BoardingInput {
  const spec = specOf(cls);
  return {
    way,
    side,
    progress,
    walk: walkShare(recordOf(cls, way, side), spec),
    spec,
    hipsAt: model.hipsAt,
    stature: model.height,
    rig: model.reach,
    fromX: -1,
    fromY: groundUnder(createVehicleState(spec), spec),
    fromZ: side * (spec.halfWidth + 1.4),
    fromYaw: 0.4,
    ground: groundUnder(createVehicleState(spec), spec),
  };
}

describe('the body getting in and out', () => {
  it('starts a move in where the player stood, facing the way they faced', () => {
    for (const cls of VEHICLE_CLASSES) {
      const frame = boardingFrame(input(cls, 'in', 0));
      expect(frame.x).toBeCloseTo(-1, 6);
      expect(frame.z).toBeCloseTo(-(specOf(cls).halfWidth + 1.4), 6);
      expect(frame.door).toBe(0);
      expect(frame.yaw).toBeCloseTo(0.4, 6);
    }
  });

  it('ends a move out where the record stands the player, facing forward, with the door shut', () => {
    for (const cls of VEHICLE_CLASSES) {
      const frame = boardingFrame(input(cls, 'out', 1));
      const place = exitPlace(createVehicleState(specOf(cls), 0, 0, 0, 0), specOf(cls));
      expect(frame.x).toBeCloseTo(place.x, 6);
      expect(frame.z).toBeCloseTo(place.y, 6);
      expect(frame.y).toBeCloseTo(groundUnder(createVehicleState(specOf(cls)), specOf(cls)), 6);
      expect(frame.yaw).toBeCloseTo(0, 6);
      expect(frame.door).toBe(0);
    }
  });

  it('opens the door part way through and shuts it again', () => {
    const open = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((u) => boardingFrame(input('saloon', 'in', u)).door);
    expect(open[0]).toBe(0);
    expect(Math.max(...open)).toBeCloseTo(DOOR_OPEN, 6);
    expect(open[10]).toBeCloseTo(0, 6);
  });

  it('opens no door on a vehicle with none that swings', () => {
    for (const cls of ['bus', 'truck', 'van', 'boat', 'motorcycle', 'buggy'] as const) {
      expect(doorOf(ROSTER[cls], -1)).toBeUndefined();
      for (let u = 0; u <= 1; u += 0.05) expect(boardingFrame(input(cls, 'in', u)).door).toBe(0);
    }
  });

  it('sits the driver low enough that the head stays under the roof', () => {
    for (const cls of ['compact', 'saloon', 'sports', 'emergency', 'offroad'] as const) {
      const spec = specOf(cls);
      const frame = boardingFrame(input(cls, 'in', 1));
      expect(frame.x).toBeCloseTo(seatOf(spec).x, 6);
      expect(frame.y + model.height * 0.98).toBeLessThan(spec.halfHeight + 0.3);
      expect(frame.y + model.hipsAt).toBeLessThanOrEqual(spec.halfHeight - 0.05 - (model.height - model.hipsAt) * Math.cos(0.3) + 1e-9);
    }
  });

  it('moves no faster than a run from one tick to the next', () => {
    for (const cls of VEHICLE_CLASSES) {
      for (const way of ['in', 'out'] as const) {
        const ticks = boardingTicks(specOf(cls), recordOf(cls, way));
        let last = boardingFrame(input(cls, way, 0));
        for (let tick = 1; tick <= ticks; tick++) {
          const next = boardingFrame(input(cls, way, tick / ticks));
          // 0.1 m a tick is 6 m/s, a sprint.
          expect(Math.hypot(next.x - last.x, next.y - last.y, next.z - last.z)).toBeLessThan(0.1);
          last = next;
        }
      }
    }
  });

  it('walks the length of a bus to its door, and stands at the door to get out', () => {
    const spec = specOf('bus');
    const player = { ...createPlayerState(), x: -spec.halfLength, y: -(spec.halfWidth + 1) };
    const long = startBoarding(player, createVehicleState(spec, 0, 0, 0, 0), spec, 0);
    expect(long.walk).toBeGreaterThan(2 * 60);
    expect(exitPlace(createVehicleState(spec, 0, 0, 0, 0), spec).x).toBeCloseTo(doorAlong(spec), 6);
  });
});

describe('the record of a move', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('takes longer through a car door than onto a bike', () => {
    const board = createBoarding('in', 100, -1);
    expect(boardingProgress(board, ROSTER.saloon, 100 + BOARD_TICKS.in / 2)).toBeCloseTo(0.5, 6);
    expect(MOUNT_TICKS.in).toBeLessThan(BOARD_TICKS.in);
    expect(boardingProgress(board, ROSTER.motorcycle, 100 + MOUNT_TICKS.in)).toBe(1);
  });

  it('knows which side of the car the player stands on', () => {
    const v = createVehicleState(ROSTER.saloon, 0, 0, 0, 0);
    const p = createPlayerState();
    p.y = -2;
    expect(sideOf(p, v)).toBe(-1);
    p.y = 2;
    expect(sideOf(p, v)).toBe(1);
  });

  it('holds a driver in the seat on the brakes until the door is shut behind them', () => {
    const session = start(hills());
    drive(session, 1, { interact: true });
    const { state } = session;
    expect(state.boarding?.way).toBe('out');
    const at = { x: state.vehicle.x, z: state.vehicle.z };
    drive(session, BOARD_TICKS.out - 2, { throttle: 1 });
    expect(state.player.driving).toBe(true);
    expect(Math.hypot(state.vehicle.x - at.x, state.vehicle.z - at.z)).toBeLessThan(0.2);
    finishBoarding(session);
    expect(state.player.driving).toBe(false);
    session.physics.dispose();
  });

  it('holds a player on foot at the door, and hands them the wheel once it is shut', () => {
    const session = start(hills());
    drive(session, 1, { interact: true });
    finishBoarding(session);
    const { state } = session;
    drive(session, 1, { interact: true });
    expect(state.boarding?.way).toBe('in');
    const at = { x: state.player.x, y: state.player.y };
    drive(session, boardingTicks(specOf(state.vehicle.cls), state.boarding as BoardingState) - 2, { throttle: 1, sprint: true });
    expect(state.player.driving).toBe(false);
    expect(Math.hypot(state.player.x - at.x, state.player.y - at.y)).toBeLessThan(0.05);
    finishBoarding(session);
    expect(state.player.driving).toBe(true);
    session.physics.dispose();
  });

  it('carries a move half done through a save', () => {
    const session = start(hills());
    drive(session, 1, { interact: true });
    drive(session, 20);
    const saved = cloneSimState(session.state);
    expect(saved.boarding).toEqual(session.state.boarding);
    expect(resolveAppearance(saved.character).body.height).toBeGreaterThan(0);
    session.physics.dispose();
  });
});
