import type { InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import { DamageFx } from '../src/render/damage-fx.ts';
import { EmergencyView } from '../src/render/emergency.ts';
import { TRAFFIC_VIEW } from '../src/render/traffic.ts';
import type { EmergencyUnit } from '../src/sim/emergency.ts';
import { light } from '../src/sim/fire.ts';
import { createSimState } from '../src/sim/simulation.ts';
import { specOf } from '../src/sim/vehicle.ts';

/** A unit of the service standing where a test wants it. */
function unit(id: number, kind: EmergencyUnit['kind'], x: number, y: number): EmergencyUnit {
  return {
    id,
    kind,
    task: 'respond',
    call: 0,
    x,
    y,
    heading: 0,
    height: 0,
    speed: 0,
    edges: [],
    distance: 0,
    stop: 0,
    planned: 0,
    goalX: x,
    goalY: y,
    homeX: x,
    homeY: y,
    until: -1,
  };
}

describe('the emergency services, drawn (spec section 20.3)', () => {
  it('draws the units in view and leaves out the ones over the horizon', () => {
    const view = new EmergencyView();
    const state = createSimState(4);
    state.emergency.units.push(unit(0, 'engine', 10, 0), unit(1, 'ambulance', -20, 5));
    view.update(state, 0, 0);
    expect(view.drawn).toBe(2);
    // A unit past the traffic's own view is not drawn at all.
    state.emergency.units.push(unit(2, 'engine', 2 * TRAFFIC_VIEW, 0));
    view.update(state, 0, 0);
    expect(view.drawn).toBe(2);
    // Nobody out is nothing drawn, and nothing left visible from the frame before.
    state.emergency.units.length = 0;
    view.update(state, 0, 0);
    expect(view.drawn).toBe(0);
    for (const mesh of view.group.children) expect((mesh as InstancedMesh).visible).toBe(false);
    view.dispose();
  });

  it('flashes the bars of two units against each other', () => {
    const view = new EmergencyView();
    const state = createSimState(4);
    state.emergency.units.push(unit(0, 'engine', 0, 0), unit(1, 'engine', 8, 0));
    view.update(state, 0, 0);
    // The meshes of a service go in as paint, trim, rim and then the bar.
    const bar = view.group.children[3] as InstancedMesh;
    expect(bar.count).toBe(2);
    const colours = bar.instanceColor;
    expect(colours).not.toBeNull();
    const first = [colours?.getX(0), colours?.getY(0), colours?.getZ(0)];
    const second = [colours?.getX(1), colours?.getY(1), colours?.getZ(1)];
    expect(second).not.toEqual(first);
    view.dispose();
  });

  it('sits an engine on the ground under it, at the ride height of the row it borrows', () => {
    const view = new EmergencyView();
    const state = createSimState(4);
    const standing = unit(0, 'engine', 0, 0);
    standing.height = 12;
    state.emergency.units.push(standing);
    view.update(state, 0, 0);
    const paint = view.group.children[0] as InstancedMesh;
    // The matrix of an instance holds its position in its last column.
    const y = paint.instanceMatrix.array[13] as number;
    expect(y).toBeGreaterThan(12);
    expect(y).toBeLessThan(12 + specOf('truck').halfHeight * 2);
    view.dispose();
  });
});

describe('a blaze, drawn (spec section 20.3)', () => {
  it('puts flames and embers in the air over the ground it burns on', () => {
    const fx = new DamageFx();
    const state = createSimState(4);
    state.tick = 600;
    light(state, 30, -40);
    const flame = fx.group.children[1] as InstancedMesh;
    fx.watch(state.fires.blazes, () => 7);
    fx.update(state.vehicle, specOf('saloon'), state.seed, state.tick);
    expect(flame.count).toBeGreaterThan(0);
    // Every puff stands over the ground the blaze burns on, and near it.
    for (let i = 0; i < flame.count; i++) {
      const at = i * 16;
      expect(flame.instanceMatrix.array[at + 13] as number).toBeGreaterThan(7);
      expect(Math.hypot((flame.instanceMatrix.array[at + 12] as number) - 30, (flame.instanceMatrix.array[at + 14] as number) + 40)).toBeLessThan(6);
    }
    // Nothing burning is nothing drawn.
    fx.watch([], () => 7);
    fx.reset(state.tick);
    fx.update(state.vehicle, specOf('saloon'), state.seed, state.tick + 1);
    expect(flame.count).toBe(0);
    fx.dispose();
  });
});
