import { MeshStandardMaterial, type InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import { TrafficView, trafficParts } from '../src/render/traffic.ts';
import { createSimState } from '../src/sim/simulation.ts';
import { AMBIENT_CLASSES, type AmbientPose } from '../src/sim/traffic.ts';
import { createVehicleState, specOf } from '../src/sim/vehicle.ts';
import { sweepSeeds } from './helpers.ts';
import { gridTraffic } from './traffic-grid.ts';

describe('the traffic, drawn (spec section 13.1)', () => {
  it('builds every ambient class out of paint and trim', () => {
    for (const cls of AMBIENT_CLASSES) {
      const parts = trafficParts(specOf(cls));
      expect(parts.paint.getAttribute('position').count, cls).toBeGreaterThan(0);
      expect(parts.trim.getAttribute('color').count, cls).toBe(parts.trim.getAttribute('position').count);
    }
  });

  it('holds the paint of every class before its first vehicle, so the warm-up compiles it', () => {
    // The warm-up draws each empty pool once; a program built without instance colours draws white.
    const view = new TrafficView(gridTraffic(sweepSeeds(1)[0] as number));
    const pools = view.group.children as InstancedMesh[];
    const painted = pools.filter((mesh) => mesh.material instanceof MeshStandardMaterial && !mesh.material.vertexColors);
    expect(painted.length).toBe(AMBIENT_CLASSES.length);
    for (const mesh of painted) expect(mesh.instanceColor?.count).toBe(mesh.instanceMatrix.count);
  });

  it('draws one instance per vehicle in view, and a promoted vehicle from its record', () => {
    const seed = sweepSeeds(1)[0] as number;
    const traffic = gridTraffic(seed);
    const view = new TrafficView(traffic);
    const state = createSimState(seed, undefined, 0);
    const tick = 4321.5;
    view.update(state, tick, 0, 0);
    // The grid is 480 m across and the view 360 m, so some vehicles are left out.
    const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
    let inView = 0;
    for (const vehicle of traffic.vehicles) {
      const at = traffic.poseAt(vehicle.id, tick, pose);
      if (Math.abs(at.x) <= 180 && Math.abs(at.y) <= 180) inView++;
    }
    expect(view.drawn).toBe(inView);
    expect(inView).toBeLessThan(traffic.vehicles.length);

    // A vehicle taken off its tour is drawn once, where its record says.
    const id = traffic.near(-10, -10, 10, 10, [])[0] as number;
    const vehicle = traffic.vehicles[id] as (typeof traffic.vehicles)[number];
    const at = traffic.poseAt(id, tick, pose);
    const far = Math.abs(at.x) <= 180 && Math.abs(at.y) <= 180 ? 0 : 1;
    state.traffic.promoted.push({ id, paint: vehicle.paint, vehicle: createVehicleState(specOf(vehicle.cls), 5, 5, 1, 0) });
    view.update(state, tick, 0, 0);
    expect(view.drawn).toBe(inView + far);
    view.dispose();
  });
});
