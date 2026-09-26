import { Scene } from 'three';
import { LightsNode } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { Headlights, headlampsOf, HEADLIGHT_CAP } from '../../../src/render/vehicles/headlights.ts';
import { LampLight } from '../../../src/render/roads/lamp-light.ts';
import { trafficParts } from '../../../src/render/vehicles/traffic.ts';
import { HEAD_GLOW, TAIL_GLOW, glowOf } from '../../../src/render/vehicles/vehicle-glow.ts';
import { LAMP, METAL, TAIL, TYRE } from '../../../src/render/vehicles/vehicle-mesh.ts';
import { AMBIENT_CLASSES } from '../../../src/sim/traffic/traffic.ts';
import { createVehicleState, specOf, rideHeight, type VehicleClass } from '../../../src/sim/vehicles/vehicle.ts';

/** The pool's lights, as the scene holds them. */
function poolOf(scene: Scene): LampLight[] {
  return scene.children.filter((child): child is LampLight => child instanceof LampLight);
}

describe('what a vehicle lights up (spec section 13.4)', () => {
  it('burns the lamps of a vehicle and nothing else', () => {
    expect(glowOf(LAMP)).toBe(HEAD_GLOW);
    expect(glowOf(TAIL)).toBe(TAIL_GLOW);
    expect(glowOf(TYRE)).toBe(0);
    expect(glowOf(METAL)).toBe(0);
  });

  it('gives every class of the traffic a glow on every trim vertex, and some of it lit', () => {
    for (const cls of AMBIENT_CLASSES) {
      const trim = trafficParts(specOf(cls)).trim;
      const glow = trim.getAttribute('glow');
      expect(glow.count, cls).toBe(trim.getAttribute('position').count);
      let lit = 0;
      for (let i = 0; i < glow.count; i++) if (glow.getX(i) > 0) lit++;
      // Every class of the ambient traffic carries lamps; a class with none
      // would be a car driving the night with nothing on it to see.
      expect(lit, cls).toBeGreaterThan(0);
      expect(lit, cls).toBeLessThan(glow.count);
    }
  });

  it('stands a beam on each headlamp of the class, pointing the way it faces', () => {
    const scene = new Scene();
    const headlights = new Headlights(scene);
    const pool = poolOf(scene);
    expect(pool).toHaveLength(HEADLIGHT_CAP);

    const spec = specOf('saloon');
    const lamps = headlampsOf(spec);
    expect(lamps).toHaveLength(HEADLIGHT_CAP);
    // Both are on the nose, one each side of the centreline.
    for (const lamp of lamps) expect(lamp.x).toBeGreaterThan(0);
    expect(Math.sign(lamps[0]!.z)).toBe(-Math.sign(lamps[1]!.z));

    const v = createVehicleState(spec, 10, 20, rideHeight(spec), 0);
    headlights.aim(v, spec, 1);
    for (const light of pool) {
      expect(light.intensity).toBeGreaterThan(0);
      // The vehicle faces along +x at heading 0, so the beam is thrown ahead of
      // it and lands lower than the lamp it leaves.
      expect(light.target.position.x).toBeGreaterThan(light.position.x);
      expect(light.target.position.y).toBeLessThan(light.position.y);
    }
  });

  it('parks the beams by day, and the light list never changes', () => {
    const scene = new Scene();
    const headlights = new Headlights(scene);
    const pool = poolOf(scene);
    const key = (): number => new LightsNode().setLights(pool).getCacheKey();
    const day = key();

    const spec = specOf('saloon');
    const v = createVehicleState(spec, 0, 0, rideHeight(spec), 0);
    headlights.aim(v, spec, 0);
    for (const light of pool) expect(light.intensity).toBe(0);
    headlights.aim(v, spec, 1);
    expect(key()).toBe(day);
  });

  it('parks the beam a class has no lamp for', () => {
    const scene = new Scene();
    const headlights = new Headlights(scene);
    const pool = poolOf(scene);
    // A class is drawn with the lamps its shape carries; one with a single lamp
    // lights one cone and leaves the other under the map.
    const one = (['motorcycle', 'truck', 'bus'] as VehicleClass[]).find((cls) => headlampsOf(specOf(cls)).length === 1);
    if (one === undefined) return;
    const spec = specOf(one);
    headlights.aim(createVehicleState(spec, 0, 0, rideHeight(spec), 0), spec, 1);
    expect(pool.filter((light) => light.intensity > 0)).toHaveLength(1);
    expect(pool.filter((light) => light.position.y < -1000)).toHaveLength(1);
  });
});
