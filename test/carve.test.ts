import { describe, expect, it } from 'vitest';
import { buildChunkRoads, partsOf } from '../src/render/road-mesh.ts';
import { RoadBeds } from '../src/world/bed.ts';
import { benchHalfWidth, buildCarve } from '../src/world/carve.ts';
import { buildLayers, ChunkSource } from '../src/world/chunks.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { junctionShape } from '../src/world/junction-shape.ts';
import { buildJunctions } from '../src/world/junctions.ts';
import { RoadRibbons } from '../src/world/ribbon.ts';
import { CHUNK_TERRAIN_CELL } from '../src/world/terrain.ts';
import { footprintHalfWidth } from '../src/world/tiers.ts';
import type { District, RoadCurve, RoadTier, WorldDescription, Zone } from '../src/world/types.ts';
import { withNodes } from './helpers.ts';

const SIZE = 800;
const CELL = 10;

/**
 * Metres the ground may stand over a road surface and still be the road's own
 * ground. The loft draws one straight surface between the sections it places at
 * the curve's own points, and the carve levels the ground to the bed at every
 * place between them, so the two part by the sag of that chord wherever the bed
 * bends: a centimetre or two on the hill below, under the paint and under the
 * tyres. The fault this looks for is the hillside beside a road standing
 * through it, which is tens of centimetres.
 */
const SAG = 0.05;

function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

function curve(id: number, coords: readonly [number, number][], tier: RoadTier): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [], nodes: [] };
}

/**
 * A hand-built world under a hill, given the height of the ground at a place.
 * A flat hillside would say nothing here: the carve moves nothing on one, so a
 * road laid over it sits on the ground it was traced on whatever the bench does.
 */
function hillWorld(roads: RoadCurve[], height: (x: number, y: number) => number): WorldDescription {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) hf.set(ix, iy, height(hf.worldX(ix), hf.worldY(iy)));
  }
  return {
    seed: 31,
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
    districts: [district(0, 'inner', 0, 0), district(1, 'suburban', 250, 250)],
    beaches: [],
    roads: withNodes(roads),
    corridors: [],
    tram: { route: [], edges: [], corridors: [], stops: [], crossings: [], length: 0 },
  };
}

/**
 * The ground as a chunk draws it: the carve sampled on the grid anchored on the
 * origin, and the straight line between those samples. The mesh is two triangles
 * per cell, cut from the near corner to the far one, so a place is read off the
 * triangle it falls in and not off all four corners.
 */
function groundAt(carve: ReturnType<typeof buildCarve>, x: number, y: number): number {
  const cell = CHUNK_TERRAIN_CELL;
  const ix = Math.floor(x / cell);
  const iy = Math.floor(y / cell);
  const fx = x / cell - ix;
  const fy = y / cell - iy;
  const near = carve.heightAt(ix * cell, iy * cell);
  const far = carve.heightAt((ix + 1) * cell, (iy + 1) * cell);
  if (fx >= fy) {
    const along = carve.heightAt((ix + 1) * cell, iy * cell);
    return near + fx * (along - near) + fy * (far - along);
  }
  const across = carve.heightAt(ix * cell, (iy + 1) * cell);
  return near + fy * (across - near) + fx * (far - across);
}

describe('the ground under a road', () => {
  // A dome, so the ground falls away across every road laid on it and the
  // carve has a bench to cut. A street keeps a pavement above its carriageway
  // and a highway runs out level at its verge, so the two try the rule at both
  // heights a cross section ends at.
  /** A straight line of points every 20 m, as a traced curve carries them. */
  function line(from: number, to: number, at: (along: number) => [number, number]): [number, number][] {
    const out: [number, number][] = [];
    for (let along = from; along <= to; along += 20) out.push(at(along));
    return out;
  }
  const roads = [
    curve(0, line(-200, 150, (x) => [x, 120]), 'street'),
    curve(1, line(-200, 240, (y) => [200, y]), 'highway'),
  ];
  // A ridge along x = 100 falling away each side, over ground that also falls
  // along y, so both roads are cut into a slope across them. The grades are
  // steep enough that the hillside a cell beyond the bench stands well above
  // the road — a gentle slope hides the fault rather than showing it — and
  // gentle enough that the bench is still inside the cut the carve may take,
  // which is what leaves a retaining wall rather than a bench.
  const world = hillWorld(roads, (x, y) => 200 - 0.2 * Math.abs(x - 100) - 0.15 * y);
  const layers = buildLayers(world);
  const source = new ChunkSource(world, layers);
  const ribbons = new RoadRibbons(world.terrain, world.roads, layers.junctions);
  const chunk = source.chunk(0, 0);
  const built = buildChunkRoads(chunk, ribbons, (x, y, tier) => layers.carve.surfaceAt(x, y, tier));

  it('never stands above the surface the road draws over it', () => {
    expect(built.length).toBe(2);
    let complaint: string | undefined;
    let tested = 0;
    for (const tier of built) {
      for (const part of partsOf(tier)) {
        const position = part.getAttribute('position');
        const index = part.getIndex();
        const count = index === null ? position.count : index.count;
        for (let t = 0; t + 2 < count; t += 3) {
          const ids = [0, 1, 2].map((k) => (index === null ? t + k : index.getX(t + k)));
          const p = ids.map((v) => ({ x: position.getX(v), h: position.getY(v), y: position.getZ(v) }));
          const [a, b, c] = p as [(typeof p)[number], (typeof p)[number], (typeof p)[number]];
          // Only the faces the camera sees the road through. The skirt down
          // each edge is buried in the ground on purpose.
          const up = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
          if (Math.abs(up) < 1e-9) continue;
          tested++;
          for (const [wa, wb, wc] of [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
            [1 / 3, 1 / 3, 1 / 3],
            [0.5, 0.5, 0],
            [0, 0.5, 0.5],
            [0.5, 0, 0.5],
          ] as const) {
            const x = a.x * wa + b.x * wb + c.x * wc;
            const y = a.y * wa + b.y * wb + c.y * wc;
            const surface = a.h * wa + b.h * wb + c.h * wc;
            const ground = groundAt(layers.carve, x, y);
            if (ground > surface + SAG) {
              complaint ??= `${tier.tier} at ${x.toFixed(1)},${y.toFixed(1)}: ground ${ground.toFixed(3)} over surface ${surface.toFixed(3)}`;
            }
          }
        }
      }
    }
    expect(tested).toBeGreaterThan(100);
    expect(complaint).toBeUndefined();
  });

  it('keeps the bench level a grid cell past the edge of the road', () => {
    // The margin is what puts every corner of a cell holding the edge of the
    // road on the bench itself.
    for (const tier of ['street', 'highway'] as const) {
      expect(benchHalfWidth(tier)).toBeGreaterThan(footprintHalfWidth(tier) + CHUNK_TERRAIN_CELL);
    }
  });
});

describe('two roads crowded into one bench', () => {
  // A hillside steep across the roads, with two streets close enough that the
  // bench of each reaches the other. Their beds are the ground under their own
  // centrelines, so they ask for heights four metres apart.
  const roads = [
    curve(0, [[-200, 0], [0, 0], [200, 0]], 'street'),
    curve(1, [[-200, 14], [0, 14], [200, 14]], 'street'),
  ];
  const world = hillWorld(roads, (_x, y) => 30 + y * 0.3);
  const carve = buildCarve(world.terrain, world.roads);
  const hf = new Heightfield(world.terrain);

  it('carves the ground they share to the lower of the beds they ask for', () => {
    const lower = hf.sample(0, 0);
    const upper = hf.sample(0, 14);
    expect(upper - lower).toBeCloseTo(4.2, 6);
    // Ground between the two centrelines is claimed by both.
    for (const y of [4, 7, 10]) {
      expect(carve.crowdedAt(0, y)).toBe(true);
      expect(carve.heightAt(0, y)).toBeCloseTo(lower, 6);
    }
    // Ground only one of them claims is carved to that one's bed.
    expect(carve.crowdedAt(0, -8)).toBe(false);
    expect(carve.heightAt(0, -8)).toBeCloseTo(lower, 6);
  });

  it('says nothing is crowded where one road has the ground to itself', () => {
    const alone = hillWorld([curve(0, [[-200, 0], [0, 0], [200, 0]], 'street')], (_x, y) => 30 + y * 0.3);
    const one = buildCarve(alone.terrain, alone.roads);
    for (const y of [0, 4, 8]) expect(one.crowdedAt(0, y)).toBe(false);
  });
});

describe('the ground under a junction', () => {
  // A street leaves an arterial at 30 degrees on a slope. The corner between
  // them is so sharp that the fan of the carriageway from the node reaches past
  // the junction's outline, which is the ground the carve used to level.
  const angle = (30 * Math.PI) / 180;
  const roads = [
    curve(0, [[-200, 0], [0, 0], [200, 0]], 'arterial'),
    curve(1, [[0, 0], [200 * Math.cos(angle), 200 * Math.sin(angle)]], 'street'),
  ];
  const world = hillWorld(roads, (x, y) => 60 + 0.08 * x - 0.12 * y);
  const junctions = buildJunctions(world.roads, buildRoadGraph(world.roads));
  const carve = buildCarve(world.terrain, world.roads, junctions);
  const beds = new RoadBeds(world.terrain, world.roads, junctions);
  const ribbons = new RoadRibbons(world.terrain, world.roads, junctions);

  it('levels all the ground the carriageway is drawn over to the plane', () => {
    expect(junctions.junctions).toHaveLength(1);
    const junction = junctions.junctions[0] as (typeof junctions.junctions)[number];
    const plane = beds.planes[0] as (typeof beds.planes)[number];
    const fan = junctionShape(junction, ribbons).carriageway;
    let complaint: string | undefined;
    let tested = 0;
    for (let i = 0; i < fan.length; i++) {
      const a = fan[i] as (typeof fan)[number];
      const b = fan[(i + 1) % fan.length] as (typeof fan)[number];
      for (const [wa, wb] of [
        [0.1, 0.8],
        [0.8, 0.1],
        [0.45, 0.45],
        [1 / 3, 1 / 3],
      ] as const) {
        const x = junction.x * (1 - wa - wb) + a.x * wa + b.x * wb;
        const y = junction.y * (1 - wa - wb) + a.y * wa + b.y * wb;
        const onPlane = plane.level + plane.gx * (x - plane.x) + plane.gy * (y - plane.y);
        tested++;
        if (Math.abs(carve.heightAt(x, y) - onPlane) > 1e-6) {
          complaint ??= `at ${x.toFixed(1)},${y.toFixed(1)}: ground ${carve.heightAt(x, y).toFixed(3)}, plane ${onPlane.toFixed(3)}`;
        }
      }
    }
    expect(tested).toBeGreaterThan(20);
    expect(complaint).toBeUndefined();
  });

  it('puts every vertex of the junction on the ground the carve leaves, mouths and all', () => {
    // The plane tilts across each mouth, so a road section laid level from
    // kerb to kerb would stand off the plane on one side and under it on the
    // other. The section banks as the plane does instead (issue #265).
    const junction = junctions.junctions[0] as (typeof junctions.junctions)[number];
    const plane = beds.planes[0] as (typeof beds.planes)[number];
    const shape = junctionShape(junction, ribbons);
    expect(shape.centre).toBeCloseTo(plane.level, 6);
    let complaint: string | undefined;
    for (const v of shape.carriageway) {
      const onPlane = plane.level + plane.gx * (v.x - plane.x) + plane.gy * (v.y - plane.y);
      if (v.bed === undefined || Math.abs(v.bed - onPlane) > 1e-6 || Math.abs(carve.heightAt(v.x, v.y) - onPlane) > 1e-6) {
        complaint ??= `kerb at ${v.x.toFixed(1)},${v.y.toFixed(1)}: bed ${v.bed?.toFixed(3)}, plane ${onPlane.toFixed(3)}`;
      }
    }
    expect(complaint).toBeUndefined();
    for (const mouth of junction.mouths) {
      const frame = ribbons.frameAt(mouth.curve, mouth.segment, mouth.at.x, mouth.at.y);
      expect(frame.bank).toBeCloseTo(plane.gx * frame.acrossX + plane.gy * frame.acrossY, 6);
    }
  });

  it('banks the road back to level where the blend ends, on a point of its curve', () => {
    // A road's loft has a section at each point of its curve and none between,
    // so the blend has no knot of its own inside a segment.
    const arterial = world.roads[0] as RoadCurve;
    const last = arterial.points.length - 1;
    const end = ribbons.frameAt(0, last - 1, (arterial.points[last] as { x: number }).x, 0);
    expect(end.bank).toBe(0);
    // The one knot inside the segment is the cut itself.
    const east = junctions.junctions[0]?.mouths.find((m) => m.curve === 0 && m.direction === 1);
    const knots = beds.knotsOf(0, last - 1);
    expect(knots).toHaveLength(3);
    expect((knots[1]?.t ?? 0) * 200).toBeCloseTo(east?.cut ?? -1, 6);
    // Past its cut and short of the end, the road leans part of the way.
    const between = ribbons.frameAt(0, last - 1, 100, 0);
    expect(Math.abs(between.bank)).toBeGreaterThan(0);
    expect(Math.abs(between.bank)).toBeLessThan(Math.hypot(beds.planes[0]?.gx ?? 0, beds.planes[0]?.gy ?? 0));
  });
});

describe('the ground past the end of a steep road', () => {
  // A street ends on a hillside that climbs 15 % along it. A bench levelled
  // past its end is a kink the chunk grid lifts through the last section.
  const roads = [curve(0, [[0, 0], [100, 0], [200, 0]], 'street')];
  const world = hillWorld(roads, (x) => 40 + 0.15 * x);
  const carve = buildCarve(world.terrain, world.roads);

  it('carries the road on at its grade rather than level', () => {
    for (const across of [0, 4, 8]) {
      expect(carve.heightAt(-2, across)).toBeCloseTo(40 - 0.3, 6);
      expect(carve.heightAt(203, across)).toBeCloseTo(40 + 0.15 * 203, 6);
    }
  });
});
