import type { InstancedBufferGeometry, InterleavedBufferAttribute, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { PASS_STEP } from '../src/render/crowd-pass.ts';
import { PEDESTRIAN_VIEW, PedestrianView } from '../src/render/pedestrians.ts';
import { crowdAtHour } from '../src/sim/crowd-hours.ts';
import { outInThis } from '../src/sim/weather.ts';
import { AmbientPedestrians, type PedestrianPose } from '../src/sim/pedestrians.ts';
import { createSimState } from '../src/sim/simulation.ts';
import { gridTrafficRoads } from './traffic-grid.ts';

const pose = (): PedestrianPose => ({ x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' });

describe('the crowd, drawn (spec section 13.1)', () => {
  it('draws every person in view as one instance of one mesh, where their loop puts them', () => {
    const crowd = new AmbientPedestrians(5, gridTrafficRoads());
    const view = new PedestrianView(crowd);
    const state = createSimState(5, undefined, 0);
    state.tick = 40_000;
    const [x, y] = [30, -20];
    view.update(state, state.tick, x, y);

    // Everybody out at this hour and not indoors.
    const inView = crowd.people.filter((p) => {
      const at = crowd.poseAt(p.id, state.tick, pose());
      if (at.hidden === true || !outInThis(p.id, crowdAtHour(p.zone, state.tick))) return false;
      return Math.abs(at.x - x) <= PEDESTRIAN_VIEW && Math.abs(at.y - y) <= PEDESTRIAN_VIEW;
    });
    expect(inView.length).toBeGreaterThan(20);
    expect(view.drawn).toBe(inView.length);
    expect(view.group.children.length).toBe(1);

    // The first instance stands where the first person in view stands, or a step aside to pass somebody.
    const geometry = (view.group.children[0] as Mesh).geometry as InstancedBufferGeometry;
    const place = geometry.getAttribute('pedPlace') as InterleavedBufferAttribute;
    const first = crowd.poseAt((inView[0] as (typeof inView)[number]).id, state.tick, pose());
    expect(Math.hypot(place.getX(0) - first.x, place.getZ(0) - first.y)).toBeLessThanOrEqual(PASS_STEP + 1e-5);
    expect([place.getY(0), place.getW(0)]).toEqual([first.height, first.heading].map((v) => Math.fround(v)));

    // A startled person is drawn once, from their record, running off.
    const id = (inView[0] as (typeof inView)[number]).id;
    expect(crowd.startle(state.pedestrians, state.tick, first.x, first.y, 0.5, 'flee')).toBeGreaterThan(0);
    view.update(state, state.tick + 30, x, y);
    const motion = geometry.getAttribute('pedMotion') as InterleavedBufferAttribute;
    const drawnIds = state.pedestrians.startled.map((r) => r.id);
    expect(drawnIds).toContain(id);
    // The startled are written last, and they run.
    expect(motion.getX(view.drawn - 1)).toBeGreaterThan(0);
    view.dispose();
  });
});
