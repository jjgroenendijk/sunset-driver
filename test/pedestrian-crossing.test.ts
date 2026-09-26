import { describe, expect, it } from 'vitest';
import { KERB_SPREAD, signalCrossings } from '../src/sim/pedestrian-crossing.ts';
import { AmbientPedestrians } from '../src/sim/pedestrians.ts';
import { AmbientTraffic } from '../src/sim/traffic.ts';
import { gridTrafficRoads } from './traffic-grid.ts';

describe('waiting at the lights (spec section 13.1, #721)', () => {
  const roads = { ...gridTrafficRoads(), heightAt: () => 0 };
  const signals = new AmbientTraffic(3, roads).signals;
  const crowd = new AmbientPedestrians(3, roads, undefined, signals);

  it('stands each person back from the kerb by a depth of their own, up to KERB_SPREAD', () => {
    if (signals === undefined) throw new Error('the grid has no lights');
    const person = crowd.people.find((p) => signalCrossings(crowd.pavements, roads.graph, p.route, signals).length > 0);
    if (person === undefined) throw new Error('nobody on the grid crosses under lights');
    const near = signalCrossings(crowd.pavements, roads.graph, person.route, signals, 0);
    const far = signalCrossings(crowd.pavements, roads.graph, person.route, signals, 1);
    expect(far).toHaveLength(near.length);
    const length = person.route.length;
    for (let i = 0; i < near.length; i++) {
      const back = ((near[i]!.at - far[i]!.at) % length + length) % length;
      expect(back).toBeCloseTo(KERB_SPREAD, 6);
      // The crossing itself ends where it did.
      expect(far[i]!.end).toBe(near[i]!.end);
    }
  });

});
