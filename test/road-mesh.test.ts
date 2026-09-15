import type { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildChunkRoads,
  markingsOf,
  partsOf,
  roadDrawCalls,
  roadSection,
  structureSection,
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
import { withNodes } from './helpers.ts';

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
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [], nodes: [] };
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
const heightAt = (x: number, y: number, tier: RoadTier): number => layers.carve.surfaceAt(x, y, tier);

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
  // Each place once: how many faces of a pavement's edge meet at a place on the
  // boundary depends on the side, and the seam only asks where they stand.
  return [...new Set(vertices(tier).filter((p) => Math.abs(p.x - x) < TOLERANCE).map((p) => `${p.y}:${p.z}`))].sort();
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
  it('draws the carriageway alone on the ground, from kerb to kerb', () => {
    // The pavement and the verge are cut out of the blocks (issue #266).
    for (const tier of TIER_ORDER) {
      const section = roadSection(tier);
      const half = TIERS[tier].width / 2;
      expect(section.map((point) => Math.abs(point.across))).toEqual(section.map(() => half));
      expect((section[0] as SectionPoint).rise).toBeLessThan(0);
      expect((section[section.length - 1] as SectionPoint).rise).toBeLessThan(0);
    }
  });

  it('spans exactly the ground the tier claims on a structure', () => {
    for (const tier of TIER_ORDER) {
      const section = structureSection(tier);
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
    const street = structureSection('street');
    expect((street[1] as SectionPoint).rise).toBeGreaterThan((street[2] as SectionPoint).rise * 0 + 0.1);
    // A highway has none, so its verge runs out level with the carriageway.
    // It stands over the bench rather than on it, because a surface at exactly
    // the height of the ground is one the ground shows through.
    const highway = structureSection('highway');
    expect((highway[1] as SectionPoint).rise).toBeGreaterThan(0);
    expect((highway[1] as SectionPoint).rise).toBe((highway[2] as SectionPoint).rise);
  });
});

describe('road surface', () => {
  const chunk = source.chunk(0, 0);
  const built = buildChunkRoads(chunk, ribbons, heightAt);

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
    const left = streetOf(buildChunkRoads(source.chunk(0, 0), ribbons, heightAt));
    const right = streetOf(buildChunkRoads(source.chunk(1, 0), ribbons, heightAt));
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
      const street = streetOf(buildChunkRoads(source.chunk(cx, 0), ribbons, heightAt));
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
  const spannedHeightAt = (x: number, y: number, tier: RoadTier): number => spannedSource.layers.carve.surfaceAt(x, y, tier);
  const spannedRibbons = new RoadRibbons(spannedWorld.terrain, spannedWorld.roads);

  it('knows which segments stand off the ground', () => {
    expect(spannedRibbons.isBridge(0, 1)).toBe(true);
    expect(spannedRibbons.isTunnel(0, 2)).toBe(true);
    expect(spannedRibbons.isOnGround(0, 0)).toBe(true);
    expect(spannedRibbons.isOnGround(0, 1)).toBe(false);
  });

  it('hangs a deck with a parapet each side under the bridged stretch', () => {
    // Chunk (-1, 0) covers x in [-250, 0), which is the whole deck.
    const street = streetOf(buildChunkRoads(spannedSource.chunk(-1, 0), spannedRibbons, spannedHeightAt));
    // The surface of the run, cut where it leaves the ground onto the deck
    // (the deck runs on past the chunk), then the deck and its two parapets.
    expect(street.runs.flatMap((run) => run.surfaces)).toHaveLength(2);
    expect(structuresOf(street)).toHaveLength(3);
    const bed = spannedRibbons.frameAt(0, 1, -100, 0).height;
    const under = vertices(street).filter((p) => Math.abs(p.x + 100) < TOLERANCE && p.y < bed - 1);
    expect(under.length).toBeGreaterThan(0);
  });

  it('frames a bore at both of its mouths and nowhere else', () => {
    // The bore runs from x = 0 to x = 100, so both mouths fall in chunk (0, 0).
    const here = streetOf(buildChunkRoads(spannedSource.chunk(0, 0), spannedRibbons, spannedHeightAt));
    // The bore from the boundary, then the road on the ground past its far mouth.
    expect(here.runs.flatMap((run) => run.surfaces)).toHaveLength(2);
    expect(structuresOf(here)).toHaveLength(2);
    const bed = spannedRibbons.frameAt(0, 2, 50, 0).height;
    // A portal stands well clear of the road it frames.
    expect(vertices(here).filter((p) => p.y > bed + 4).length).toBeGreaterThan(0);
    // The chunk beyond the far mouth carries the road on with nothing over it.
    const beyond = streetOf(buildChunkRoads(spannedSource.chunk(1, 0), spannedRibbons, spannedHeightAt));
    expect(structuresOf(beyond)).toHaveLength(0);
  });
});

describe('a turn too sharp to mitre', () => {
  /** A street that turns 45 degrees at (100, 100), well inside one chunk. */
  const bent = curve(0, [
    [20, 100],
    [100, 100],
    [180, 180],
  ]);
  const bentWorld = gridWorld([bent]);
  const bentSource = new ChunkSource(bentWorld, buildLayers(bentWorld));
  const bentRibbons = new RoadRibbons(bentWorld.terrain, bentWorld.roads);
  const bentHeightAt = (x: number, y: number, tier: RoadTier): number => bentSource.layers.carve.surfaceAt(x, y, tier);
  const street = streetOf(buildChunkRoads(bentSource.chunk(0, 0), bentRibbons, bentHeightAt));
  const run = street.runs[0] as { surfaces: BufferGeometry[]; joints: BufferGeometry[] };

  /**
   * The bisector of the outside of that turn. The road runs east and leaves to
   * the north east, so the outside of the bend is south of it.
   */
  const outward = ((): { x: number; y: number } => {
    const before = { x: 0, y: -1 };
    const after = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
    const x = before.x + after.x;
    const y = before.y + after.y;
    const length = Math.hypot(x, y);
    return { x: x / length, y: y / length };
  })();

  /** True where a place on the map stands under one of the triangles of a part. */
  function covers(part: BufferGeometry, x: number, y: number): boolean {
    const position = part.getAttribute('position');
    const index = part.getIndex() as { count: number; getX(i: number): number };
    for (let i = 0; i < index.count; i += 3) {
      const p = [0, 1, 2].map((k) => {
        const v = index.getX(i + k);
        return { x: position.getX(v), y: position.getZ(v) };
      }) as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
      const side = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
        (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      const s0 = side(p[0], p[1]);
      const s1 = side(p[1], p[2]);
      const s2 = side(p[2], p[0]);
      if ((s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0)) return true;
    }
    return false;
  }

  it('cuts the loft in two and bevels the joint between them', () => {
    // The two frames at the bend differ, so the surface comes in two pieces
    // with one bevel between them.
    expect(run.surfaces.length).toBe(2);
    expect(run.joints).toHaveLength(1);
  });

  it('fills the wedge the two pieces leave outside the bend', () => {
    const joint = run.joints[0] as BufferGeometry;
    const reach = footprintHalfWidth('street') / 2;
    const outside = { x: 100 + outward.x * reach, y: 100 + outward.y * reach };
    const inside = { x: 100 - outward.x * reach, y: 100 - outward.y * reach };
    // Neither piece of the loft reaches the outside of the bend.
    for (const surface of run.surfaces) expect(covers(surface, outside.x, outside.y)).toBe(false);
    expect(covers(joint, outside.x, outside.y)).toBe(true);
    // The inside of the bend is where the two pieces overlap already.
    expect(covers(joint, inside.x, inside.y)).toBe(false);
    for (const surface of run.surfaces) expect(covers(surface, inside.x, inside.y)).toBe(true);
  });

  it('stands the bevel on the bend, level with the carriageway and facing up', () => {
    const joint = run.joints[0] as BufferGeometry;
    const position = joint.getAttribute('position');
    const normal = joint.getAttribute('normal');
    const across = joint.getAttribute('across');
    const half = TIERS.street.width / 2;
    const bed = bentRibbons.frameAt(0, 0, 100, 100).height;
    let carriageway = 0;
    for (let v = 0; v < position.count; v++) {
      expect(Math.hypot(position.getX(v) - 100, position.getZ(v) - 100)).toBeLessThanOrEqual(
        footprintHalfWidth('street') + TOLERANCE,
      );
      // The point at the kerb itself carries the kerb top as well, so only
      // the carriageway inside it is level with the road.
      if (Math.abs(across.getX(v)) >= half) continue;
      carriageway++;
      // The carriageway of the bevel is the carriageway of the road: same
      // height, same normal, so nothing shows where the three meet.
      expect(position.getY(v)).toBeCloseTo(bed + 0.06, 4);
      expect(normal.getY(v)).toBeCloseTo(1, 6);
    }
    expect(carriageway).toBeGreaterThan(0);
  });
});

describe('draw calls', () => {
  it('costs a batch and a line mesh for each tier a chunk carries', () => {
    // One batch of streets, one of their markings; a chunk past the roads pays
    // nothing. What a whole chunk costs is `chunk-cost.ts`, which adds the
    // ground and the buildings to this.
    expect(roadDrawCalls(source.chunk(0, 0))).toBe(2);
    expect(roadDrawCalls(source.chunk(9, 9))).toBe(0);
  });
});
