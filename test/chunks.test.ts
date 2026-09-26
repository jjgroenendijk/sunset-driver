import { describe, expect, it } from 'vitest';
import { pointInRegion, regionArea } from '../src/core/geom.ts';
import { lotMiddle } from '../src/world/buildings.ts';
import {
  buildLayers,
  ChunkSource,
  chunkAt,
  chunkBounds,
  CHUNK_SIZE,
  type WorldChunk,
} from '../src/world/chunks.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { RoadRibbons } from '../src/world/ribbon.ts';
import type { District, Point, RoadCurve, WorldDescription, Zone } from '../src/world/types.ts';
import { stableJson, withNodes } from './helpers.ts';
import { compareStrings } from '../src/core/sort.ts';

const SIZE = 1000;
const CELL = 10;
/** Metres between the streets of the hand-built grid. */
const BLOCK = 200;
/** Metres two places may stand apart and still be one place. */
const TOLERANCE = 1e-6;
/**
 * Metres a corner may move when a parcel is cut to a chunk: the polygon engine
 * rounds every corner onto its millimetre grid and snaps one that lands beside
 * an edge onto it.
 */
const CUT_SLACK = 2e-3;

function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

function curve(id: number, coords: readonly [number, number][]): RoadCurve {
  return { id, tier: 'street', points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [], nodes: [] };
}

/**
 * A hand-built world: a flat square island with a grid of streets on it, so the
 * chunk cutting can be checked without generating one. The heights slope a
 * little, so a terrain slice that came back from the wrong place would show.
 */
function gridWorld(): WorldDescription {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) hf.set(ix, iy, 20 + hf.worldX(ix) * 0.01 + hf.worldY(iy) * 0.003);
  }
  const roads: RoadCurve[] = [];
  const line = -2 * BLOCK;
  for (let i = 0; i <= 4; i++) {
    const at = line + i * BLOCK;
    roads.push(curve(roads.length, [[at, line], [at, -line]]));
    roads.push(curve(roads.length, [[line, at], [-line, at]]));
  }
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
    districts: [district(0, 'inner', 0, 0), district(1, 'suburban', 300, 300)],
    beaches: [],
    airfields: [],
    roads: withNodes(roads),
    corridors: [],
    tram: { route: [], edges: [], corridors: [], stops: [], crossings: [], length: 0 },
  };
}

/** Metres along a polyline. */
function runLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** Every chunk the map reaches into, in a fixed order. */
function everyChunk(world: WorldDescription, source: ChunkSource): WorldChunk[] {
  const span = Math.ceil(world.size / 2 / CHUNK_SIZE);
  const chunks: WorldChunk[] = [];
  for (let cx = -span; cx < span; cx++) {
    for (let cy = -span; cy < span; cy++) chunks.push(source.chunk(cx, cy));
  }
  return chunks;
}

const world = gridWorld();
const layers = buildLayers(world);
const source = new ChunkSource(world, layers);

describe('chunk grid', () => {
  it('anchors the chunk grid on the origin', () => {
    expect(chunkAt(0, 0)).toEqual({ cx: 0, cy: 0 });
    expect(chunkAt(CHUNK_SIZE - 1, 1)).toEqual({ cx: 0, cy: 0 });
    expect(chunkAt(-1, -CHUNK_SIZE)).toEqual({ cx: -1, cy: -1 });
    const bounds = chunkBounds(3, -2);
    expect(bounds).toEqual({
      minX: 3 * CHUNK_SIZE,
      minY: -2 * CHUNK_SIZE,
      maxX: 4 * CHUNK_SIZE,
      maxY: -CHUNK_SIZE,
    });
    // Every place a chunk covers is a place `chunkAt` sends back to it.
    expect(chunkAt(bounds.minX, bounds.minY)).toEqual({ cx: 3, cy: -2 });
    expect(chunkAt(bounds.maxX - TOLERANCE, bounds.maxY - TOLERANCE)).toEqual({ cx: 3, cy: -2 });
  });
});

describe('chunk terrain', () => {
  it('carves the roads into the heights it takes off the world heightfield', () => {
    const hf = new Heightfield(world.terrain);
    const chunk = source.chunk(1, -1);
    const slice = new Heightfield(chunk.terrain);
    expect(slice.originX).toBe(chunk.bounds.minX);
    expect(slice.originY).toBe(chunk.bounds.minY);
    expect(slice.extent).toBe(CHUNK_SIZE);
    expect(chunk.seaLevel).toBe(world.water.seaLevel);
    let carvedNodes = 0;
    for (let iy = 0; iy < slice.gridSize; iy++) {
      for (let ix = 0; ix < slice.gridSize; ix++) {
        const x = slice.worldX(ix);
        const y = slice.worldY(iy);
        // The heights are kept as 32-bit floats, so they agree to a tenth of a
        // millimetre rather than to the last bit.
        expect(slice.at(ix, iy)).toBeCloseTo(layers.carve.heightAt(x, y), 4);
        // Ground no road reaches is the ground the world was given.
        if (layers.carve.roadAt(x, y) === -1) expect(slice.at(ix, iy)).toBeCloseTo(hf.sample(x, y), 4);
        else carvedNodes++;
      }
    }
    expect(carvedNodes).toBeGreaterThan(0);
  });

  it('levels the ground across a street on the slope', () => {
    // The world is a plane tilted 1 % along x, so a street running down y sits
    // in a bench: the ground either side of it comes back at the height of the
    // street's own surface rather than at the height of the hillside. The
    // street has a point only at each junction, so the whole block between two
    // of them is in a mouth's blend, and the surface there still leans a little
    // the way the junction planes do.
    const hf = new Heightfield(world.terrain);
    const street = -2 * BLOCK;
    // Midway between two of the cross streets, so only the one street is near.
    const along = BLOCK / 2;
    const road = world.roads[0] as RoadCurve;
    const segment = road.points.findIndex((p, i) => p.y <= along && (road.points[i + 1]?.y ?? -Infinity) > along);
    const frame = new RoadRibbons(world.terrain, world.roads, layers.junctions).frameAt(road.id, segment, street, along);
    const bed = hf.sample(street, along);
    expect(frame.height).toBeCloseTo(bed, 2);
    for (const off of [-8, -4, 4, 8]) {
      const surface = frame.height + frame.bank * off * frame.acrossX;
      expect(layers.carve.heightAt(street + off, along)).toBeCloseTo(surface, 4);
      // The natural ground there is not level with it, so the bench is the
      // carve's doing and not the terrain's.
      expect(Math.abs(hf.sample(street + off, along) - bed)).toBeGreaterThan(0.03);
    }
    // Out past the blend the hillside is untouched.
    expect(layers.carve.heightAt(street + 40, along)).toBeCloseTo(hf.sample(street + 40, along), 6);
  });

  it('gives two neighbours the same heights along the edge they share', () => {
    const left = new Heightfield(source.chunk(0, 0).terrain);
    const right = new Heightfield(source.chunk(1, 0).terrain);
    const last = left.gridSize - 1;
    for (let iy = 0; iy < left.gridSize; iy++) expect(right.at(0, iy)).toBe(left.at(last, iy));
    const below = new Heightfield(source.chunk(0, -1).terrain);
    for (let ix = 0; ix < left.gridSize; ix++) expect(below.at(ix, last)).toBe(left.at(ix, 0));
  });
});

describe('chunk roads', () => {
  const chunks = everyChunk(world, source);

  it('keeps every run inside the chunk it belongs to', () => {
    for (const chunk of chunks) {
      for (const run of chunk.roads) {
        expect(run.points.length).toBeGreaterThanOrEqual(2);
        expect(runLength(run.points)).toBeGreaterThan(0);
        for (const p of run.points) {
          expect(p.x).toBeGreaterThanOrEqual(chunk.bounds.minX - TOLERANCE);
          expect(p.x).toBeLessThanOrEqual(chunk.bounds.maxX + TOLERANCE);
          expect(p.y).toBeGreaterThanOrEqual(chunk.bounds.minY - TOLERANCE);
          expect(p.y).toBeLessThanOrEqual(chunk.bounds.maxY + TOLERANCE);
        }
      }
    }
  });

  it('cuts each curve into runs that together are the whole curve', () => {
    const cut = new Map<number, number>();
    for (const chunk of chunks) {
      for (const run of chunk.roads) cut.set(run.curve, (cut.get(run.curve) ?? 0) + runLength(run.points));
    }
    for (const road of world.roads) {
      expect(cut.get(road.id) ?? 0).toBeCloseTo(runLength(road.points), 3);
    }
  });

  it('names the segment of the world curve each run starts on', () => {
    for (const chunk of chunks) {
      for (const run of chunk.roads) {
        const road = world.roads[run.curve] as RoadCurve;
        expect(run.tier).toBe(road.tier);
        expect(run.from).toBeGreaterThanOrEqual(0);
        expect(run.from + run.points.length - 1).toBeLessThanOrEqual(road.points.length - 1);
        for (const i of [...run.bridges, ...run.tunnels]) {
          expect(i).toBeGreaterThanOrEqual(0);
          expect(i).toBeLessThan(run.points.length - 1);
        }
      }
    }
  });

  it('hands a run over to the next chunk at the point it left off', () => {
    const ends = boundaryPoints(source.chunk(0, 0), 'east');
    const starts = boundaryPoints(source.chunk(1, 0), 'west');
    expect(ends.length).toBeGreaterThan(0);
    expect(starts).toEqual(ends);
  });
});

/** Where the runs of a chunk meet one of its edges, as sorted keys. */
function boundaryPoints(chunk: WorldChunk, side: 'east' | 'west'): string[] {
  const at = side === 'east' ? chunk.bounds.maxX : chunk.bounds.minX;
  const keys: string[] = [];
  for (const run of chunk.roads) {
    const p = (side === 'east' ? run.points[run.points.length - 1] : run.points[0]) as Point;
    if (Math.abs(p.x - at) <= TOLERANCE) keys.push(`${run.curve}:${p.y.toFixed(3)}`);
  }
  return keys.sort(compareStrings);
}

describe('chunk parcels', () => {
  const chunks = everyChunk(world, source);

  it('cuts the parcels into pieces that tile them', () => {
    const cut = new Map<number, number>();
    for (const chunk of chunks) {
      for (const piece of chunk.parcels) {
        expect(piece.area).toBeCloseTo(regionArea(piece.region), 3);
        cut.set(piece.parcel, (cut.get(piece.parcel) ?? 0) + piece.area);
      }
    }
    expect(cut.size).toBe(layers.parcels.parcels.length);
    for (const parcel of layers.parcels.parcels) {
      expect(cut.get(parcel.id) ?? 0).toBeCloseTo(parcel.area, 1);
      const pieces = chunks.flatMap((chunk) => chunk.parcels.filter((piece) => piece.parcel === parcel.id));
      for (const piece of pieces) {
        expect(piece.owner).toBe(parcel.owner);
        expect(piece.district).toBe(parcel.district);
        expect(piece.zone).toBe(parcel.zone);
        expect(piece.roads).toEqual(parcel.roads);
      }
    }
  });

  it('keeps every piece inside the chunk that carries it', () => {
    for (const chunk of chunks) {
      for (const piece of chunk.parcels) {
        for (const p of piece.region.outer) {
          expect(p.x).toBeGreaterThanOrEqual(chunk.bounds.minX - CUT_SLACK);
          expect(p.x).toBeLessThanOrEqual(chunk.bounds.maxX + CUT_SLACK);
          expect(p.y).toBeGreaterThanOrEqual(chunk.bounds.minY - CUT_SLACK);
          expect(p.y).toBeLessThanOrEqual(chunk.bounds.maxY + CUT_SLACK);
        }
      }
    }
  });

  it('gives a place to exactly one piece of one parcel', () => {
    for (const chunk of chunks) {
      const step = CHUNK_SIZE / 8;
      for (let ix = 0; ix < 8; ix++) {
        for (let iy = 0; iy < 8; iy++) {
          const p = { x: chunk.bounds.minX + (ix + 0.5) * step, y: chunk.bounds.minY + (iy + 0.5) * step };
          const claims = chunk.parcels.filter((piece) => pointInRegion(p, piece.region));
          expect(claims.length).toBeLessThanOrEqual(1);
          const whole = layers.parcels.parcels.filter((parcel) => pointInRegion(p, parcel.region));
          expect(claims.map((piece) => piece.parcel)).toEqual(whole.map((parcel) => parcel.id));
        }
      }
    }
  });
});

describe('chunk buildings', () => {
  const chunks = everyChunk(world, source);

  it('gives every building to exactly one chunk', () => {
    const seen = new Set<number>();
    for (const chunk of chunks) {
      for (const building of chunk.buildings) {
        expect(seen.has(building.id), `building ${building.id} twice`).toBe(false);
        seen.add(building.id);
      }
    }
    expect(seen.size).toBe(layers.buildings.buildings.length);
    expect(seen.size).toBeGreaterThan(0);
  });

  it('gives a building to the chunk its lot stands in', () => {
    for (const chunk of chunks) {
      for (const building of chunk.buildings) {
        const middle = lotMiddle(building.lot);
        expect(chunkAt(middle.x, middle.y)).toEqual({ cx: chunk.cx, cy: chunk.cy });
      }
    }
  });

  it('gives an empty chunk no buildings', () => {
    expect(source.chunk(40, -40).buildings).toEqual([]);
  });
});

/**
 * What a chunk holds, field by field. Comparing two chunks as one JSON string
 * says only that they differ: the strings are hundreds of kilobytes long, and
 * the diff of two of them lines up wherever it can, so the place it points at
 * need not be the place that differs. Issue #333 was read off such a diff and
 * sent a session looking at the terrain. A field at a time names the field and
 * prints a diff short enough to read.
 */
const CHUNK_FIELDS = [
  'bounds',
  'terrain',
  'roads',
  'junctions',
  'parcels',
  'pavement',
  'buildings',
  'plants',
  'piers',
  'tram',
  'tramCrossings',
] as const satisfies readonly (keyof WorldChunk)[];

/** Two cuts of the same chunk hold the same thing, and the message names what does not. */
function expectSameChunk(alone: WorldChunk, loaded: WorldChunk): void {
  const where = `chunk (${alone.cx}, ${alone.cy})`;
  for (const field of CHUNK_FIELDS) {
    expect(stableJson(loaded[field]), `${where} differs in ${field}`).toBe(stableJson(alone[field]));
  }
  // The fields above are every field worth a diff of its own; this catches one
  // added later and left off the list.
  expect(stableJson(loaded), `${where} differs`).toBe(stableJson(alone));
}

describe('chunk isolation', () => {
  it('cuts the same chunk whether or not its neighbours were cut first', () => {
    const loaded = new ChunkSource(world, layers);
    for (let cx = -1; cx <= 2; cx++) for (let cy = -2; cy <= 1; cy++) loaded.chunk(cx, cy);
    // Three chunks rather than one: a corner of the block cut above, its
    // middle, and the first chunk cut, which a cache that answered with a stale
    // entry would hand back.
    for (const [cx, cy] of [[1, -1], [0, 0], [-1, -2]] as const) {
      expectSameChunk(new ChunkSource(world, buildLayers(world)).chunk(cx, cy), loaded.chunk(cx, cy));
    }
  });

  it('gives an empty chunk past the edge of the map', () => {
    const far = source.chunk(40, -40);
    expect(far.roads).toEqual([]);
    expect(far.parcels).toEqual([]);
    expect(far.terrain.heights).toHaveLength(far.terrain.gridSize * far.terrain.gridSize);
  });
});
