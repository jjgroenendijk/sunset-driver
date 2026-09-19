import { describe, expect, it } from 'vitest';
import { heightOff, RouteSampler, type RoutePoint } from '../src/sim/route-sample.ts';
import { trafficRoadsOf } from '../src/sim/traffic.ts';
import { planeHeight, RoadBeds } from '../src/world/bed.ts';
import { roadDecks } from '../src/world/decks.ts';
import { buildRoadGraph, type RoadEdge } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { buildJunctions } from '../src/world/junctions.ts';
import type { RoadCurve, WorldDescription } from '../src/world/types.ts';
import { withNodes } from './helpers.ts';

/** Metres off the centreline the checks read the surface at. */
const OFF = 3;

function curve(id: number, coords: readonly [number, number][], bridges: number[] = []): RoadCurve {
  return { id, tier: 'street', points: coords.map(([x, y]) => ({ x, y })), bridges, tunnels: [], interchanges: [], nodes: [] };
}

/**
 * A hillside that climbs along x, with a road along x and a street across it
 * along y. The junction's plane tilts along x, so inside the street's mouth
 * the street tilts across. The street's first segment is a deck.
 */
function hillWorld(): WorldDescription {
  const hf = Heightfield.create(81, 10);
  for (let iy = 0; iy < 81; iy++) {
    for (let ix = 0; ix < 81; ix++) hf.set(ix, iy, 20 + hf.worldX(ix) * 0.1);
  }
  const roads = [curve(0, [[-200, 0], [0, 0], [200, 0]]), curve(1, [[0, -200], [0, 0], [0, 200]], [0])];
  const water = { islands: [{ id: 0, x: 0, y: 0, radius: 400, main: true }], harbour: { x: 0, y: 0, radius: 10 } };
  return { size: 800, core: { x: 0, y: 0 }, water, terrain: hf.toData(), roads: withNodes(roads) } as unknown as WorldDescription;
}

const world = hillWorld();
const graph = buildRoadGraph(world.roads);
const junctions = buildJunctions(world.roads, graph);
const beds = new RoadBeds(world.terrain, world.roads, junctions);
const plane = beds.planes[0] as (typeof beds.planes)[number];

describe('the bank of a road inside a junction mouth', () => {
  it('tilts a deck across as the junction plane does', () => {
    expect(plane.gx).toBeCloseTo(0.1, 6);
    const deck = roadDecks(world).find((span) => span.curve === 1);
    const node = deck?.points.find((p) => p.x === 0 && p.y === 0);
    if (node === undefined) throw new Error('no deck point at the node');
    expect(Math.abs(node.bank)).toBeCloseTo(0.1, 6);
    for (const off of [-OFF, OFF]) {
      const x = node.x + node.acrossX * off;
      const y = node.y + node.acrossY * off;
      expect(node.height + node.bank * off).toBeCloseTo(planeHeight(plane, x, y), 6);
    }
  });

  it('stands a vehicle in a lane on the tilted surface', () => {
    const roads = trafficRoadsOf(world, graph, beds, junctions);
    const sampler = new RouteSampler(roads.roads, graph, roads.heightAt, roads.tiltAt);
    const edge = graph.edges.find((e) => e.curve === 1 && e.start === 1 && e.end === 2) as RoadEdge;
    const legs = { edges: Int32Array.of(edge.id), startDistance: Float64Array.of(0), length: edge.length };
    const at: RoutePoint = { x: 0, y: 0, height: 0, tiltX: 0, tiltY: 0, rightX: 0, rightY: 0, edge };
    const mouth = junctions.junctions[0]?.mouths.find((m) => m.curve === 1 && m.direction === 1);
    if (mouth === undefined) throw new Error('no mouth of the street');
    // Inside the cut, where the street lies on the plane.
    sampler.sample(legs, mouth.cut / 2, at);
    const x = at.x + at.rightX * OFF;
    const y = at.y + at.rightY * OFF;
    expect(Math.abs(heightOff(at, OFF) - at.height)).toBeCloseTo(0.1 * OFF, 6);
    expect(heightOff(at, OFF)).toBeCloseTo(planeHeight(plane, x, y), 6);
  });
});
