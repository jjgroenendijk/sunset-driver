import type { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildChunkRoads,
  CHUNK_DRAW_CALL_CAP,
  chunkDrawCalls,
  markingsOf,
  partsOf,
  roadSection,
  SURFACE_STRUCTURE,
  TIER_ORDER,
  type SectionPoint,
  type TierGeometry,
} from '../src/render/road-mesh.ts';
import { buildLayers, ChunkSource, CHUNK_SIZE } from '../src/world/chunks.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { RoadRibbons } from '../src/world/ribbon.ts';
import { footprintHalfWidth, TIERS } from '../src/world/tiers.ts';
import type { District, RoadCurve, RoadTier, WorldDescription, Zone } from '../src/world/types.ts';

const SIZE = 800;
const CELL = 10;
/** Metres between the streets of the hand-built grid. */
const BLOCK = 150;
/** Metres two places may stand apart and still be one place. */
const TOLERANCE = 1e-6;

function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

function curve(id: number, coords: readonly [number, number][], tier: RoadTier = 'street'): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [] };
}

/**
 * A hand-built world: a square island under a grid of streets, so the road
 * geometry can be checked without generating one. The ground rises across the
 * map, so a section taken from the wrong place would show in its height.
 */
function gridWorld(roads: RoadCurve[]): WorldDescription {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) {
      hf.set(ix, iy, 20 + hf.worldX(ix) * 0.02 + hf.worldY(iy) * 0.05);
    }
  }
  return {
    seed: 11,
    size: SIZE,
    core: { x: 0, y: 0 },
    terrain: hf.toData(),
    water: {
      seaLevel: 0,
      islands: [{ id: 0, x: 0, y: 0, radius: SIZE / 2, main: true }],
      crossings: [],
      river: { path: [], halfWidths: [] },
      harbour: { x: 0, y: 0, radius: 10 },
    },
    districts: [district(0, 'inner', 0, 0), district(1, 'suburban', 250, 250)],
    beaches: [],
    roads,
    corridors: [],
    tram: { route: [], corridors: [], stops: [], crossings: [], length: 0 },
  };
}

/** The grid of streets `gridWorld` is laid out with, spanning the middle of the map. */
function gridRoads(): RoadCurve[] {
  const roads: RoadCurve[] = [];
  const line = -2 * BLOCK;
  for (let i = 0; i <= 4; i++) {
    const at = line + i * BLOCK;
    roads.push(curve(roads.length, [[at, line], [at, -line]]));
    roads.push(curve(roads.length, [[line, at], [-line, at]]));
  }
  return roads;
}

const world = gridWorld(gridRoads());
const layers = buildLayers(world);
const source = new ChunkSource(world, layers);
const ribbons = new RoadRibbons(world.terrain, world.roads);

/** Every vertex of every part of one tier, as triples. */
function vertices(tier: TierGeometry): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (const part of partsOf(tier)) {
    const position = part.getAttribute('position');
    for (let v = 0; v < position.count; v++) {
      out.push({ x: position.getX(v), y: position.getY(v), z: position.getZ(v) });
    }
  }
  return out;
}

/** The vertices on one line of constant x, as a sorted list of strings. */
function onPlane(tier: TierGeometry, x: number): string[] {
  return vertices(tier)
    .filter((p) => Math.abs(p.x - x) < TOLERANCE)
    .map((p) => `${p.y}:${p.z}`)
    .sort();
}

/** True of a deck, a parapet or a portal: everything that is not a road surface. */
function isStructure(part: BufferGeometry): boolean {
  return part.getAttribute('kind').getX(0) === SURFACE_STRUCTURE;
}

/** Every structure of a tier, over every run of it. */
function structuresOf(tier: TierGeometry): BufferGeometry[] {
  return partsOf(tier).filter(isStructure);
}

function streetOf(chunk: TierGeometry[]): TierGeometry {
  const street = chunk.find((tier) => tier.tier === 'street');
  if (street === undefined) throw new Error('no street in this chunk');
  return street;
}

describe('road cross section', () => {
  it('spans exactly the ground the tier claims', () => {
    for (const tier of TIER_ORDER) {
      const section = roadSection(tier);
      const half = footprintHalfWidth(tier);
      expect((section[0] as SectionPoint).across).toBeCloseTo(-half, 9);
      expect((section[section.length - 1] as SectionPoint).across).toBeCloseTo(half, 9);
      // Across the road the section never turns back on itself, so the loft
      // cannot fold over.
      for (let i = 1; i < section.length; i++) {
        expect((section[i] as SectionPoint).across).toBeGreaterThanOrEqual((section[i - 1] as SectionPoint).across);
      }
      // Both ends drop into the skirt that buries the edge in the ground.
      expect((section[0] as SectionPoint).rise).toBeLessThan(0);
      expect((section[section.length - 1] as SectionPoint).rise).toBeLessThan(0);
    }
  });

  it('keeps the carriageway level from kerb to kerb', () => {
    for (const tier of TIER_ORDER) {
      const section = roadSection(tier);
      const half = TIERS[tier].width / 2;
      // The carriageway is one flat span: nothing stands between the kerbs, and
      // the two edges of it are at the same height.
      expect(section.filter((point) => Math.abs(point.across) < half - TOLERANCE)).toHaveLength(0);
      const left = section.filter((point) => Math.abs(point.across + half) < TOLERANCE && point.rise > 0);
      const right = section.filter((point) => Math.abs(point.across - half) < TOLERANCE && point.rise > 0);
      expect(left.length).toBeGreaterThan(0);
      expect(Math.min(...left.map((point) => point.rise))).toBeCloseTo(
        Math.min(...right.map((point) => point.rise)),
        9,
      );
    }
  });

  it('raises a pavement over the carriageway and lays a verge beside one without', () => {
    // A street has a pavement, so its outer edge stands a kerb above the road.
    const street = roadSection('street');
    expect((street[1] as SectionPoint).rise).toBeGreaterThan((street[2] as SectionPoint).rise * 0 + 0.1);
    // A highway has none, so its verge falls to the ground the bench cut.
    const highway = roadSection('highway');
    expect((highway[1] as SectionPoint).rise).toBe(0);
  });
});

describe('road surface', () => {
  const chunk = source.chunk(0, 0);
  const built = buildChunkRoads(chunk, ribbons);

  it('builds one batch for the one tier the chunk carries', () => {
    expect(built).toHaveLength(1);
    expect(streetOf(built).tier).toBe('street');
    expect(streetOf(built).runs.length).toBe(chunk.roads.length);
  });

  it('stands every section on the bed of the curve it was cut from', () => {
    const section = roadSection('street');
    const street = streetOf(built);
    for (const { run, surfaces } of street.runs) {
      // The grid bends nowhere, so a run is lofted in one piece and its rows
      // are its points in order.
      expect(surfaces).toHaveLength(1);
      const position = (surfaces[0] as BufferGeometry).getAttribute('position');
      for (let point = 0; point < run.points.length; point++) {
        const p = run.points[point] as { x: number; y: number };
        const frame = ribbons.frameAt(run.curve, run.from + Math.max(0, point - 1), p.x, p.y);
        for (let j = 0; j < section.length; j++) {
          const v = point * section.length + j;
          expect(position.getY(v)).toBeCloseTo(frame.height + (section[j] as SectionPoint).rise, 3);
        }
      }
    }
  });

  it('tells the parts of the road apart by how far across it they stand', () => {
    const section = roadSection('street');
    const street = streetOf(built);
    const across = (partsOf(street)[0] as BufferGeometry).getAttribute('across');
    for (let v = 0; v < across.count; v++) {
      expect(across.getX(v)).toBeCloseTo((section[v % section.length] as SectionPoint).across, 5);
    }
  });
});

describe('road seams', () => {
  it('gives two neighbours the same section on the boundary they share', () => {
    const left = streetOf(buildChunkRoads(source.chunk(0, 0), ribbons));
    const right = streetOf(buildChunkRoads(source.chunk(1, 0), ribbons));
    const shared = onPlane(left, CHUNK_SIZE);
    expect(shared.length).toBeGreaterThan(0);
    expect(onPlane(right, CHUNK_SIZE)).toEqual(shared);
  });

  it('carries a dash pattern straight across a boundary', () => {
    const marking = markingsOf('street')[0] as { across: number; dash: number; gap: number };
    const period = marking.dash + marking.gap;
    // The road along y = 0 is one segment from x = -300 to x = 300, so how far
    // along the curve a place is, is how far east of its start it is.
    const start = -2 * BLOCK;
    const painted: [number, number][] = [];
    for (const cx of [0, 1]) {
      const street = streetOf(buildChunkRoads(source.chunk(cx, 0), ribbons));
      const marks = street.markings;
      for (let i = 0; i < marks.length; i += 6) {
        if (Math.abs(marks[i + 2] as number) > TOLERANCE || Math.abs(marks[i + 5] as number) > TOLERANCE) continue;
        painted.push([marks[i] as number, marks[i + 3] as number]);
      }
    }
    painted.sort((a, b) => a[0] - b[0]);
    expect(painted.length).toBeGreaterThan(10);

    // Every piece of paint stands where the pattern measured from the start of
    // the whole curve puts it, whichever chunk drew it.
    const joined: [number, number][] = [];
    for (const piece of painted) {
      const last = joined[joined.length - 1];
      if (last !== undefined && Math.abs(last[1] - piece[0]) < 1e-3) last[1] = piece[1];
      else joined.push([piece[0], piece[1]]);
    }
    for (const [from, to] of joined) {
      const k = Math.round((from - start) / period);
      expect(from - start).toBeCloseTo(k * period, 3);
      expect(to - from).toBeCloseTo(marking.dash, 3);
    }
  });
});

describe('bridges and tunnels', () => {
  /** One straight road across the map, with a deck over its middle and a bore past it. */
  const spanned = curve(0, [
    [-300, 0],
    [-100, 0],
    [0, 0],
    [100, 0],
    [300, 0],
  ]);
  spanned.bridges = [1];
  spanned.tunnels = [2];
  const spannedWorld = gridWorld([spanned]);
  const spannedSource = new ChunkSource(spannedWorld, buildLayers(spannedWorld));
  const spannedRibbons = new RoadRibbons(spannedWorld.terrain, spannedWorld.roads);

  it('knows which segments stand off the ground', () => {
    expect(spannedRibbons.isBridge(0, 1)).toBe(true);
    expect(spannedRibbons.isTunnel(0, 2)).toBe(true);
    expect(spannedRibbons.isOnGround(0, 0)).toBe(true);
    expect(spannedRibbons.isOnGround(0, 1)).toBe(false);
  });

  it('hangs a deck with a parapet each side under the bridged stretch', () => {
    // Chunk (-1, 0) covers x in [-250, 0), which is the whole deck.
    const street = streetOf(buildChunkRoads(spannedSource.chunk(-1, 0), spannedRibbons));
    // The surface of the run, then the deck and its two parapets.
    expect(partsOf(street)).toHaveLength(4);
    expect(structuresOf(street)).toHaveLength(3);
    const bed = spannedRibbons.frameAt(0, 1, -100, 0).height;
    const under = vertices(street).filter((p) => Math.abs(p.x + 100) < TOLERANCE && p.y < bed - 1);
    expect(under.length).toBeGreaterThan(0);
  });

  it('frames a bore at both of its mouths and nowhere else', () => {
    // The bore runs from x = 0 to x = 100, so both mouths fall in chunk (0, 0).
    const here = streetOf(buildChunkRoads(spannedSource.chunk(0, 0), spannedRibbons));
    expect(partsOf(here)).toHaveLength(3);
    expect(structuresOf(here)).toHaveLength(2);
    const bed = spannedRibbons.frameAt(0, 2, 50, 0).height;
    // A portal stands well clear of the road it frames.
    expect(vertices(here).filter((p) => p.y > bed + 4).length).toBeGreaterThan(0);
    // The chunk beyond the far mouth carries the road on with nothing over it.
    const beyond = streetOf(buildChunkRoads(spannedSource.chunk(1, 0), spannedRibbons));
    expect(structuresOf(beyond)).toHaveLength(0);
  });
});

describe('draw calls', () => {
  it('costs a batch and a line mesh for each tier a chunk carries', () => {
    const chunk = source.chunk(0, 0);
    // One ground mesh, one batch of streets, one of their markings.
    expect(chunkDrawCalls(chunk)).toBe(3);
    expect(chunkDrawCalls(source.chunk(9, 9))).toBe(1);
  });

  it('stays inside the cap on every chunk of the map', () => {
    const reach = Math.ceil(SIZE / 2 / CHUNK_SIZE);
    for (let cy = -reach; cy <= reach; cy++) {
      for (let cx = -reach; cx <= reach; cx++) {
        expect(chunkDrawCalls(source.chunk(cx, cy))).toBeLessThanOrEqual(CHUNK_DRAW_CALL_CAP);
      }
    }
  });
});
