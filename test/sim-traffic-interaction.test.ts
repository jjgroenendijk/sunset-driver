import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_INPUT, type InputFrame } from '../src/sim/input.ts';
import { initPhysics, SimPhysics } from '../src/sim/physics.ts';
import { createSimState, stepSim, type SimState } from '../src/sim/simulation.ts';
import { HOTWIRE_CAP } from '../src/sim/theft.ts';
import { addPromoted, AmbientTraffic, promotedOf, type AmbientPose } from '../src/sim/traffic.ts';
import { createVehicleState, rideHeight, specOf, type VehicleClass } from '../src/sim/vehicle.ts';
import { giveWeapon, roundSeverity, weaponOf, type WeaponId } from '../src/sim/weapon.ts';
import { DRY } from './helpers.ts';
import { gridTrafficRoads } from './traffic-grid.ts';

/**
 * The two ways of interacting with the traffic that spec section 5.3 names
 * beyond touching it: shooting at it, and stealing it. Both run on the made-up
 * grid of `traffic-grid.ts`, with the player on foot and their own car left far
 * off the grid, so nothing but the traffic can be hit or taken. The grid is laid
 * flat: a muzzle is 1.2 m up, and on the rolling ground a car in a dip 7 m away
 * is under a level shot.
 */
describe('shots and theft reach the traffic', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  const SEED = 7;

  const flat = (_x: number, _y: number): number => 0;
  const gridTraffic = (seed: number): AmbientTraffic => new AmbientTraffic(seed, { ...gridTrafficRoads(), heightAt: flat });
  const gridHeight = flat;

  /** A session with the player on foot at a place, their own car far away. */
  function onFoot(traffic: AmbientTraffic, x: number, y: number): { state: SimState; physics: SimPhysics } {
    const state = createSimState(SEED, undefined, 0);
    const physics = new SimPhysics({ heightAt: flat, surfaceAt: () => 'asphalt', seaLevel: DRY, traffic }, state);
    state.vehicle.x = 5000;
    state.vehicle.z = 5000;
    state.player.driving = false;
    state.player.x = x;
    state.player.y = y;
    state.player.height = gridHeight(x, y);
    physics.adopt(state);
    return { state, physics };
  }

  function step(state: SimState, physics: SimPhysics, input: Partial<InputFrame> = {}, ticks = 1): void {
    const frame = { ...EMPTY_INPUT, ...input };
    for (let i = 0; i < ticks; i++) stepSim(state, frame, physics);
  }

  /**
   * Stand the player 7 m to the side of the first vehicle of the traffic that
   * comes into their box, with a weapon, and answer that vehicle's id.
   */
  function besideTraffic(traffic: AmbientTraffic, weapon: WeaponId): { state: SimState; physics: SimPhysics; id: number } {
    const session = onFoot(traffic, 0, 30);
    const { state, physics } = session;
    step(state, physics);
    const cursor = physics.traffic?.cursors[0];
    if (cursor === undefined) throw new Error('no traffic near the player');
    const pose = traffic.poseAt(cursor.id, state.tick, {} as AmbientPose);
    // To the right of the vehicle, out of its lane.
    state.player.x = pose.x + Math.cos(pose.heading + Math.PI / 2) * 7;
    state.player.y = pose.y + Math.sin(pose.heading + Math.PI / 2) * 7;
    state.player.height = gridHeight(state.player.x, state.player.y);
    physics.adopt(state);
    giveWeapon(state.loadout, weapon);
    return { ...session, id: cursor.id };
  }

  it('promotes a vehicle of the traffic a round goes into, and damages it', () => {
    const traffic = gridTraffic(SEED);
    const { state, physics, id } = besideTraffic(traffic, 'ak-47');
    const pose = {} as AmbientPose;
    for (let i = 0; i < 60 && promotedOf(state.traffic, id) === undefined; i++) {
      // Aim at where the tour puts it on the tick the shot is fired from.
      traffic.poseAt(id, state.tick + 1, pose);
      state.player.heading = Math.atan2(pose.y - state.player.y, pose.x - state.player.x);
      step(state, physics, { fire: true });
      step(state, physics);
    }
    const record = promotedOf(state.traffic, id);
    expect(record, 'the shot never promoted it').toBeDefined();
    expect(record?.vehicle.damage.integrity).toBeLessThan(1);
    // The first shot at it is the one that promotes it.
    expect(state.loadout.shots).toBe(1);
    expect(physics.traffic?.cursors.some((cursor) => cursor.id === id)).toBe(false);
    expect(physics.traffic?.promotedBodies).toBe(state.traffic.promoted.length);
    physics.dispose();
  });

  it('lands every pellet of one blast on the vehicle the first pellet promoted', () => {
    const traffic = gridTraffic(SEED);
    const { state, physics, id } = besideTraffic(traffic, 'remington-870');
    const pose = {} as AmbientPose;
    traffic.poseAt(id, state.tick + 1, pose);
    state.player.heading = Math.atan2(pose.y - state.player.y, pose.x - state.player.x);
    step(state, physics, { fire: true });
    const record = promotedOf(state.traffic, id);
    expect(record, 'the blast never promoted it').toBeDefined();
    // The body the first pellet met is gone before the rest are cast, and the
    // world has not been stepped since: the rest still find the same car.
    const taken = 1 - (record?.vehicle.damage.integrity ?? 1);
    expect(taken).toBeGreaterThan(4 * roundSeverity(weaponOf('remington-870')));
    physics.dispose();
  });

  it('promotes and damages a vehicle of the traffic a rocket goes off against', () => {
    const traffic = gridTraffic(SEED);
    const { state, physics, id } = besideTraffic(traffic, 'rpg-7');
    const pose = {} as AmbientPose;
    // Lead it by the few ticks the rocket is in the air.
    traffic.poseAt(id, state.tick + 4, pose);
    state.player.heading = Math.atan2(pose.y - state.player.y, pose.x - state.player.x);
    step(state, physics, { fire: true });
    step(state, physics, {}, 30);
    const record = promotedOf(state.traffic, id);
    expect(record, 'the rocket never promoted it').toBeDefined();
    expect(record?.vehicle.damage.integrity).toBeLessThan(1);
    physics.dispose();
  });

  it('promotes a vehicle of the traffic a swing lands on, and dents it', () => {
    const traffic = gridTraffic(SEED);
    const { state, physics, id } = besideTraffic(traffic, 'baseball-bat');
    const pose = {} as AmbientPose;
    for (let i = 0; i < 60 && promotedOf(state.traffic, id) === undefined; i++) {
      // Keep beside it, within a bat's reach of its side.
      traffic.poseAt(id, state.tick + 1, pose);
      const side = specOf(traffic.vehicles[id]?.cls ?? 'saloon').halfWidth + 0.6;
      state.player.x = pose.x + Math.cos(pose.heading + Math.PI / 2) * side;
      state.player.y = pose.y + Math.sin(pose.heading + Math.PI / 2) * side;
      state.player.heading = pose.heading - Math.PI / 2;
      physics.adopt(state);
      step(state, physics, { fire: true });
      step(state, physics);
    }
    const record = promotedOf(state.traffic, id);
    expect(record, 'the swing never promoted it').toBeDefined();
    expect(record?.vehicle.damage.integrity).toBeLessThan(1);
    expect(state.hits.some((hit) => hit.surface === 'vehicle')).toBe(true);
    physics.dispose();
  });

  /** Put a promoted vehicle of a class down 2 m beside the player, standing still. */
  function promotedBeside(state: SimState, cls: VehicleClass, id: number): void {
    const spec = specOf(cls);
    const x = state.player.x + spec.halfWidth + 1;
    const y = state.player.y;
    const vehicle = createVehicleState(spec, x, y, gridHeight(x, y) + rideHeight(spec), Math.PI / 2);
    addPromoted(state.traffic, { id, paint: 0x123456, vehicle });
  }

  it('steals a promoted vehicle and drives it, leaving the player car in its place', () => {
    const traffic = gridTraffic(SEED);
    const { state, physics } = onFoot(traffic, 1000, 1000);
    const own = state.vehicle;
    promotedBeside(state, 'saloon', 3);
    step(state, physics, {}, 30);
    const heat = state.heat;
    step(state, physics, { interact: true });
    expect(state.player.driving).toBe(true);
    expect(state.vehicle.cls).toBe('saloon');
    expect(state.vehicle.paint).toBe(0x123456);
    // The car the player left is a car of the city now, under the same id.
    expect(promotedOf(state.traffic, 3)?.vehicle).toBe(own);
    expect(state.heat).toBeGreaterThan(heat);
    const startX = state.vehicle.x;
    step(state, physics, { throttle: 1 }, 120);
    // Heading π/2 points down the map's y, which is the world's z.
    expect(Math.abs(state.vehicle.z - 1000)).toBeGreaterThan(5);
    expect(Math.abs(state.vehicle.x - startX)).toBeLessThan(3);
    physics.dispose();
  });

  it('works the lock of a promoted vehicle worth stealing before driving off in it', () => {
    const traffic = gridTraffic(SEED);
    const { state, physics } = onFoot(traffic, 1000, 1000);
    promotedBeside(state, 'sports', 4);
    step(state, physics, {}, 30);
    step(state, physics, { interact: true });
    expect(state.player.driving).toBe(false);
    expect(state.theft?.target).toBe(4);
    // Nobody presses: the cap opens the lock.
    step(state, physics, {}, HOTWIRE_CAP + 1);
    expect(state.theft).toBeNull();
    expect(state.player.driving).toBe(true);
    expect(state.vehicle.cls).toBe('sports');
    expect(state.vehicle.hotwired).toBe(true);
    step(state, physics, { throttle: 1 }, 120);
    expect(Math.abs(state.vehicle.z - 1000)).toBeGreaterThan(5);
    physics.dispose();
  });
});
