import { Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { BONES, pedestrianRig } from '../src/render/pedestrian-rig.ts';
import { casualtyPose, emptyCasualtyPose, type Casualty } from '../src/sim/casualty-motion.ts';
import { KILL_SPEED } from '../src/sim/car-strike.ts';
import type { PedestrianPose } from '../src/sim/pedestrians.ts';
import { initPhysics, SimPhysics, type Ground } from '../src/sim/physics.ts';
import { BONE_STRIDE, RAGDOLL_BONES, RAGDOLL_PARTS } from '../src/sim/ragdoll-body.ts';
import { RAGDOLL_TICKS } from '../src/sim/ragdoll.ts';
import { cloneSimState } from '../src/sim/simulation.ts';
import { stableJson } from './helpers.ts';
import { drive, ramp, start, type Session } from './sim-harness.ts';

/**
 * The Rapier ragdolls of the freshest casualties (`src/sim/ragdoll.ts`): a
 * person the player's car hits is thrown as a jointed body, comes to rest on
 * the ground, and freezes into the record, which the closed form then agrees
 * with.
 */
describe('the ragdoll', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  /** A crowd of one, standing on the ground `gap` metres ahead of the car. */
  function standIn(session: Session, gap: number): void {
    const v = session.state.vehicle;
    const at = { x: v.x + gap, y: v.z };
    session.ground.crowd = {
      near(minX: number, minY: number, maxX: number, maxY: number, out: number[]): number[] {
        out.length = 0;
        if (at.x >= minX && at.x < maxX && at.y >= minY && at.y < maxY) out.push(0);
        return out;
      },
      poseAt(_id: number, _time: number, out: PedestrianPose): PedestrianPose {
        out.x = at.x;
        out.y = at.y;
        out.height = session.ground.heightAt(at.x, at.y);
        out.heading = Math.PI / 2;
        return out;
      },
      startle: () => 0,
    };
  }

  /** A car on flat ground, or ground with a wall across it, doing `speed` at a person ahead. */
  function hit(speed: number, ground: Ground = ramp('asphalt', 0)): { session: Session; tick: number } {
    const session = start(ground);
    const { state, physics } = session;
    standIn(session, 6);
    state.vehicle.vx = speed;
    physics.adopt(state);
    for (let i = 0; i < 60 && state.pedestrians.casualties.length === 0; i++) drive(session, 1);
    expect(state.pedestrians.casualties).toHaveLength(1);
    return { session, tick: state.tick - 1 };
  }

  const record = (session: Session): Casualty => session.state.pedestrians.casualties[0] as Casualty;

  /** Step until the ragdoll freezes, and answer the ticks it took. Gives up past its longest life. */
  function settle(session: Session): number {
    let ticks = 0;
    while (session.physics.ragdolls.count > 0 && ticks <= RAGDOLL_TICKS + 2) {
      drive(session, 1);
      ticks++;
    }
    return ticks;
  }

  function expectOnGround(pose: number[], ground: Ground): void {
    for (let i = 0; i < RAGDOLL_BONES.length; i++) {
      const o = i * BONE_STRIDE;
      const floor = ground.heightAt(pose[o] as number, pose[o + 2] as number);
      expect(pose[o + 1] as number).toBeGreaterThan(floor - 0.05);
    }
    expect((pose[1] as number) - ground.heightAt(pose[0] as number, pose[2] as number)).toBeLessThan(0.5);
  }

  it('matches the joints and the bones of the crowd rig, and weighs a person', () => {
    expect([...RAGDOLL_BONES]).toEqual([...BONES]);
    const { skeleton } = pedestrianRig();
    const at = new Vector3();
    for (const [i, part] of RAGDOLL_PARTS.entries()) {
      expect(part.bone).toBe(RAGDOLL_BONES[i]);
      (skeleton.bones[i] as NonNullable<(typeof skeleton.bones)[number]>).getWorldPosition(at);
      expect(at.x).toBeCloseTo(part.at[0], 6);
      expect(at.y).toBeCloseTo(part.at[1], 6);
      expect(at.z).toBeCloseTo(part.at[2], 6);
    }
    const mass = RAGDOLL_PARTS.reduce((sum, part) => sum + part.mass, 0);
    expect(mass).toBeCloseTo(75, 6);
  });

  it('throws a person a fast car hits, lays them on the ground, and freezes within four seconds', () => {
    const { session, tick } = hit(KILL_SPEED + 3);
    const { state, physics, ground } = session;
    expect(physics.ragdolls.count).toBe(1);
    const thrown = record(session);
    expect(thrown.since).toBe(tick);
    expect(thrown.ragdoll).toHaveLength(RAGDOLL_BONES.length * BONE_STRIDE);
    // The ragdoll carries them off along the car's way, above the ground.
    drive(session, 20);
    expect((thrown.ragdoll as number[])[0]).toBeGreaterThan(thrown.x + 3);
    const ticks = settle(session) + 20;
    expect(physics.ragdolls.count).toBe(0);
    expect(ticks).toBeLessThanOrEqual(RAGDOLL_TICKS + 1);
    const frozen = record(session);
    const pose = frozen.ragdoll as number[];
    expectOnGround(pose, ground);
    // Re-based: the closed form lies them where the ragdoll left them, and the dead stay there.
    expect(frozen.push).toBe(0);
    expect(frozen.lift).toBe(0);
    for (const later of [state.tick, state.tick + 600]) {
      const at = casualtyPose(frozen, later, emptyCasualtyPose());
      expect(at.phase).toBe('lie');
      expect(at.x).toBeCloseTo(pose[0] as number, 6);
      expect(at.y).toBeCloseTo(pose[2] as number, 6);
      expect(at.height).toBeCloseTo(0, 3);
    }
    physics.dispose();
  });

  it('gets the wounded up when their time on the ground is up, counted from where the ragdoll left them', () => {
    const { session } = hit(13);
    const { state, physics } = session;
    const alive = record(session);
    expect(alive.health).toBeGreaterThan(0);
    expect(alive.down).toBeGreaterThan(0);
    settle(session);
    const rested = state.tick - 1;
    const frozen = record(session);
    expect(frozen.ragdoll).not.toBeNull();
    const up = rested + frozen.down;
    expect(casualtyPose(frozen, up - 1, emptyCasualtyPose()).phase).toBe('lie');
    expect(casualtyPose(frozen, up + 1, emptyCasualtyPose()).phase).not.toBe('lie');
    // On getting up the record lets go of the bones, and the closed form draws them again.
    drive(session, up + 2 - state.tick);
    expect(record(session).ragdoll).toBeNull();
    physics.dispose();
  });

  it('is the same in two identical runs', () => {
    const runs = [0, 1].map(() => {
      const { session } = hit(KILL_SPEED + 3);
      drive(session, 90);
      const json = stableJson(session.state.pedestrians);
      session.physics.dispose();
      return json;
    });
    expect(runs[0]).toBe(runs[1]);
    expect(runs[0]).toContain('ragdoll');
  });

  it('stops against a wall', () => {
    // A bank rising six metres over one cell of the heightfield, 14 m past the car.
    const wall = 14;
    const ground: Ground = {
      ...ramp('asphalt', 0),
      heightAt: (x) => (x < wall ? 0 : Math.min(6, (x - wall) * 2.4)),
    };
    const { session } = hit(KILL_SPEED + 3, ground);
    const { physics } = session;
    let furthest = -Infinity;
    for (let i = 0; i < RAGDOLL_TICKS && physics.ragdolls.count > 0; i++) {
      drive(session, 1);
      const pose = record(session).ragdoll as number[];
      for (let b = 0; b < RAGDOLL_BONES.length; b++) furthest = Math.max(furthest, pose[b * BONE_STRIDE] as number);
    }
    // Unstopped, the throw carries them twenty metres and more.
    expect(furthest).toBeLessThan(wall + 3);
    expectOnGround(record(session).ragdoll as number[], ground);
    physics.dispose();
  });

  it('builds a ragdoll again from a save caught mid-throw', () => {
    const { session } = hit(KILL_SPEED + 3);
    drive(session, 10);
    const saved = cloneSimState(session.state);
    session.physics.dispose();
    const physics = new SimPhysics(session.ground, saved);
    const loaded = { ...session, state: saved, physics };
    drive(loaded, 1);
    expect(physics.ragdolls.count).toBe(1);
    settle(loaded);
    expect(record(loaded).push).toBe(0);
    expectOnGround(record(loaded).ragdoll as number[], session.ground);
    physics.dispose();
  });
});
