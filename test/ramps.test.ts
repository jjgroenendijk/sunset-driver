import { describe, expect, it } from 'vitest';
import { buildRoadGraph } from '../src/world/graph.ts';
import { RoadNetwork } from '../src/world/road-network.ts';
import { DIAMOND_RAMPS } from '../src/world/ramps.ts';
import { CLEARANCE } from '../src/world/overpass.ts';
import type { Interchange, Point, RoadCurve } from '../src/world/types.ts';

/**
 * Where the arterial of these tests crosses the highway: inside one of the
 * highway's segments, not on a point of it, since two lines that meet on a
 * point of one of them do not cross it.
 */
const CROSS_AT = 7;

/** A straight line of points every `step` metres, along x or along y. */
function line(from: number, to: number, step: number, across: number, alongX: boolean): Point[] {
  const out: Point[] = [];
  for (let v = from; v <= to; v += step) out.push(alongX ? { x: v, y: across } : { x: across, y: v });
  return out;
}

/** A flat world with one straight highway across it, with an interchange in the middle. */
function withHighway(): { network: RoadNetwork; highway: RoadCurve } {
  const network = new RoadNetwork(4000, () => 0);
  const points = line(-900, 900, 30, 0, true);
  const middle = points.findIndex((p) => p.x === 0);
  const highway = network.add({ tier: 'highway', points, bridges: [], tunnels: [], interchanges: [middle], slots: [] });
  expect(highway).toBeDefined();
  return { network, highway: highway as RoadCurve };
}

describe('diamond interchanges', () => {
  it('carries an arterial over a highway at an interchange and lays four one-way ramps', () => {
    const { network, highway } = withHighway();
    const arterial = network.add({ tier: 'arterial', points: line(-500, 500, 22, CROSS_AT, false), bridges: [], tunnels: [], interchanges: [] });
    expect(arterial).toBeDefined();
    const road = arterial as RoadCurve;
    // The arterial is raised over the highway, and the two share no point.
    expect(Math.max(...(road.lift ?? [0]))).toBeGreaterThanOrEqual(CLEARANCE);
    expect(road.nodes.filter((node) => node >= 0 && highway.nodes.includes(node))).toEqual([]);

    const interchange = highway.interchanges[0] as Interchange;
    expect(interchange.ramps).toHaveLength(DIAMOND_RAMPS);
    expect(interchange.heads).toHaveLength(2);
    for (const id of interchange.ramps) {
      const ramp = network.curves[id] as RoadCurve;
      expect(ramp.oneWay).toBe(true);
      expect(ramp.tier).toBe('arterial');
      expect(ramp.lift).toBeUndefined();
    }
  });

  it('gives each ramp one edge of the graph and no twin', () => {
    const { network, highway } = withHighway();
    network.add({ tier: 'arterial', points: line(-500, 500, 22, CROSS_AT, false), bridges: [], tunnels: [], interchanges: [] });
    const graph = buildRoadGraph(network.curves);
    const ramps = (highway.interchanges[0] as Interchange).ramps;
    for (const id of ramps) {
      const own = graph.edges.filter((edge) => edge.curve === id);
      expect(own.length).toBeGreaterThan(0);
      for (const edge of own) expect(edge.twin).toBe(-1);
    }
    // Each head of the highway has one ramp leaving it and one arriving, so
    // both directions of the highway can exchange traffic with the arterial.
    for (const head of (highway.interchanges[0] as Interchange).heads) {
      const node = highway.nodes[head] as number;
      const leaving = ramps.filter((id) => (network.curves[id] as RoadCurve).nodes[0] === node);
      const arriving = ramps.filter((id) => {
        const ramp = network.curves[id] as RoadCurve;
        return ramp.nodes[ramp.nodes.length - 1] === node;
      });
      expect([leaving.length, arriving.length]).toEqual([1, 1]);
    }
  });

  it('refuses the crossing where the highway has no interchange there', () => {
    const network = new RoadNetwork(4000, () => 0);
    const points = line(-900, 900, 30, 0, true);
    network.add({ tier: 'highway', points, bridges: [], tunnels: [], interchanges: [0, points.length - 1], slots: [] });
    // The crossing stands half a kilometre from either interchange, so the
    // road may not cross the highway there and is shortened back from it.
    const arterial = network.add({ tier: 'arterial', points: line(-500, 500, 22, CROSS_AT, false), bridges: [], tunnels: [], interchanges: [] });
    const crossed = arterial !== undefined && arterial.points.some((p) => p.y > 0) && arterial.points.some((p) => p.y < 0);
    expect(crossed).toBe(false);
  });
});
