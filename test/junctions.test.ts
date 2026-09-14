import type { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { buildChunkRoads, partsOf, trimRun, type TierGeometry } from '../src/render/road-mesh.ts';
import { RoadBeds } from '../src/world/bed.ts';
import { buildCarve } from '../src/world/carve.ts';
import { buildLayers, ChunkSource } from '../src/world/chunks.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { buildJunctions, FILLET_RADIUS, MAX_CUT, type Junction } from '../src/world/junctions.ts';
import { RoadRibbons } from '../src/world/ribbon.ts';
import { footprintHalfWidth, TIERS } from '../src/world/tiers.ts';
import type { District, Point, RoadCurve, RoadTier, WorldDescription, Zone } from '../src/world/types.ts';

const SIZE = 800;
const CELL = 10;
/** Metres two places may stand apart and still be one place. */
const TOLERANCE = 1e-6;

function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

function curve(id: number, coords: readonly [number, number][], tier: RoadTier = 'street'): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [] };
}

/**
 * A hand-built world on a hillside that climbs along x, so a road running
 * along x has a grade and one running along y is level. The roads share
 * points where they meet, which is what makes a junction.
 */
function hillWorld(roads: RoadCurve[]): WorldDescription {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) hf.set(ix, iy, 20 + hf.worldX(ix) * 0.1);
  }
  return {
    seed: 5,
    size: SIZE,
    archetype: 'archipelago',
    core: { x: 0, y: 0 },
    terrain: hf.toData(),
    water: {
      seaLevel: 0,
      islands: [{ id: 0, x: 0, y: 0, radius: SIZE / 2, main: true }],
      crossings: [],
      river: { path: [], halfWidths: [] },
      harbour: { x: 0, y: 0, radius: 10 },
    },
    districts: [district(0, 'inner', 0, 0)],
    beaches: [],
    roads,
    corridors: [],
    tram: { route: [], corridors: [], stops: [], crossings: [], length: 0 },
  };
}

/**
 * An arterial along x through the origin, a street across it along y through
 * the origin (a crossing), and a street that ends on the arterial at x = 100
 * from the north (a T). The arterial carries the shared points.
 */
const roads = [
  curve(0, [[-200, 0], [0, 0], [100, 0], [200, 0]], 'arterial'),
  curve(1, [[0, -200], [0, 0], [0, 200]]),
  curve(2, [[100, 200], [100, 0]]),
];
const world = hillWorld(roads);
const graph = buildRoadGraph(world.roads);
const junctions = buildJunctions(world.roads, graph);

function junctionAt(x: number, y: number): Junction {
  const found = junctions.junctions.find((junction) => Math.hypot(junction.x - x, junction.y - y) < TOLERANCE);
  if (found === undefined) throw new Error(`no junction at ${x}, ${y}`);
  return found;
}

describe('junction model', () => {
  it('finds a junction at every node where roads meet, and none where they only cross or end', () => {
    // The crossing, the T, and no junction at the four free ends.
    expect(junctions.junctions.map((junction) => `${junction.x},${junction.y}`).sort()).toEqual(['0,0', '100,0']);
    expect(junctionAt(0, 0).mouths).toHaveLength(4);
    expect(junctionAt(100, 0).mouths).toHaveLength(3);
  });

  it('cuts each road back past the other road and round the corner', () => {
    // At a right-angled crossing the kerbs meet at the other road's kerb, and
    // the fillet adds its tangent length to that.
    const crossing = junctionAt(0, 0);
    const arterialKerb = TIERS.arterial.width / 2;
    const streetKerb = TIERS.street.width / 2;
    const fillet = Math.min(FILLET_RADIUS, arterialKerb, streetKerb);
    for (const mouth of crossing.mouths) {
      const other = mouth.tier === 'arterial' ? streetKerb : arterialKerb;
      expect(mouth.cut).toBeCloseTo(other + fillet, 6);
      expect(mouth.cut).toBeLessThanOrEqual(MAX_CUT);
      expect(Math.hypot(mouth.at.x - crossing.x, mouth.at.y - crossing.y)).toBeCloseTo(mouth.cut, 6);
    }
    // At the T the through road is cut on both sides, and the road that ends
    // there is cut past the arterial's kerb.
    const tee = junctionAt(100, 0);
    const stub = tee.mouths.find((mouth) => mouth.curve === 2);
    expect(stub?.cut).toBeCloseTo(arterialKerb + fillet, 6);
    for (const mouth of tee.mouths.filter((m) => m.curve === 0)) expect(mouth.cut).toBeCloseTo(streetKerb + fillet, 6);
  });

  it('orders the mouths anticlockwise and runs each corner from one mouth to the next', () => {
    const crossing = junctionAt(0, 0);
    const angles = crossing.mouths.map((mouth) => Math.atan2(mouth.dy, mouth.dx));
    for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeGreaterThan(angles[i - 1] as number);
    expect(crossing.corners).toHaveLength(crossing.mouths.length);
    for (let i = 0; i < crossing.mouths.length; i++) {
      const a = crossing.mouths[i] as Junction['mouths'][number];
      const b = crossing.mouths[(i + 1) % crossing.mouths.length] as Junction['mouths'][number];
      const corner = crossing.corners[i] as Junction['corners'][number];
      // A convex corner is rounded: several kerb points, the first on the left
      // kerb line of the first mouth and the last on the right kerb line of the
      // next, and the back of the pavement is one point behind them.
      expect(corner.kerb.length).toBeGreaterThan(2);
      const first = corner.kerb[0] as Point;
      const last = corner.kerb[corner.kerb.length - 1] as Point;
      const aKerb = TIERS[a.tier].width / 2;
      const bKerb = TIERS[b.tier].width / 2;
      expect(-a.dy * (first.x - crossing.x) + a.dx * (first.y - crossing.y)).toBeCloseTo(aKerb, 6);
      expect(-b.dy * (last.x - crossing.x) + b.dx * (last.y - crossing.y)).toBeCloseTo(-bKerb, 6);
      expect(corner.outer).toHaveLength(1);
      const outer = corner.outer[0] as Point;
      expect(-a.dy * (outer.x - crossing.x) + a.dx * (outer.y - crossing.y)).toBeCloseTo(footprintHalfWidth(a.tier), 6);
      expect(corner.tier).toBe('arterial');
    }
  });

  it('lists the gaps of each curve ascending, not overlapping, and joined where they touch', () => {
    // The arterial passes through both junctions, so it carries one gap per
    // junction, each running from one cut to the other through the node.
    const arterial = junctions.gaps[0] as (typeof junctions.gaps)[number];
    expect(arterial).toHaveLength(2);
    for (let i = 0; i < arterial.length; i++) {
      const gap = arterial[i] as (typeof arterial)[number];
      expect(gap.to.distance).toBeGreaterThan(gap.from.distance);
      if (i > 0) expect(gap.from.distance).toBeGreaterThan((arterial[i - 1] as (typeof arterial)[number]).to.distance);
    }
    const first = arterial[0] as (typeof arterial)[number];
    const west = junctionAt(0, 0).mouths.find((m) => m.curve === 0 && m.direction === -1) as Junction['mouths'][number];
    const east = junctionAt(0, 0).mouths.find((m) => m.curve === 0 && m.direction === 1) as Junction['mouths'][number];
    expect(first.from.at.x).toBeCloseTo(-west.cut, 6);
    expect(first.to.at.x).toBeCloseTo(east.cut, 6);
    // The stub ends at the T, so its gap reaches the end of the curve.
    const stub = junctions.gaps[2] as (typeof junctions.gaps)[number];
    expect(stub).toHaveLength(1);
    expect((stub[0] as (typeof stub)[number]).to.at).toEqual({ x: 100, y: 0 });
  });

  it('takes no junction where two roads carry straight on into each other', () => {
    const inLine = hillWorld([curve(0, [[-100, 0], [0, 0]]), curve(1, [[0, 0], [100, 0]]), curve(2, [[0, 0], [0, 100]])]);
    const built = buildJunctions(inLine.roads, buildRoadGraph(inLine.roads));
    // The T at the origin is a junction; the two ends of the straight pair
    // meet nothing else and take none.
    expect(built.junctions).toHaveLength(1);
    const straight = hillWorld([curve(0, [[-100, 0], [0, 0]]), curve(1, [[0, 0], [100, 0]])]);
    expect(buildJunctions(straight.roads, buildRoadGraph(straight.roads)).junctions).toHaveLength(0);
  });
});

describe('junction plane', () => {
  const beds = new RoadBeds(world.terrain, world.roads, junctions);
  const carve = buildCarve(world.terrain, world.roads, junctions);
  const hf = new Heightfield(world.terrain);

  it('levels the junction to one plane the beds of every mouth lie on', () => {
    const crossing = junctionAt(0, 0);
    const plane = beds.planes[junctions.junctions.indexOf(crossing)] as (typeof beds.planes)[number];
    // The hill climbs along x, so the plane tilts along the arterial and is
    // level along the street.
    expect(plane.gx).toBeCloseTo(0.1, 6);
    expect(plane.gy).toBeCloseTo(0, 6);
    expect(plane.level).toBeCloseTo(hf.sample(0, 0), 6);
    // The bed of each mouth at its cut is the plane's height there, and so
    // is the carved ground under every point of the junction's outline.
    for (const mouth of crossing.mouths) {
      const expected = plane.level + plane.gx * (mouth.at.x - plane.x) + plane.gy * (mouth.at.y - plane.y);
      const ribbons = new RoadRibbons(world.terrain, world.roads, junctions);
      expect(ribbons.frameAt(mouth.curve, mouth.segment, mouth.at.x, mouth.at.y).height).toBeCloseTo(expected, 6);
    }
    for (const p of crossing.outline) {
      expect(carve.heightAt(p.x, p.y)).toBeCloseTo(plane.level + plane.gx * (p.x - plane.x) + plane.gy * (p.y - plane.y), 6);
    }
  });

  it('brings a road back onto its own line past its cut and leaves the rest alone', () => {
    // The street across the hill is level on the plane but its own line is
    // level too, so it never leaves it; the arterial climbs the hill on both
    // sides and is back on the natural ground two cuts out.
    const crossing = junctionAt(0, 0);
    const east = crossing.mouths.find((m) => m.curve === 0 && m.direction === 1) as Junction['mouths'][number];
    expect(beds.heightAt(0, 1, (2 * east.cut) / 100)).toBeCloseTo(hf.sample(2 * east.cut, 0), 6);
    expect(beds.pointHeight(1, 0)).toBeCloseTo(hf.sample(0, -200), 6);
    expect(carve.heightAt(0, -150)).toBeCloseTo(hf.sample(0, -150), 6);
  });
});

describe('junction geometry', () => {
  const layers = buildLayers(world);
  const source = new ChunkSource(world, layers);
  const ribbons = new RoadRibbons(world.terrain, world.roads, layers.junctions);
  const heightAt = (x: number, y: number): number => layers.carve.heightAt(x, y);
  const chunk = source.chunk(0, 0);
  const built = buildChunkRoads(chunk, ribbons, heightAt);

  function tierOf(tier: RoadTier): TierGeometry {
    const found = built.find((entry) => entry.tier === tier);
    if (found === undefined) throw new Error(`no ${tier} in this chunk`);
    return found;
  }

  it('cuts a run short of the junctions it meets', () => {
    // The arterial runs through the chunk from x = 0 to its end at x = 200 and
    // meets the T at x = 100, so it comes back in two runs: one from the
    // crossing's cut to the T's, and one from the T's far cut to its end.
    const arterial = chunk.roads.find((run) => run.curve === 0) as (typeof chunk.roads)[number];
    const runs = trimRun(arterial, ribbons);
    expect(runs).toHaveLength(2);
    const tee = junctionAt(100, 0);
    const west = tee.mouths.find((m) => m.curve === 0 && m.direction === -1) as Junction['mouths'][number];
    const east = tee.mouths.find((m) => m.curve === 0 && m.direction === 1) as Junction['mouths'][number];
    const [first, second] = runs as [(typeof runs)[number], (typeof runs)[number]];
    expect(first.points[first.points.length - 1]).toEqual(west.at);
    expect(second.points[0]).toEqual(east.at);
    expect(second.points[second.points.length - 1]?.x).toBe(200);
    // Each run still knows which curve segment it starts on.
    expect(first.from).toBe(1);
    expect(second.from).toBe(2);
    expect(second.gaps).toHaveLength(0);
  });

  it('paves the junction as the widest road that meets there and puts its corners in the batch of the wider road', () => {
    const arterial = tierOf('arterial');
    // The crossing at the origin is on the boundary of chunk (0, 0), which
    // owns it; the T is inside it. Each has a carriageway and four or three
    // corners, all paved as arterial.
    expect(arterial.junctions).toHaveLength(1 + 4 + 1 + 3);
    expect(built.find((entry) => entry.tier === 'street')?.junctions ?? []).toHaveLength(0);
    for (const part of arterial.junctions) {
      const position = part.getAttribute('position');
      const normal = part.getAttribute('normal');
      expect(position.count).toBeGreaterThanOrEqual(3);
      for (let v = 0; v < position.count; v++) {
        expect(Number.isFinite(position.getX(v) + position.getY(v) + position.getZ(v))).toBe(true);
        expect(normal.getY(v)).toBe(1);
      }
      expect(part.getAttribute('across')).toBeDefined();
      expect(part.getAttribute('kind')).toBeDefined();
    }
  });

  it('meets each mouth on the section the road loft ends with', () => {
    // The kerb corners of the junction carriageway at the T stand exactly
    // where the arterial's and the street's lofts stop, so there is no seam.
    const arterial = tierOf('arterial');
    const street = tierOf('street');
    const junctionVertices = new Set<string>();
    for (const part of arterial.junctions) {
      const position = part.getAttribute('position');
      for (let v = 0; v < position.count; v++) {
        junctionVertices.add(`${position.getX(v).toFixed(4)}:${position.getY(v).toFixed(4)}:${position.getZ(v).toFixed(4)}`);
      }
    }
    let met = 0;
    for (const tier of [arterial, street]) {
      for (const { surfaces } of tier.runs) {
        for (const surface of surfaces as BufferGeometry[]) {
          const position = surface.getAttribute('position');
          for (let v = 0; v < position.count; v++) {
            if (junctionVertices.has(`${position.getX(v).toFixed(4)}:${position.getY(v).toFixed(4)}:${position.getZ(v).toFixed(4)}`)) met++;
          }
        }
      }
    }
    // Four corners of every mouth section: two kerbs and two outer edges, at
    // four mouths of the crossing and three of the T, less the mouths whose
    // cut lies outside the chunk and its runs.
    expect(met).toBeGreaterThanOrEqual(4 * 3);
  });

  it('faces every junction surface up', () => {
    for (const tier of built) {
      for (const part of partsOf(tier)) {
        const index = part.getIndex();
        const position = part.getAttribute('position');
        if (index === null || part.getAttribute('kind').getX(0) !== 0 || !tier.junctions.includes(part)) continue;
        for (let i = 0; i + 2 < index.count; i += 3) {
          const a = index.getX(i);
          const b = index.getX(i + 1);
          const c = index.getX(i + 2);
          const up =
            (position.getX(b) - position.getX(a)) * (position.getZ(c) - position.getZ(a)) -
            (position.getZ(b) - position.getZ(a)) * (position.getX(c) - position.getX(a));
          expect(up).toBeLessThanOrEqual(0);
        }
      }
    }
  });
});
