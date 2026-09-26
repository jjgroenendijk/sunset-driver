import type { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { buildChunkRoads, partsOf, trimRun, type TierGeometry } from '../src/render/road-mesh.ts';
import { junctionPlane, RoadBeds } from '../src/world/bed.ts';
import { buildCarve } from '../src/world/carve.ts';
import { buildLayers, ChunkSource } from '../src/world/chunks.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { junctionShape } from '../src/world/junction-shape.ts';
import { buildJunctions, FILLET_RADIUS, MAX_CUT, type Junction } from '../src/world/junctions.ts';
import { RoadRibbons } from '../src/world/ribbon.ts';
import { footprintHalfWidth, TIERS } from '../src/world/tiers.ts';
import type { District, Point, RoadCurve, RoadTier, WorldDescription, Zone } from '../src/world/types.ts';
import { withNodes } from './helpers.ts';
import { compareStrings } from '../src/core/sort.ts';

const SIZE = 800;
const CELL = 10;
/** Metres two places may stand apart and still be one place. */
const TOLERANCE = 1e-6;

function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

function curve(id: number, coords: readonly [number, number][], tier: RoadTier = 'street'): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [], nodes: [] };
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

/** Each vertex of a geometry as a key that two vertices at one place share. */
function vertexKeys(geometry: BufferGeometry): string[] {
  const position = geometry.getAttribute('position');
  const keys: string[] = [];
  for (let v = 0; v < position.count; v++) {
    keys.push(`${position.getX(v).toFixed(4)}:${position.getY(v).toFixed(4)}:${position.getZ(v).toFixed(4)}`);
  }
  return keys;
}

describe('junction model', () => {
  it('finds a junction at every node where roads meet, and none where they only cross or end', () => {
    // The crossing, the T, and no junction at the four free ends.
    expect(junctions.junctions.map((junction) => `${junction.x},${junction.y}`).sort(compareStrings)).toEqual(['0,0', '100,0']);
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

describe('junction plane fit', () => {
  const mouth = (dx: number, dy: number, cut: number): Junction['mouths'][number] => ({
    curve: 0,
    tier: 'street',
    point: 0,
    direction: 1,
    dx,
    dy,
    cut,
    at: { x: dx * cut, y: dy * cut },
    segment: 0,
    lift: 0,
    liftAtCut: 0,
  });

  it('holds a long mouth near its own bed and lets a short one give way', () => {
    // Two mouths along x disagree: the long one east climbs 10 %, the short
    // one west climbs 10 % too, which is a fall along x. A grade fit would
    // split them and level the plane; a height fit follows the long mouth.
    const ground = (x: number): number => (x > 0 ? 0.1 * x : -0.1 * x);
    const plane = junctionPlane((x) => ground(x), { x: 0, y: 0 }, [mouth(1, 0, 27), mouth(-1, 0, 2)]);
    const miss = (x: number): number => Math.abs(plane.level + plane.gx * x - ground(x));
    // The long mouth's cut stands within centimetres of its bed, not 2.7 m off.
    expect(miss(27)).toBeLessThan(0.2);
  });
});

describe('junction geometry', () => {
  const layers = buildLayers(world);
  const source = new ChunkSource(world, layers);
  const ribbons = new RoadRibbons(world.terrain, world.roads, layers.junctions);
  const heightAt = (x: number, y: number, tier: RoadTier): number => layers.carve.surfaceAt(x, y, tier);
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

  it('paves the junction as the widest road that meets there, and nothing but its carriageway', () => {
    const arterial = tierOf('arterial');
    // The crossing at the origin is on the boundary of chunk (0, 0), which
    // owns it; the T is inside it. Each is one carriageway, paved as arterial:
    // the pavement round the corners is cut out of the blocks (issue #266).
    expect(arterial.junctions).toHaveLength(2);
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
      for (const key of vertexKeys(part)) junctionVertices.add(key);
    }
    let met = 0;
    for (const tier of [arterial, street]) {
      for (const { surfaces } of tier.runs) {
        for (const surface of surfaces as BufferGeometry[]) {
          met += vertexKeys(surface).filter((key) => junctionVertices.has(key)).length;
        }
      }
    }
    // The two kerbs of every mouth section, at four mouths of the crossing and
    // three of the T, less the mouths whose cut lies outside the chunk and its
    // runs.
    expect(met).toBeGreaterThanOrEqual(2 * 3);
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

describe('junction carriageway', () => {
  /** The turn of the first street off the arterial, past a right angle. */
  const TURN = (120 * Math.PI) / 180;
  // Mouths that turn more than a right angle apart, and a pair that leave at a
  // shallow angle, with two widths between them: an arterial along x, a street
  // leaving at 120 degrees and another leaving at 160. Every road is straight,
  // so each mouth is cut on the segment it leaves the node on (issue #299).
  const turns = [
    curve(0, [[-200, 0], [0, 0], [200, 0]], 'arterial'),
    curve(1, [[0, 0], [100 * Math.cos(TURN), 100 * Math.sin(TURN)]]),
    curve(2, [[0, 0], [-93.97, 34.2]]),
  ];
  const turning = hillWorld(turns);
  const map = buildJunctions(turning.roads, buildRoadGraph(turning.roads));
  const ribbons = new RoadRibbons(turning.terrain, turning.roads, map);

  /** Metres a sample is held inside the carriageway it is drawn from, so rounding does not decide it. */
  const INSET = 1e-4;

  /** True inside any triangle of the fan from the node, whichever way it winds. */
  function inFan(ring: readonly Point[], node: Point, p: Point): boolean {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j] as Point;
      const b = ring[i] as Point;
      const area = (a.x - node.x) * (b.y - node.y) - (a.y - node.y) * (b.x - node.x);
      if (area === 0) continue;
      const d1 = (a.x - node.x) * (p.y - node.y) - (a.y - node.y) * (p.x - node.x);
      const d2 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const d3 = (node.x - b.x) * (p.y - b.y) - (node.y - b.y) * (p.x - b.x);
      if (area > 0 ? d1 >= 0 && d2 >= 0 && d3 >= 0 : d1 <= 0 && d2 <= 0 && d3 <= 0) return true;
    }
    return false;
  }

  it('cuts a mouth back past the kerbs its neighbours start on', () => {
    const junction = map.junctions.find((j) => Math.hypot(j.x, j.y) < TOLERANCE) as Junction;
    expect(junction.mouths).toHaveLength(4);
    const east = junction.mouths.find((m) => m.curve === 0 && m.direction === 1) as Junction['mouths'][number];
    // Past a right angle the street starts its right kerb further along the
    // arterial than the two kerb lines meet, so that reach is what cuts the
    // arterial back, and the corner between them no longer does.
    expect(east.cut).toBeCloseTo((TIERS.street.width / 2) * Math.sin(TURN), 6);
    expect(east.cut).toBeLessThanOrEqual(MAX_CUT);
  });

  /**
   * A street along x that bends a few metres out, and an arterial through the
   * node at 120 degrees to it. The street may not be cut past its straight run,
   * so it cannot be cut far enough to hold the kerb the arterial starts on, and
   * the ring has to take that kerb in itself.
   */
  const bent = [
    curve(0, [[0, 0], [3, 0], [60, 40]]),
    curve(1, [[60, -103.92], [0, 0], [-60, 103.92]], 'arterial'),
  ];
  const bending = hillWorld(bent);
  const bentMap = buildJunctions(bending.roads, buildRoadGraph(bending.roads));
  const bentRibbons = new RoadRibbons(bending.terrain, bending.roads, bentMap);

  /** The places of a mouth's carriageway the fan has to hold, a hair inside it. */
  function samples(node: Point, mouth: Junction['mouths'][number]): Point[] {
    const kerb = TIERS[mouth.tier].width / 2 - INSET;
    const out: Point[] = [];
    for (let a = 0; a <= 16; a++) {
      for (let c = -16; c <= 16; c++) {
        const along = INSET + ((mouth.cut - 2 * INSET) * a) / 16;
        const across = (kerb * c) / 16;
        out.push({
          x: node.x + mouth.dx * along - mouth.dy * across,
          y: node.y + mouth.dy * along + mouth.dx * across,
        });
      }
    }
    return out;
  }

  it('takes in a kerb the mouth beside it is cut too short to hold', () => {
    const junction = bentMap.junctions.find((j) => Math.hypot(j.x, j.y) < TOLERANCE) as Junction;
    const street = junction.mouths.find((m) => m.curve === 0) as Junction['mouths'][number];
    // The arterial starts its kerb this far along the street, and the street's
    // own bend stops it being cut anywhere near that.
    expect(street.cut).toBeLessThan((TIERS.arterial.width / 2) * Math.sin(TURN));
    const ring = junctionShape(junction, bentRibbons).carriageway;
    const node: Point = { x: junction.x, y: junction.y };
    const bare: string[] = [];
    // The street's own carriageway bends inside its cut, which is issue #542;
    // the arterial's is straight and the fan has to hold all of it.
    for (const mouth of junction.mouths.filter((m) => m.curve === 1)) {
      for (const p of samples(node, mouth)) if (!inFan(ring, node, p)) bare.push(`curve ${mouth.curve} at ${p.x},${p.y}`);
    }
    expect(bare).toEqual([]);
  });

  /** Places a hair inside a mouth's carriageway along its own curve, from the node to its cut. */
  function curveSamples(points: readonly Point[], mouth: Junction['mouths'][number]): Point[] {
    const line: Point[] = [points[mouth.point] as Point];
    for (let k = mouth.point + mouth.direction; mouth.direction > 0 ? k <= mouth.segment : k > mouth.segment; k += mouth.direction) {
      line.push(points[k] as Point);
    }
    line.push(mouth.at);
    const kerb = TIERS[mouth.tier].width / 2 - 0.01;
    const out: Point[] = [];
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i] as Point;
      const b = line[i + 1] as Point;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const nx = -(b.y - a.y) / length;
      const ny = (b.x - a.x) / length;
      for (let t = 0.05; t < 1; t += 0.1) {
        for (let c = -8; c <= 8; c++) {
          const across = (kerb * c) / 8;
          out.push({ x: a.x + (b.x - a.x) * t + nx * across, y: a.y + (b.y - a.y) * t + ny * across });
        }
      }
    }
    return out;
  }

  it('covers a mouth that bends inside its cut along its own curve (issue #676, E1)', () => {
    const junction = bentMap.junctions.find((j) => Math.hypot(j.x, j.y) < TOLERANCE) as Junction;
    const street = junction.mouths.find((m) => m.curve === 0) as Junction['mouths'][number];
    // The street is cut past its bend, so its carriageway is two strips.
    expect(street.segment).toBe(1);
    const ring = junctionShape(junction, bentRibbons).carriageway;
    const node: Point = { x: junction.x, y: junction.y };
    const points = (bending.roads[0] as RoadCurve).points;
    const bare = curveSamples(points, street).filter((p) => !inFan(ring, node, p));
    expect(bare).toEqual([]);
  });

  it('draws a ring that never crosses itself, turning one way round the node', () => {
    for (const [junctions, ribbonsOf] of [
      [map.junctions, ribbons],
      [bentMap.junctions, bentRibbons],
    ] as const) {
      for (const junction of junctions) {
        const ring = junctionShape(junction, ribbonsOf).carriageway;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i] as Point;
          const b = ring[(i + 1) % ring.length] as Point;
          // Every edge turns anticlockwise about the node, so the fan is the ring.
          expect((a.x - junction.x) * (b.y - junction.y) - (a.y - junction.y) * (b.x - junction.x)).toBeGreaterThanOrEqual(-1e-9);
        }
      }
    }
  });

  it('covers the whole of every mouth carriageway between the node and its cut', () => {
    const bare: string[] = [];
    for (const junction of map.junctions) {
      const ring = junctionShape(junction, ribbons).carriageway;
      const node: Point = { x: junction.x, y: junction.y };
      for (const mouth of junction.mouths) {
        for (const p of samples(node, mouth)) if (!inFan(ring, node, p)) bare.push(`node ${junction.node} curve ${mouth.curve} at ${p.x},${p.y}`);
      }
    }
    expect(bare).toEqual([]);
  });
});
