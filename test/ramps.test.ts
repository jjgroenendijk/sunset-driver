import { describe, expect, it } from 'vitest';
import { compareStrings } from '../src/core/sort.ts';
import { TrafficSignals } from '../src/sim/signals.ts';
import { AmbientTraffic, laneOffset, type TrafficRoads } from '../src/sim/traffic.ts';
import { buildRoadGraph, type RoadEdge, type RoadGraph } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { junctionShape } from '../src/world/junction-shape.ts';
import { buildJunctions, MAX_CUT } from '../src/world/junctions.ts';
import { RoadRibbons } from '../src/world/ribbon.ts';
import { footprintHalfWidth } from '../src/world/tiers.ts';
import type { Point, RoadCurve } from '../src/world/types.ts';
import { sweepSeeds, withNodes } from './helpers.ts';

/**
 * Half a diamond, laid by hand (spec section 6.2, `diamonds.ts`): a highway
 * along x and an arterial that ends 60 m north of it. Right of the highway's own direction is north, so the ramps
 * there serve the eastbound carriageway: the off-ramp leaves it at x = -70,
 * before the interchange, and the on-ramp joins it at x = 70, after it.
 */
function halfDiamond(): RoadCurve[] {
  const line = (from: Point, to: Point, step: number): Point[] => {
    const n = Math.round(Math.hypot(to.x - from.x, to.y - from.y) / step);
    return Array.from({ length: n + 1 }, (_, k) => ({ x: from.x + ((to.x - from.x) * k) / n, y: from.y + ((to.y - from.y) * k) / n }));
  };
  const foot = { x: 0, y: 60 };
  const base = { bridges: [], tunnels: [], interchanges: [], nodes: [] };
  const roads: RoadCurve[] = [
    { ...base, id: 0, tier: 'highway', points: line({ x: -400, y: 0 }, { x: 400, y: 0 }, 10), interchanges: [40] },
    { ...base, id: 1, tier: 'arterial', points: line(foot, { x: 0, y: 400 }, 10) },
    // A street across the arterial, so traffic off the ramps has somewhere to go.
    { ...base, id: 2, tier: 'street', points: line({ x: -200, y: 200 }, { x: 200, y: 200 }, 10) },
    { ...base, id: 3, tier: 'ramp', points: line({ x: -70, y: 0 }, foot, 11.5), ramp: { highway: 0, arterial: 1, exit: true } },
    { ...base, id: 4, tier: 'ramp', points: line(foot, { x: 70, y: 0 }, 11.5), ramp: { highway: 0, arterial: 1, exit: false } },
  ];
  return withNodes(roads);
}

function rampRoads(): TrafficRoads {
  const roads = halfDiamond();
  const graph = buildRoadGraph(roads);
  return { roads, graph, heightAt: () => 0, junctions: buildJunctions(roads, graph) };
}

/** The edge of a curve that arrives at, or leaves, the node standing at a place. */
function edgeAt(graph: RoadGraph, curve: number, at: Point, arrives: boolean): RoadEdge {
  const node = graph.nearestNode(at.x, at.y) as number;
  const found = graph.edges.find((e) => e.curve === curve && (arrives ? e.to : e.from) === node);
  if (found === undefined) throw new Error(`no edge of curve ${curve} ${arrives ? 'into' : 'out of'} ${at.x},${at.y}`);
  return found;
}

describe('the ramps of an interchange (spec section 6.2)', () => {
  it('lays each ramp as one edge, driven only from its first point to its last', () => {
    const { graph } = rampRoads();
    const ramps = graph.edges.filter((e) => e.tier === 'ramp');
    expect(ramps).toHaveLength(2);
    for (const edge of ramps) expect(edge.twin).toBe(-1);
    const exit = edgeAt(graph, 3, { x: 0, y: 60 }, true);
    expect(graph.nodes[exit.from]).toMatchObject({ x: -70, y: 0 });
  });

  it('keeps a car on its own carriageway where a ramp lands on the highway', () => {
    const { graph } = rampRoads();
    const entry = edgeAt(graph, 4, { x: 70, y: 0 }, true);
    // Merging east is a gentle turn; turning west would cross the highway.
    const east = graph.edges.find((e) => e.curve === 0 && e.from === entry.to && (graph.nodes[e.to]?.x ?? 0) > 70) as RoadEdge;
    const west = graph.edges.find((e) => e.curve === 0 && e.from === entry.to && (graph.nodes[e.to]?.x ?? 0) < 70) as RoadEdge;
    expect(graph.turnAllowed(entry.id, east.id)).toBe(true);
    expect(graph.turnAllowed(entry.id, west.id)).toBe(false);
    const exit = edgeAt(graph, 3, { x: -70, y: 0 }, false);
    const eastbound = graph.edges.find((e) => e.curve === 0 && e.to === exit.from && (graph.nodes[e.from]?.x ?? 0) < -70) as RoadEdge;
    const westbound = graph.edges.find((e) => e.curve === 0 && e.to === exit.from && (graph.nodes[e.from]?.x ?? 0) > -70) as RoadEdge;
    expect(graph.turnAllowed(eastbound.id, exit.id)).toBe(true);
    expect(graph.turnAllowed(westbound.id, exit.id)).toBe(false);
  });

  it('routes over the ramps in their own direction only, and keeps to the turns at the landings', () => {
    const { graph } = rampRoads();
    const node = (x: number, y: number): number => graph.nearestNode(x, y) as number;
    const off = graph.shortestPath(node(-300, 0), node(0, 400));
    expect(off?.edges.map((e) => graph.edges[e]?.curve)).toContain(3);
    // Back to the west end: on at x = 70 heading east, so the only way west is
    // round the far end of the highway, never across it at the landing.
    const back = graph.shortestPath(node(0, 400), node(-300, 0));
    if (back === undefined) throw new Error('no route back');
    expect(back.edges.map((e) => graph.edges[e]?.curve)).toContain(4);
    for (let i = 0; i + 1 < back.edges.length; i++) {
      expect(graph.turnAllowed(back.edges[i] as number, back.edges[i + 1] as number), `leg ${i}`).toBe(true);
    }
    expect(back.nodes).toContain(node(400, 0));
  });

  it('drives the ambient traffic over the ramps only the way they run, and turns at the landings only as allowed', () => {
    const roads = rampRoads();
    const graph = roads.graph;
    for (const seed of sweepSeeds(4)) {
      const traffic = new AmbientTraffic(seed, roads);
      for (const vehicle of traffic.vehicles) {
        const edges = Array.from(vehicle.tour.edges);
        for (let i = 0; i < edges.length; i++) {
          const edge = graph.edges[edges[i] as number] as RoadEdge;
          const next = graph.edges[edges[(i + 1) % edges.length] as number] as RoadEdge;
          expect(edge.to, `seed ${seed}, vehicle ${vehicle.id}, leg ${i}`).toBe(next.from);
          expect(graph.turnAllowed(edge.id, next.id), `seed ${seed}, vehicle ${vehicle.id}, leg ${i}`).toBe(true);
        }
      }
    }
  });

  it('gives the off-ramp its own phase at the lights on the arterial', () => {
    const roads = rampRoads();
    const map = roads.junctions as NonNullable<TrafficRoads['junctions']>;
    const signals = new TrafficSignals(sweepSeeds(1)[0] as number, roads.roads, roads.graph, map, roads.heightAt);
    const foot = roads.graph.nearestNode(0, 60) as number;
    const junction = signals.junctions.find((j) => j.node === foot);
    if (junction === undefined) throw new Error('the foot of the diamond takes no light');
    const exit = edgeAt(roads.graph, 3, { x: 0, y: 60 }, true);
    const approach = junction.approaches.map((a) => signals.approaches[a]).find((a) => a?.edge === exit.id);
    if (approach === undefined) throw new Error('the off-ramp arrives at no light');
    const along = junction.approaches.map((a) => signals.approaches[a]).find((a) => a?.axis !== approach.axis);
    expect(along).toBeDefined();
  });

  it('shapes each landing as a merge: three mouths on a ring that stays a cut from the node', () => {
    // A ramp meets the highway at 40°, sharper than any crossroads. The apron
    // there must not run on along the highway as a sliver: it holds the
    // highway's two mouths and the ramp's, and ends a cut out along each.
    const roads = halfDiamond();
    const graph = buildRoadGraph(roads);
    const map = buildJunctions(roads, graph);
    const hf = Heightfield.create(101, 10);
    const ribbons = new RoadRibbons(hf.toData(), roads, map);
    const reach = MAX_CUT + footprintHalfWidth('highway');
    for (const x of [-70, 70]) {
      const node = graph.nearestNode(x, 0) as number;
      const junction = map.junctions.find((j) => j.node === node);
      if (junction === undefined) throw new Error(`no junction at the landing at x = ${x}`);
      expect(junction.mouths.map((m) => roads[m.curve]?.tier ?? '').sort(compareStrings)).toEqual(['highway', 'highway', 'ramp']);
      const ring = junctionShape(junction, ribbons).carriageway;
      for (const p of ring) expect(Math.hypot(p.x - junction.x, p.y - junction.y), `landing at x = ${x}`).toBeLessThan(reach);
    }
  });

  it('drives a ramp in the middle of its one-way carriageway', () => {
    expect(laneOffset({ tier: 'ramp', lanes: 1 }, 0)).toBe(0);
  });
});
