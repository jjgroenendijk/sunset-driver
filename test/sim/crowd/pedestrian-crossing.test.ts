import { describe, expect, it } from 'vitest';
import { KERB_SPREAD, signalCrossings, type Crossing } from '../../../src/sim/crowd/pedestrian-crossing.ts';
import type { Pavements, WalkRoute } from '../../../src/sim/crowd/pedestrian-route.ts';
import { AmbientPedestrians } from '../../../src/sim/crowd/pedestrians.ts';
import { AmbientTraffic } from '../../../src/sim/traffic/traffic.ts';
import type { TrafficSignals } from '../../../src/sim/traffic/signals.ts';
import type { RoadGraph } from '../../../src/world/roads/graph.ts';
import { gridTrafficRoads } from '../../support/traffic-grid.ts';

/** The crossings read the slow way: the walk at every step of half a metre, 18 m round each corner with lights. */
function everyStep(pavements: Pavements, graph: RoadGraph, route: WalkRoute, signals: TrafficSignals, back: number): Crossing[] {
  const out: Crossing[] = [];
  const count = route.edges.length;
  for (let i = 0; i < count; i++) {
    const node = graph.edges[route.edges[i]!]!.to;
    const junction = signals.junctionAt(node);
    if (route.jay[i] === 1 || junction < 0) continue;
    const next = (i + 1) % count;
    const span: [number, number] = [route.toCorner[i]! - 18, (next === 0 ? route.length : route.start[next]!) + 18];
    for (const [open, end, edge] of runsOnRoad(pavements, route, node, span)) {
      const twin = graph.edges[edge]!.twin;
      const axis = signals.approachOf(twin >= 0 ? twin : edge)?.axis;
      const wrap = (v: number): number => ((v % route.length) + route.length) % route.length;
      if (axis !== undefined) out.push({ at: wrap(open - back), end: wrap(end), junction, axis });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Every run of steps on a carriageway at `node`: where it starts, where it ends and whose carriageway. */
function runsOnRoad(pavements: Pavements, route: WalkRoute, node: number, [from, to]: [number, number]): [number, number, number][] {
  const runs: [number, number, number][] = [];
  const point = { x: 0, y: 0, height: 0 };
  let open: [number, number] | undefined;
  for (let k = 0; from + k * 0.5 <= to + 0.25; k++) {
    const d = from + k * 0.5;
    const on = d <= to ? pavements.carriagewayAt(node, ...xy(pavements.sample(route, d, point))) : -1;
    if (on >= 0 && open === undefined) open = [d, on];
    else if (on < 0 && open !== undefined) {
      runs.push([open[0], d, open[1]]);
      open = undefined;
    }
  }
  return runs;
}

function xy(p: { x: number; y: number }): [number, number] {
  return [p.x, p.y];
}

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

  it('finds the crossings a reading at every step finds, from far fewer readings (#787)', () => {
    if (signals === undefined) throw new Error('the grid has no lights');
    let crossings = 0;
    for (const person of crowd.people) {
      const found = signalCrossings(crowd.pavements, roads.graph, person.route, signals, 0);
      expect(found).toEqual(everyStep(crowd.pavements, roads.graph, person.route, signals, 0.6));
      crossings += found.length;
    }
    expect(crossings).toBeGreaterThan(0);
  });
});
