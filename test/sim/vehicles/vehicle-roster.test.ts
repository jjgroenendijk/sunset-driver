import { beforeAll, describe, expect, it } from 'vitest';
import { compareStrings } from '../../../src/core/sort.ts';
import { EMPTY_INPUT, type InputFrame } from '../../../src/sim/input.ts';
import { initPhysics, SimPhysics, type Ground } from '../../../src/sim/physics/physics.ts';
import { createSimState, stepSim } from '../../../src/sim/simulation.ts';
import {
  gripOf,
  headingOf,
  isAircraft,
  rideHeight,
  ROAD_TYRES,
  ROSTER,
  specOf,
  SURFACE_GRIP,
  VEHICLE_CLASSES,
  wheelbaseOf,
  WET_GRIP,
  type VehicleClass,
} from '../../../src/sim/vehicles/vehicle.ts';
import type { Surface } from '../../../src/world/terrain/surface.ts';
import { DRY } from '../../support/helpers.ts';

/**
 * The handling roster of spec section 11.3: the table, and the differences it
 * is supposed to make on the road.
 *
 * The driving half runs every class on a flat ground written here rather than
 * on a generated world, for the reason `sim-sweep.test.ts` gives: a city would
 * measure the city. What it checks is that the classes are not the same vehicle
 * painted differently — each reaches its own pace, turns in its own circle, and
 * the two on knobbly tyres keep more of that circle on sand.
 */

/** The classes that drive or sail. The aircraft are `flight.test.ts`'s. */
const GROUND_CLASSES = VEHICLE_CLASSES.filter((cls) => !isAircraft(cls));

/** Ground of one surface, level everywhere, with the sea out of reach. */
function flat(surface: Surface): Ground {
  return { heightAt: () => 0, surfaceAt: () => surface, seaLevel: DRY };
}

/** Thirty metres of water, for the boat. */
const SEA: Ground = { heightAt: () => -30, surfaceAt: () => 'ground', seaLevel: 0 };

/** What a run of the roster comes back with. */
interface Run {
  /** Forward speed at the end, in metres per second. */
  speed: number;
  /** Metres of ground covered, so a vehicle driving a circle counts as driven. */
  path: number;
  /** Radians turned, unwrapped, so more than half a turn is not read as less. */
  turned: number;
  /** The least upright the vehicle was at any tick: 1 level, 0 on its side. */
  upright: number;
  y: number;
  afloat: boolean;
}

/** Ticks a vehicle is left alone on its springs before a run starts. */
const SETTLE = 60;

/**
 * Put a class down on a ground and hold one input for `ticks`. Eight seconds is
 * long enough for the pace of the roster to separate and short enough that
 * every class of it fits in the quick tier.
 */
function drive(cls: VehicleClass, ground: Ground, ticks: number, input: Partial<InputFrame>): Run {
  const state = createSimState(1);
  const physics = new SimPhysics(ground, state);
  physics.spawn(state, 0, 0, 0, cls);
  for (let i = 0; i < SETTLE; i++) stepSim(state, EMPTY_INPUT, physics);
  const frame = { ...EMPTY_INPUT, ...input };
  let path = 0;
  let turned = 0;
  let upright = 1;
  let x = state.player.x;
  let y = state.player.y;
  let heading = headingOf(state.vehicle);
  for (let i = 0; i < ticks; i++) {
    stepSim(state, frame, physics);
    path += Math.hypot(state.player.x - x, state.player.y - y);
    x = state.player.x;
    y = state.player.y;
    const now = headingOf(state.vehicle);
    let step = now - heading;
    while (step > Math.PI) step -= 2 * Math.PI;
    while (step < -Math.PI) step += 2 * Math.PI;
    turned += step;
    heading = now;
    const v = state.vehicle;
    // The vehicle's own up axis turned into the world: its `y` is 1 level.
    upright = Math.min(upright, 1 - 2 * (v.qx * v.qx + v.qz * v.qz));
  }
  const run: Run = {
    speed: state.vehicle.speed,
    path,
    turned,
    upright,
    y: state.vehicle.y,
    afloat: state.vehicle.afloat,
  };
  physics.dispose();
  return run;
}

describe('the vehicle roster', () => {
  it('has a row for every class, and every row knows which class it is', () => {
    expect(GROUND_CLASSES).toHaveLength(11);
    expect(VEHICLE_CLASSES).toHaveLength(20);
    for (const cls of VEHICLE_CLASSES) expect(specOf(cls).cls).toBe(cls);
    const names = VEHICLE_CLASSES.map((cls) => ROSTER[cls].name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every wheeled row a wheelbase and the boat a hull instead', () => {
    for (const cls of GROUND_CLASSES) {
      const spec = ROSTER[cls];
      if (spec.hull === undefined) {
        expect(spec.wheels.length, cls).toBeGreaterThanOrEqual(2);
        expect(wheelbaseOf(spec), cls).toBeGreaterThan(1);
        expect(spec.wheels.some((w) => w.steered), cls).toBe(true);
        expect(spec.wheels.some((w) => w.driven), cls).toBe(true);
        // A body that stands on its wheels, not on its floor.
        expect(rideHeight(spec), cls).toBeGreaterThan(spec.halfHeight);
      } else {
        expect(spec.wheels.length, cls).toBe(0);
        expect(wheelbaseOf(spec), cls).toBe(0);
        // A hull floats with its draft under the waterline.
        expect(rideHeight(spec), cls).toBeCloseTo(spec.halfHeight - spec.hull.draft, 6);
      }
      expect(spec.mass, cls).toBeGreaterThan(0);
      expect(spec.topSpeed, cls).toBeGreaterThan(0);
    }
  });

  it('puts an alarm on everything luxury, and asks a rider only of a two-wheeler', () => {
    for (const cls of GROUND_CLASSES) {
      const spec = ROSTER[cls];
      if (spec.luxury) expect(spec.alarm, cls).toBe(true);
      // Spec section 11.4: only these get the hotwire minigame, so most of the
      // roster must stay instant.
      expect(spec.balance === 0, cls).toBe(!spec.inline);
    }
    const alarmed = GROUND_CLASSES.filter((cls) => ROSTER[cls].alarm);
    expect(alarmed.length).toBeLessThan(GROUND_CLASSES.length / 2);
    expect(VEHICLE_CLASSES.filter((cls) => ROSTER[cls].inline)).toEqual(['motorcycle']);
  });

  it('spreads the classes across mass, power and pace', () => {
    const masses = GROUND_CLASSES.map((cls) => ROSTER[cls].mass);
    expect(Math.max(...masses) / Math.min(...masses)).toBeGreaterThan(20);
    expect(ROSTER.bus.mass).toBe(Math.max(...masses));
    expect(ROSTER.motorcycle.mass).toBe(Math.min(...masses));
    // No two rows claim the same top speed, so the picker's numbers differ too.
    const tops = GROUND_CLASSES.map((cls) => ROSTER[cls].hull?.topSpeed ?? ROSTER[cls].topSpeed);
    expect(new Set(tops).size).toBe(tops.length);
  });
});

describe('grip by surface and by tyre', () => {
  it('gives up grip from asphalt to dirt to open ground to sand', () => {
    const order: Surface[] = ['asphalt', 'dirt', 'ground', 'sand'];
    for (let i = 1; i < order.length; i++) {
      const worse = SURFACE_GRIP[order[i] as Surface];
      const better = SURFACE_GRIP[order[i - 1] as Surface];
      expect(worse.friction, `${order[i]} against ${order[i - 1]}`).toBeLessThan(better.friction);
      expect(worse.side, `${order[i]} against ${order[i - 1]}`).toBeLessThan(better.side);
      expect(worse.roll, `${order[i]} against ${order[i - 1]}`).toBeGreaterThan(better.roll);
    }
  });

  it('lets knobbly tyres take back on loose ground what they give away on tarmac', () => {
    const knobbly = ROSTER.buggy.tyres;
    expect(knobbly.loose).toBeGreaterThan(1);
    expect(gripOf('asphalt', 0, knobbly).friction).toBeLessThan(gripOf('asphalt', 0, ROAD_TYRES).friction);
    for (const surface of ['dirt', 'ground', 'sand'] as Surface[]) {
      const better = gripOf(surface, 0, knobbly);
      const road = gripOf(surface, 0, ROAD_TYRES);
      expect(better.friction, surface).toBeGreaterThan(road.friction);
      expect(better.side, surface).toBeGreaterThan(road.side);
      // A tyre compound is not what the ground drags out of a turning wheel.
      expect(better.roll, surface).toBe(road.roll);
    }
  });

  it('takes grip away in the wet and leaves the rolling resistance alone', () => {
    const dry = gripOf('asphalt', 0);
    const wet = gripOf('asphalt', 1);
    expect(wet.friction).toBeCloseTo(dry.friction * WET_GRIP, 6);
    expect(wet.roll).toBe(dry.roll);
    expect(gripOf('asphalt', 0.5).friction).toBeGreaterThan(wet.friction);
  });
});

describe('driving the roster', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('drives every class of the roster, and each at its own pace', () => {
    // Eight seconds of full throttle from a standstill. The order is the whole
    // point of the table: a bus is not a sports car with a different shape.
    const order: VehicleClass[] = [
      'bus',
      'truck',
      'van',
      'offroad',
      'compact',
      'buggy',
      'saloon',
      'motorcycle',
      'emergency',
      'sports',
    ];
    expect([...order].sort(compareStrings)).toEqual(GROUND_CLASSES.filter((cls) => cls !== 'boat').slice().sort(compareStrings));
    let slower = 0;
    let complaint = '';
    for (const cls of order) {
      const run = drive(cls, flat('asphalt'), 480, { throttle: 1 });
      if (run.path < 50 && complaint === '') complaint = `${cls} covered only ${run.path.toFixed(1)} m`;
      if (run.upright < 0.9 && complaint === '') complaint = `${cls} fell to ${run.upright.toFixed(2)} upright`;
      if (run.speed < slower + 1 && complaint === '') {
        complaint = `${cls} made ${run.speed.toFixed(2)} m/s, not clear of the ${slower.toFixed(2)} before it`;
      }
      slower = run.speed;
    }
    expect(complaint).toBe('');
  });

  it('turns in a tighter circle the smaller the vehicle', () => {
    // The same four seconds of lock in each: what differs is the wheelbase, the
    // steering lock and the weight leaning on the outside tyres.
    const order: VehicleClass[] = ['bus', 'truck', 'van', 'offroad', 'saloon', 'sports', 'motorcycle'];
    let tighter = 0;
    let complaint = '';
    for (const cls of order) {
      const run = drive(cls, flat('asphalt'), 240, { throttle: 0.5, steer: 1 });
      if (run.turned < tighter + 0.15 && complaint === '') {
        complaint = `${cls} turned ${run.turned.toFixed(2)} rad, not clear of the ${tighter.toFixed(2)} before it`;
      }
      tighter = run.turned;
    }
    expect(complaint).toBe('');
  });

  it('backs up at a useful pace, and slower than it drives forward', () => {
    // Two seconds of full reverse: enough to back out of a three-point turn
    // without crawling, and still well short of what first gear gives.
    const back = drive('saloon', flat('asphalt'), 120, { throttle: -1 });
    const ahead = drive('saloon', flat('asphalt'), 120, { throttle: 1 });
    expect(back.speed).toBeLessThan(-5);
    expect(-back.speed).toBeLessThan(ahead.speed);
  });

  it('keeps more of its cornering on sand on knobbly tyres', () => {
    // Each class against itself, so what is compared is the tyres and not the
    // weight: how much of its tarmac circle it still turns on sand.
    const kept = (cls: VehicleClass): number =>
      drive(cls, flat('sand'), 240, { throttle: 0.5, steer: 1 }).turned /
      drive(cls, flat('asphalt'), 240, { throttle: 0.5, steer: 1 }).turned;
    expect(kept('buggy')).toBeGreaterThan(kept('saloon'));
    expect(kept('offroad')).toBeGreaterThan(kept('van'));
  });

  it('floats a boat at the waterline, drives it and turns it', () => {
    const spec = ROSTER.boat;
    const ahead = drive('boat', SEA, 480, { throttle: 1 });
    expect(ahead.afloat).toBe(true);
    // It rides where its draft says it rides, and it is not bobbing about.
    expect(ahead.y).toBeCloseTo(SEA.seaLevel + rideHeight(spec), 2);
    expect(ahead.upright).toBeGreaterThan(0.99);
    expect(ahead.path).toBeGreaterThan(50);
    expect(ahead.speed).toBeGreaterThan(8);

    const astern = drive('boat', SEA, 240, { throttle: -1 });
    expect(astern.speed).toBeLessThan(0);

    // The rudder bites with the water flowing past it, so a boat under way
    // turns and a boat at a standstill cannot turn on the spot.
    expect(Math.abs(drive('boat', SEA, 300, { throttle: 1, steer: 1 }).turned)).toBeGreaterThan(1);
    expect(Math.abs(drive('boat', SEA, 240, { steer: 1 }).turned)).toBeLessThan(0.05);
  });

  it('leaves a boat on dry land where it was put', () => {
    const aground = drive('boat', flat('ground'), 240, { throttle: 1 });
    expect(aground.afloat).toBe(false);
    expect(aground.path).toBeLessThan(1);
  });

  it('carries the class through the record, so a save says what is being driven', () => {
    const state = createSimState(1);
    const physics = new SimPhysics(flat('asphalt'), state);
    physics.spawn(state, 0, 0, 0, 'truck');
    expect(state.vehicle.cls).toBe('truck');
    expect(state.vehicle.wheels).toHaveLength(ROSTER.truck.wheels.length);

    // The record is what the body is rebuilt from, so a world made again from
    // it stands the same vehicle in the same place.
    const revived = JSON.parse(JSON.stringify(state)) as typeof state;
    const again = new SimPhysics(flat('asphalt'), revived);
    again.step(revived, EMPTY_INPUT);
    physics.step(state, EMPTY_INPUT);
    expect(revived.vehicle.cls).toBe('truck');
    expect(Math.hypot(state.vehicle.x - revived.vehicle.x, state.vehicle.y - revived.vehicle.y)).toBeLessThan(0.01);
    again.dispose();
    physics.dispose();
  });
});
