import { describe, expect, it } from 'vitest';
import { RoadBeds } from '../src/world/bed.ts';
import { onGround, type DraftLine } from '../src/world/crossing-plan.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { buildJunctions } from '../src/world/junctions.ts';
import { onFill, pointOnFill } from '../src/world/overpass.ts';
import type { District, RoadCurve, RoadTier, WorldDescription, Zone } from '../src/world/types.ts';
import { withNodes } from './helpers.ts';

const SIZE = 800;
const CELL = 10;
/** The height of the level ground every road here is laid on. */
const GROUND = 20;
/** How high the approach stands where the street meets it. */
const BANK = 3;

/** A line with lift, as `road-route.ts` hands one to the network: the ramp on fill, the span over the water a deck. */
function approach(over: Partial<DraftLine> = {}): DraftLine {
  return {
    tier: 'arterial',
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 300, y: 0 }],
    bridges: [2],
    tunnels: [],
    interchanges: [],
    lift: [0, BANK, 2 * BANK, 2 * BANK],
    ...over,
  };
}

function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

function curve(id: number, coords: readonly [number, number][], tier: RoadTier, lift?: number[]): RoadCurve {
  const road: RoadCurve = { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [], nodes: [] };
  if (lift !== undefined) road.lift = lift;
  return road;
}

/** A world on level ground, so every height a bed reads comes from the lift and not from the hill. */
function flatWorld(roads: RoadCurve[]): WorldDescription {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) for (let ix = 0; ix < gridSize; ix++) hf.set(ix, iy, GROUND);
  return {
    seed: 7,
    size: SIZE,
    archetype: 'archipelago',
    core: { x: 0, y: 0 },
    terrain: hf.toData(),
    water: {
      seaLevel: 0,
      islands: [{ id: 0, x: 0, y: 0, radius: SIZE / 2, main: true }],
      crossings: [],
      rivers: [],
      harbour: { x: 0, y: 0, radius: 10 },
      industry: 0,
    },
    districts: [district(0, 'inner', 0, 0)],
    beaches: [],
    airfields: [],
    roads: withNodes(roads),
    corridors: [],
    tram: { route: [], edges: [], corridors: [], stops: [], crossings: [], length: 0 },
  };
}

/**
 * The approach to a bridge over water (issue #593). The ramp climbs on fill the
 * carve makes up, so it is on the ground: a street laid later crosses it, meets
 * it at a junction, and the junction stands at the height the road drives.
 */
describe('a road carried on fill', () => {
  it('is on the ground at a raised segment that is no deck, and off it on the span itself', () => {
    const line = approach();
    expect(onFill(line, 0)).toBe(true);
    expect(onFill(line, 1)).toBe(true);
    // Segment 2 carries the same lift, but it is the deck over the water.
    expect(onFill(line, 2)).toBe(false);
    expect(onGround(line, 1)).toBe(true);
    expect(onGround(line, 2)).toBe(false);
  });

  it('carries no fill where it carries no lift', () => {
    expect(onFill(approach({ lift: undefined }), 1)).toBe(false);
    expect(pointOnFill(approach({ lift: undefined }), 1)).toBe(false);
  });

  it('is met on fill at a point the embankment reaches, including the abutment', () => {
    const line = approach();
    expect(pointOnFill(line, 1)).toBe(true);
    // The abutment: fill behind it, deck in front. The ground stands at the
    // height the road drives, so a junction can be built there.
    expect(pointOnFill(line, 2)).toBe(true);
    // The far end of the deck has nothing but deck beside it.
    expect(pointOnFill(line, 3)).toBe(false);
  });

  it('holds a junction at the height it drives, and the street meeting it climbs to that', () => {
    // The arterial climbs its embankment along x and the street comes up to it
    // from the south. Without the lift in the plane the junction would be
    // levelled to the ground and dig a trough into the approach.
    const roads = [
      curve(0, [[0, 0], [100, 0], [200, 0], [300, 0]], 'arterial', [0, BANK, 2 * BANK, 2 * BANK]),
      curve(1, [[100, -200], [100, 0]], 'street'),
    ];
    (roads[0] as RoadCurve).bridges = [2];
    const world = flatWorld(roads);
    const beds = new RoadBeds(world.terrain, world.roads, buildJunctions(world.roads, buildRoadGraph(world.roads)));
    const node = beds.planeAt((world.roads[1] as RoadCurve).nodes[1] as number);
    expect(node?.level).toBeCloseTo(GROUND + BANK, 6);
    // The street's own ground is level, so every metre it stands over GROUND at
    // its end is the climb the junction asked of it.
    expect(beds.pointHeight(1, 1)).toBeCloseTo(GROUND + BANK, 6);
    // And it is back on its own line where the blend ends.
    expect(beds.pointHeight(1, 0)).toBeCloseTo(GROUND, 6);
  });

  it('levels the junction to the ground where no road meeting it carries lift', () => {
    const roads = [
      curve(0, [[0, 0], [100, 0], [200, 0], [300, 0]], 'arterial'),
      curve(1, [[100, -200], [100, 0]], 'street'),
    ];
    const world = flatWorld(roads);
    const beds = new RoadBeds(world.terrain, world.roads, buildJunctions(world.roads, buildRoadGraph(world.roads)));
    expect(beds.planeAt((world.roads[1] as RoadCurve).nodes[1] as number)?.level).toBeCloseTo(GROUND, 6);
  });
});
