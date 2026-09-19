import type { InstancedBufferGeometry, InterleavedBufferAttribute, Mesh } from 'three';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CASUALTY_CAP, CasualtyView, MEDIC_SIDE } from '../src/render/casualties.ts';
import { BODY_FLOATS, CasualtyPoser, ragdollMatrices } from '../src/render/casualty-pose.ts';
import { BONES, JOINTS, pedestrianBody } from '../src/render/pedestrian-rig.ts';
import { emptyCasualtyPose, type Casualty, type CasualtyPose } from '../src/sim/casualty-motion.ts';
import type { EmergencyUnit } from '../src/sim/emergency.ts';
import { AmbientPedestrians } from '../src/sim/pedestrians.ts';
import { createSimState } from '../src/sim/simulation.ts';
import { gridTrafficRoads } from './traffic-grid.ts';

/** A body lying still where it fell: dead, pushed along -x. */
function body(id: number, over: Partial<Casualty> = {}): Casualty {
  return {
    id,
    since: 0,
    first: 0,
    cause: 'shot',
    health: 0,
    x: 10 + id * 3,
    y: 5,
    height: 0,
    rest: 0,
    heading: 0,
    dir: Math.PI,
    push: 0,
    lift: 0,
    reach: 0,
    down: -1,
    side: 1,
    cash: 12,
    gone: false,
    bumped: -1,
    ragdoll: null,
    ...over,
  };
}

/** Where the bind-pose point `p` of bone `b` goes under the matrices written at `at`. */
function apply(data: Float32Array, at: number, b: number, p: readonly number[]): Vector3 {
  const m = data.subarray(at + b * 16, at + b * 16 + 16);
  const [x, y, z] = p as [number, number, number];
  return new Vector3(
    (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
    (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
    (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
  );
}

function pose(over: Partial<CasualtyPose>): CasualtyPose {
  return { ...emptyCasualtyPose(), ...over };
}

describe('the casualties, posed (spec section 11.6)', () => {
  const poser = new CasualtyPoser();
  const data = new Float32Array(BODY_FLOATS);
  const geometry = pedestrianBody();
  const position = geometry.getAttribute('position');
  const bone = geometry.getAttribute('bone');

  it('lays a body flat on the ground, on its back or its front, and never into it', () => {
    for (let id = 0; id < 12; id++) {
      for (const heading of [0, Math.PI]) {
        const record = body(id, { side: id % 2 === 0 ? 1 : -1, heading });
        poser.write(record, pose({ phase: 'lie', heading, dir: Math.PI }), data, 0);
        for (let b = 0; b < BONES.length; b++) {
          const at = apply(data, 0, b, JOINTS[BONES[b] as (typeof BONES)[number]].at);
          expect(at.y).toBeLessThan(0.6);
        }
        // The lowest corner of the body is on the ground: it neither sinks nor floats.
        let lowest = Infinity;
        for (let i = 0; i < position.count; i++) {
          const p = apply(data, 0, bone.getX(i), [position.getX(i), position.getY(i), position.getZ(i)]);
          lowest = Math.min(lowest, p.y);
        }
        expect(lowest).toBeCloseTo(0, 4);
      }
    }
    // The head lies along the push, here -x from the hips.
    const head = apply(data, 0, BONES.indexOf('head'), JOINTS.head.at);
    expect(head.x).toBeLessThan(-0.5);
  });

  it('starts a fall standing, facing the way they faced, and ends it lying', () => {
    const record = body(3, { health: 50, down: 120 });
    poser.write(record, pose({ phase: 'fall', progress: 0, heading: 0, dir: Math.PI }), data, 0);
    const head = apply(data, 0, BONES.indexOf('head'), JOINTS.head.at);
    expect(head.y).toBeCloseTo(JOINTS.head.at[1], 3);
    expect(Math.abs(head.x)).toBeLessThan(1e-3);
    const toe = apply(data, 0, BONES.indexOf('shinL'), [0.18, 0, -0.1]);
    expect(toe.x).toBeGreaterThan(0.1);
    poser.write(record, pose({ phase: 'fall', progress: 1, heading: 0, dir: Math.PI }), data, 0);
    expect(apply(data, 0, BONES.indexOf('head'), JOINTS.head.at).y).toBeLessThan(0.6);
  });

  it('kneels a medic with the hips low and a knee on the ground', () => {
    poser.writeKneel(0, data, 0);
    expect(apply(data, 0, 0, JOINTS.hips.at).y).toBeLessThan(0.7);
    expect(apply(data, 0, BONES.indexOf('shinR'), JOINTS.shinR.at).y).toBeLessThan(0.15);
  });

  it('draws a body the ragdoll holds where the ragdoll put its bones', () => {
    const values: number[] = [];
    for (const name of BONES) values.push(100 + JOINTS[name].at[0], 2 + JOINTS[name].at[1], -40 + JOINTS[name].at[2], 0, 0, 0, 1);
    const place = new Vector3(values[0], values[1], values[2]);
    const scale = 1.1;
    ragdollMatrices(values, place, scale, data, 0);
    for (let b = 0; b < BONES.length; b++) {
      const at = apply(data, 0, b, JOINTS[BONES[b] as (typeof BONES)[number]].at).multiplyScalar(scale).add(place);
      expect(at.distanceTo(new Vector3(values[b * 7], values[b * 7 + 1], values[b * 7 + 2]))).toBeLessThan(1e-4);
    }
  });
});

describe('the casualties, drawn (spec sections 11.6, 20.3)', () => {
  it('draws the bodies in view, leaves out the ones taken away, and kneels medics at a working ambulance', () => {
    const crowd = new AmbientPedestrians(5, gridTrafficRoads());
    const view = new CasualtyView(crowd);
    const state = createSimState(5, undefined, 0);
    state.tick = 600;
    state.pedestrians.casualties = [body(0), body(1, { gone: true }), body(2, { cash: 0 }), body(3, { x: 5000 })];
    view.update(state, state.tick, 0, 0);
    expect(view.drawn).toBe(2);
    expect(view.notes).toBe(1);
    // Two meshes, however many are drawn: the bodies and the cash.
    expect(view.group.children.length).toBe(2);

    const unit: EmergencyUnit = {
      id: 4,
      kind: 'ambulance',
      task: 'work',
      call: 0,
      x: 12,
      y: 9,
      heading: 0,
      height: 0,
      speed: 0,
      edges: [],
      distance: 0,
      stop: 0,
      planned: 0,
      goalX: 10,
      goalY: 5,
      homeX: 0,
      homeY: 0,
      until: 99_999,
    };
    state.emergency.units.push(unit);
    view.update(state, state.tick, 0, 0);
    expect(view.drawn).toBe(4);
    const geometry = (view.group.children[0] as Mesh).geometry as InstancedBufferGeometry;
    const place = geometry.getAttribute('pedPlace') as InterleavedBufferAttribute;
    // The medics kneel either side of the nearest body, which is body 0 at (10, 5).
    for (const i of [2, 3]) {
      const d = Math.hypot(place.getX(i) - 10, place.getZ(i) - 5);
      expect(d).toBeGreaterThan(MEDIC_SIDE - 0.1);
      expect(d).toBeLessThan(MEDIC_SIDE + 0.5);
    }
    expect(place.getZ(2) - 5).toBeCloseTo(-(place.getZ(3) - 5), 3);

    // A unit driving away has no medics out.
    unit.task = 'leave';
    view.update(state, state.tick, 0, 0);
    expect(view.drawn).toBe(2);
    expect(view.drawn).toBeLessThanOrEqual(CASUALTY_CAP);
    view.dispose();
  });
});
