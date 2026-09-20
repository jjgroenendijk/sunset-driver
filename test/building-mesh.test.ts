import { Vector3, type BufferAttribute, type BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { pointInRing, type Point } from '../src/core/geom.ts';
import { sideReach, withNodes } from './helpers.ts';
import { hashInts } from '../src/core/hash.ts';
import {
  buildChunkBuildings,
  buildingDrawCalls,
  buildingLookup,
  buildingVertices,
  massingOf,
  OUTLINE_WIDTH,
  standingGround,
  type BuildingLookup,
  type BuildingPlacement,
} from '../src/render/building-mesh.ts';
import { CHUNK_DRAW_CALL_CAP, chunkDrawCalls } from '../src/render/chunk-cost.ts';
import type { Building, BuildingKind } from '../src/world/buildings.ts';
import { buildLayers, chunkBounds, ChunkSource, CHUNK_SIZE, type WorldChunk } from '../src/world/chunks.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import type { District, RoadCurve, RoadTier, WorldDescription, Zone } from '../src/world/types.ts';

/** Metres two places may stand apart and still be one place. */
const TOLERANCE = 1e-6;

/** The ground of the made-up chunk below: flat unless a test slopes it. */
const GROUND = 12;

const CORE: District = { id: 0, name: 'Core', zone: 'core', x: 0, y: 0, density: 0.8, wealth: 0.7, culture: 'none' };

/**
 * A quiet district, which builds low. The tests that only care where a building
 * stands use it: a tower of fifty metres is generated in a fraction of the time
 * one of a hundred and fifty is, and it stands on its lot the same way.
 */
const QUIET: District = { ...CORE, density: 0.05, wealth: 0.05 };

/**
 * A lot laid the way `buildings.ts` lays one: the two front corners first, then
 * the two at the back, with the front looking at the road along `facing`.
 */
function lotOf(front: Point, width: number, depth: number, facing: number): Point[] {
  // The lot is on the far side of its frontage from the road, so the way into
  // the parcel is the way the front does not look.
  const n = { x: -Math.cos(facing), y: -Math.sin(facing) };
  const t = { x: n.y, y: -n.x };
  const f0 = { x: front.x - (t.x * width) / 2, y: front.y - (t.y * width) / 2 };
  const f1 = { x: front.x + (t.x * width) / 2, y: front.y + (t.y * width) / 2 };
  return [
    f0,
    f1,
    { x: f1.x + n.x * depth, y: f1.y + n.y * depth },
    { x: f0.x + n.x * depth, y: f0.y + n.y * depth },
  ];
}

let nextId = 0;

function buildingOf(kind: BuildingKind, width: number, depth: number, options: Partial<Building> = {}): Building {
  const facing = options.facing ?? -Math.PI / 2;
  const front = options.front ?? { x: 0, y: 0 };
  return {
    id: nextId++,
    parcel: 0,
    kind,
    seed: 0x51a7c3,
    lot: lotOf(front, width, depth, facing),
    area: width * depth,
    width,
    depth,
    front,
    facing,
    road: 0,
    district: 0,
    zone: 'core',
    // The skyline at its edge, so a tower stands low unless the test says otherwise.
    skyline: 0,
    ...options,
    // A lot with nothing against either side, unless the test says otherwise.
    shared: options.shared ?? { left: false, right: false },
  };
}

/** A chunk holding nothing but the buildings a test cares about. */
function chunkOf(buildings: Building[]): WorldChunk {
  return {
    seed: 1,
    cx: 0,
    cy: 0,
    bounds: chunkBounds(0, 0),
    terrain: { gridSize: 2, cellSize: CHUNK_SIZE, originX: 0, originY: 0, heights: new Float32Array(4).fill(GROUND) },
    seaLevel: 0,
    roads: [],
    junctions: [],
    pavement: [],
    parcels: [],
    buildings,
    plants: [],
    piers: [],
    tram: [],
    tramCrossings: [],
  };
}

/** A world that answers every question the same way, so a test can vary one thing. */
function lookupOf(
  heightAt: (x: number, y: number) => number = () => GROUND,
  chamfer = 0,
  district = CORE,
): BuildingLookup {
  return { heightAt, districtOf: () => district, chamferOf: () => chamfer };
}

function placed(buildings: Building[], lookup = lookupOf()): BuildingPlacement[] {
  return buildChunkBuildings(chunkOf(buildings), lookup);
}

/**
 * Walk every vertex of a geometry, in the world the placement stands in. One
 * vector is handed out over and over: a tower has tens of thousands of vertices,
 * and a test that kept them all would spend its time allocating.
 */
function eachWorldVertex(
  geometry: BufferGeometry,
  placement: BuildingPlacement,
  visit: (p: Vector3) => void,
): void {
  const position = geometry.getAttribute('position') as BufferAttribute;
  const at = new Vector3();
  for (let v = 0; v < position.count; v++) {
    visit(at.fromBufferAttribute(position, v).applyMatrix4(placement.matrix));
  }
}

/** How far out a geometry reaches along one axis, in the world. */
function reachOf(geometry: BufferGeometry, placement: BuildingPlacement, pick: (p: Vector3) => number): number {
  let out = -Infinity;
  eachWorldVertex(geometry, placement, (p) => {
    out = Math.max(out, pick(p));
  });
  return out;
}

/**
 * How wide the rim of an outline comes out, wall by wall: for each way a wall
 * of the hull faces, how far the hull stands past the shell that way. The shell
 * of a block is a box, so the furthest it reaches is the wall itself.
 */
function rimsOf(placement: BuildingPlacement): [number, string][] {
  const normal = placement.hull.getAttribute('normal') as BufferAttribute;
  const ways = new Map<string, Vector3>();
  const at = new Vector3();
  for (let v = 0; v < normal.count; v++) {
    at.fromBufferAttribute(normal, v).transformDirection(placement.matrix);
    // The walls alone: the caps are covered by the reach along `y`.
    if (Math.abs(at.y) > 0.1) continue;
    at.y = 0;
    at.normalize();
    ways.set(`${at.x.toFixed(2)},${at.z.toFixed(2)}`, at.clone());
  }
  const out: [number, string][] = [];
  for (const [name, way] of ways) {
    const pick = (p: Vector3): number => p.dot(way);
    out.push([reachOf(placement.hull, placement, pick) - reachOf(placement.shell, placement, pick), name]);
  }
  return out;
}

/** A geometry as one number, so two of them are compared without walking both. */
function signature(geometry: BufferGeometry): string {
  const array = (geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
  let hash = 0;
  for (let i = 0; i < array.length; i++) hash = hashInts(hash, Math.round((array[i] as number) * 1e4));
  return `${array.length}:${hash}`;
}

/** The kinds a lot of every size is built in, so a test covers all of them. */
const KINDS: readonly BuildingKind[] = ['tower', 'mid-rise', 'parking-garage', 'shop-row', 'house', 'warehouse', 'roadhouse'];

describe('a building on its lot', () => {
  it('stands wholly inside the lot it was given', () => {
    for (const kind of KINDS) {
      for (const facing of [Math.PI / 2, 2.3]) {
        const building = buildingOf(kind, 22, 26, { facing, front: { x: 60, y: -40 } });
        const one = placed([building], lookupOf(undefined, 0, QUIET))[0] as BuildingPlacement;
        let outside = 0;
        eachWorldVertex(one.shell, one, (vertex) => {
          if (!pointInRing({ x: vertex.x, y: vertex.z }, standingGround(building))) outside++;
        });
        expect(outside, `${kind} at ${facing}`).toBe(0);
      }
    }
  });

  it('reaches the wall it shares and stands in from every other edge', () => {
    // Two lots of one street wall, meeting at x = 11: the second corner of the
    // first lot is the first corner of the second (spec section 10.3).
    const boundary = 11;
    for (const kind of KINDS) {
      const west = buildingOf(kind, 22, 26, { front: { x: 0, y: 0 }, shared: { left: false, right: true } });
      const east = buildingOf(kind, 22, 26, { front: { x: 22, y: 0 }, shared: { left: true, right: false } });
      const both = placed([west, east], lookupOf(undefined, 0, QUIET));
      const one = both[0] as BuildingPlacement;
      const other = both[1] as BuildingPlacement;
      const span = (of: BuildingPlacement): { low: number; high: number } => {
        let low = Infinity;
        let high = -Infinity;
        eachWorldVertex(of.shell, of, (vertex) => {
          low = Math.min(low, vertex.x);
          high = Math.max(high, vertex.x);
        });
        return { low, high };
      };
      const walls = span(one);
      const next = span(other);
      // Both walls stand on the boundary, so there is no slot between them and
      // neither reaches over its neighbour.
      expect(walls.high, `${kind} west of the wall`).toBeCloseTo(boundary, 2);
      expect(next.low, `${kind} east of the wall`).toBeCloseTo(boundary, 2);
      // The far side of each lot has nothing against it and keeps its margin.
      expect(walls.low, `${kind} west end`).toBeGreaterThan(-boundary + 0.3);
      expect(next.high, `${kind} east end`).toBeLessThan(3 * boundary - 0.3);
      // And nothing stands on ground no wall of its own or its neighbour covers.
      for (const one of [
        { at: west, of: both[0] as BuildingPlacement },
        { at: east, of: both[1] as BuildingPlacement },
      ]) {
        let outside = 0;
        eachWorldVertex(one.of.shell, one.of, (vertex) => {
          if (!pointInRing({ x: vertex.x, y: vertex.z }, standingGround(one.at))) outside++;
        });
        expect(outside, `${kind} off its ground`).toBe(0);
      }
    }
  });

  it('leans its wall onto a side edge it shares where the frontage bends', () => {
    // Two lots of one street wall on a bend: the edge between them leans 4 m
    // over its 26 m of depth, so a box square to the frontage cannot reach it
    // at both ends (spec section 10.3).
    const west = [
      { x: -22, y: 0 },
      { x: 0, y: 0 },
      { x: 4, y: 26 },
      { x: -22, y: 26 },
    ];
    const east = [
      { x: 0, y: 0 },
      { x: 22, y: 0 },
      { x: 22, y: 26 },
      { x: 4, y: 26 },
    ];
    for (const kind of KINDS) {
      const lots = [
        buildingOf(kind, 20, 26, { lot: west, front: { x: -11, y: 0 }, shared: { left: false, right: true } }),
        buildingOf(kind, 16, 26, { lot: east, front: { x: 11, y: 0 }, shared: { left: true, right: false } }),
      ];
      const both = placed(lots, lookupOf(undefined, 0, QUIET));
      for (const [i, side] of [
        [0, 'right'],
        [1, 'left'],
      ] as const) {
        const one = both[i] as BuildingPlacement;
        const where = `${kind} ${side} of the bend`;
        const reach = sideReach(one.building.lot, side, (visit) =>
          eachWorldVertex(one.shell, one, (vertex) => visit({ x: vertex.x, y: vertex.z })),
        );
        // It stands on the edge and never over it.
        expect(reach.most, where).toBeCloseTo(0, 2);
        // A block fills its massing, so its wall reaches the edge at both ends.
        // A generated facade is measured at its widest, which is not both ends.
        if (one.batch === 'block') {
          expect(reach.front, `${where}, front`).toBeCloseTo(0, 2);
          expect(reach.back, `${where}, back`).toBeCloseTo(0, 2);
        }
        let outside = 0;
        eachWorldVertex(one.shell, one, (vertex) => {
          if (!pointInRing({ x: vertex.x, y: vertex.z }, standingGround(one.building))) outside++;
        });
        expect(outside, `${where}, off its ground`).toBe(0);
      }
    }
  });

  it('turns the front of the building to face the road', () => {
    for (const facing of [0, 1.1, -2.4]) {
      const one = placed([buildingOf('house', 18, 20, { facing })])[0] as BuildingPlacement;
      // The building's own frame looks down its z axis at the road it fronts.
      const front = new Vector3(0, 0, 1).transformDirection(one.matrix);
      expect(front.x).toBeCloseTo(Math.cos(facing), 6);
      expect(front.z).toBeCloseTo(Math.sin(facing), 6);
    }
  });

  it('stands on the highest corner of its lot, and carries a footing to the lowest', () => {
    // Ground that falls away to the east, so the four corners differ.
    const slope = (x: number): number => 30 - x * 0.1;
    const building = buildingOf('warehouse', 30, 30, { front: { x: 100, y: 0 } });
    const one = placed([building], lookupOf((x) => slope(x)))[0] as BuildingPlacement;
    let lowest = Infinity;
    let highest = -Infinity;
    for (const corner of building.lot) {
      lowest = Math.min(lowest, slope(corner.x));
      highest = Math.max(highest, slope(corner.x));
    }
    const base = new Vector3().setFromMatrixPosition(one.matrix).y;
    // On the highest corner, sunk only far enough to bury the foot of the wall,
    // so no ground the building covers stands over its ground floor.
    expect(base).toBeLessThanOrEqual(highest);
    expect(base).toBeGreaterThan(highest - 1);
    // And the footing reaches the lowest corner, so no wall floats over the fall.
    const footing = one.footing as BufferGeometry;
    let foot = Infinity;
    eachWorldVertex(footing, one, (p) => {
      foot = Math.min(foot, p.y);
    });
    expect(foot).toBeLessThanOrEqual(lowest);
    expect(foot).toBeGreaterThan(lowest - 1);
  });

  it('builds no footing on level ground', () => {
    expect((placed([buildingOf('house', 18, 20)])[0] as BuildingPlacement).footing).toBeUndefined();
  });
});

describe('which batch a building is built in', () => {
  it('generates a facade for a tower with the room for one, and a block for the rest', () => {
    // Only classical masonry is generated. Seed 1 draws it in this district and
    // seed 2 draws the glass curtain wall, which is built from boxes.
    expect((placed([buildingOf('tower', 26, 28, { seed: 1 })])[0] as BuildingPlacement).batch).toBe('facade');
    expect((placed([buildingOf('mid-rise', 24, 24, { seed: 1 })])[0] as BuildingPlacement).batch).toBe('facade');
    expect((placed([buildingOf('tower', 26, 28, { seed: 2 })])[0] as BuildingPlacement).batch).toBe('block');
    // A lot this narrow leaves the generator no room for its bays once the
    // cornices have been allowed for, so the tower is built as a block.
    expect((placed([buildingOf('tower', 12, 26, { seed: 1 })])[0] as BuildingPlacement).batch).toBe('block');
    for (const kind of ['parking-garage', 'shop-row', 'house', 'warehouse', 'roadhouse'] as const) {
      expect((placed([buildingOf(kind, 26, 28)])[0] as BuildingPlacement).batch).toBe('block');
    }
  });

  it('costs one batch for each kind a chunk holds, and one for the outlines', () => {
    expect(buildingDrawCalls(chunkOf([]))).toBe(0);
    expect(buildingDrawCalls(chunkOf([buildingOf('house', 20, 22)]))).toBe(2);
    // A tower's roof dressing is drawn with the blocks, so a chunk of towers
    // alone still pays for the block batch.
    expect(buildingDrawCalls(chunkOf([buildingOf('tower', 26, 28)]))).toBe(3);
    expect(buildingDrawCalls(chunkOf([buildingOf('tower', 26, 28), buildingOf('house', 20, 22)]))).toBe(3);
  });
});

describe('how tall a building stands', () => {
  it('builds higher where the district is denser and richer', () => {
    const building = buildingOf('tower', 30, 30);
    const quiet = massingOf(building, { ...CORE, density: 0.1, wealth: 0.1 }, 0);
    const busy = massingOf(building, { ...CORE, density: 0.9, wealth: 0.9 }, 0);
    expect(busy.height).toBeGreaterThan(quiet.height);
  });

  it('builds higher where the skyline stands higher, so the city falls away from its middle', () => {
    for (const kind of ['tower', 'mid-rise'] as const) {
      const edge = massingOf(buildingOf(kind, 30, 30, { skyline: 0.1 }), CORE, 0);
      const middle = massingOf(buildingOf(kind, 30, 30, { skyline: 0.9 }), CORE, 0);
      expect(middle.height, kind).toBeGreaterThan(edge.height);
    }
    // A house is a house wherever it stands.
    const house = (skyline: number): number => massingOf(buildingOf('house', 20, 20, { skyline }), CORE, 0).height;
    expect(house(0.9)).toBe(house(0.1));
  });

  it('keeps a tower on a narrow lot from standing like a spire', () => {
    const narrow = massingOf(buildingOf('tower', 15, 15), CORE, 0);
    const wide = massingOf(buildingOf('tower', 34, 30), CORE, 0);
    expect(narrow.height).toBeLessThan(wide.height);
    // Its own narrow side is what caps it, whatever the district wants.
    expect(narrow.height).toBeLessThan(narrow.width * 8);
  });

  it('leaves room between one building and the next', () => {
    for (const kind of KINDS) {
      const massing = massingOf(buildingOf(kind, 24, 24), CORE, 0);
      expect(massing.width, kind).toBeLessThan(24);
      expect(massing.depth, kind).toBeLessThan(24);
    }
  });
});

describe('the outline hull', () => {
  it('stands outside the building it rims, all the way round', () => {
    for (const kind of KINDS) {
      const one = placed([buildingOf(kind, 26, 28)], lookupOf(undefined, 0, QUIET))[0] as BuildingPlacement;
      // The hull is wider and taller than the shell by the width of the outline,
      // and by no more than that: an outline is a rim, not a second building.
      for (const pick of [(p: Vector3) => p.x, (p: Vector3) => p.z, (p: Vector3) => p.y]) {
        const grew = reachOf(one.hull, one, pick) - reachOf(one.shell, one, pick);
        expect(grew, kind).toBeGreaterThan(OUTLINE_WIDTH * 0.9);
        expect(grew, kind).toBeLessThan(OUTLINE_WIDTH * 1.5);
      }
    }
  });

  it('keeps the rim one width wide on a lot that is not square', () => {
    // A lot on a bend leans, and the shell and the hull are sheared and
    // stretched onto its side edges. A rim pushed out by the same amount in
    // the building's own units then comes out metres wide where the stretch is
    // widest and a centimetre where it is narrowest.
    const front = { x: 0, y: 0 };
    const wedge = [
      { x: -6, y: 0 },
      { x: 6, y: 0 },
      { x: 18, y: 24 },
      { x: -18, y: 24 },
    ];
    for (const kind of ['house', 'warehouse', 'shop-row'] as const) {
      const building = buildingOf(kind, 12, 24, { front, lot: wedge, shared: { left: true, right: true } });
      const one = placed([building], lookupOf(undefined, 0, QUIET))[0] as BuildingPlacement;
      for (const [rim, wall] of rimsOf(one)) {
        expect(rim, `${kind} wall ${wall}`).toBeGreaterThan(OUTLINE_WIDTH * 0.8);
        expect(rim, `${kind} wall ${wall}`).toBeLessThan(OUTLINE_WIDTH * 1.3);
      }
    }
  });

  it('never spikes a corner out past the building, whatever the shape', () => {
    // Two faces of a footprint that cross behind the shell cross a long way
    // outside it: the corner a chamfer cuts is the one that used to fly out
    // tens of metres over the street above a setback.
    for (let seed = 0; seed < 16; seed++) {
      const building = buildingOf('mid-rise', 27, 27, { seed });
      for (const chamfer of [-1, 1]) {
        const chunk = chunkOf([building]);
        const one = buildChunkBuildings(chunk, lookupOf(undefined, chamfer, CORE), 'mid')[0] as BuildingPlacement;
        // A setback pulls the hull in over the tier below it, so only the
        // outside of the rim is pinned here.
        for (const [rim, wall] of rimsOf(one)) expect(rim, `seed ${seed} wall ${wall}`).toBeLessThan(OUTLINE_WIDTH * 1.3);
      }
    }
  });

  it('winds every face of the hull to look outward', () => {
    // The hull is drawn back-face only, so a face wound the other way would put
    // the near side of the hull over the building and hide it.
    for (const kind of KINDS) {
      const one = placed([buildingOf(kind, 26, 28)], lookupOf(() => GROUND, 1, QUIET))[0] as BuildingPlacement;
      const hull = one.hull;
      const position = hull.getAttribute('position') as BufferAttribute;
      const normal = hull.getAttribute('normal') as BufferAttribute;
      for (let t = 0; t + 2 < position.count; t += 3) {
        const a = new Vector3().fromBufferAttribute(position, t);
        const b = new Vector3().fromBufferAttribute(position, t + 1);
        const c = new Vector3().fromBufferAttribute(position, t + 2);
        const face = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, b));
        if (face.lengthSq() < TOLERANCE) continue;
        const wants = new Vector3().fromBufferAttribute(normal, t);
        expect(face.normalize().dot(wants), `${kind} face ${t / 3}`).toBeGreaterThan(0.5);
      }
    }
  });
});

describe('a building past near detail', () => {
  it('is a block at mid detail and its massing at far detail, outlined at both', () => {
    const buildings = [buildingOf('tower', 26, 28), buildingOf('house', 16, 18, { front: { x: 40, y: 10 } })];
    const lookup = lookupOf(undefined, 0, QUIET);
    const near = buildChunkBuildings(chunkOf(buildings), lookup, 'near');
    const mid = buildChunkBuildings(chunkOf(buildings), lookup, 'mid');
    const far = buildChunkBuildings(chunkOf(buildings), lookup, 'far');
    expect(near[0]?.batch).toBe('facade');
    expect(mid.map((one) => one.batch)).toEqual(['block', 'block']);
    expect(far.map((one) => one.batch)).toEqual(['block', 'block']);
    for (const one of [...mid, ...far]) expect(one.hull.getAttribute('position').count).toBeGreaterThan(0);
    // Each detail costs a fraction of the one before it (spec section 9.2).
    expect(buildingVertices(mid) * 10).toBeLessThan(buildingVertices(near));
    expect(buildingVertices(far) * 4).toBeLessThan(buildingVertices(mid));
  });

  it('stands where the near building stands, and on the same lot', () => {
    for (const kind of KINDS) {
      const building = buildingOf(kind, 26, 28, { front: { x: 60, y: -40 } });
      const lookup = lookupOf(undefined, 0, QUIET);
      const near = buildChunkBuildings(chunkOf([building]), lookup, 'near')[0] as BuildingPlacement;
      for (const detail of ['mid', 'far'] as const) {
        const one = buildChunkBuildings(chunkOf([building]), lookup, detail)[0] as BuildingPlacement;
        // The massing is the same, so the city reads the same at every detail:
        // only the shell is simpler, and it stands on the same ground.
        expect(one.massing).toEqual(near.massing);
        expect(new Vector3().setFromMatrixPosition(one.matrix).toArray()).toEqual(
          new Vector3().setFromMatrixPosition(near.matrix).toArray(),
        );
        let outside = 0;
        eachWorldVertex(one.shell, one, (vertex) => {
          if (!pointInRing({ x: vertex.x, y: vertex.z }, standingGround(building))) outside++;
        });
        expect(outside, `${kind} at ${detail} detail`).toBe(0);
      }
    }
  });
});

describe('the same chunk twice', () => {
  it('builds the same buildings, vertex for vertex', () => {
    const buildings = [buildingOf('tower', 28, 26), buildingOf('house', 16, 18, { front: { x: 40, y: 10 } })];
    const first = placed(buildings, lookupOf(undefined, 0, QUIET));
    const second = placed(buildings, lookupOf(undefined, 0, QUIET));
    expect(second).toHaveLength(first.length);
    for (let i = 0; i < first.length; i++) {
      const a = first[i] as BuildingPlacement;
      const b = second[i] as BuildingPlacement;
      expect(b.matrix.elements).toEqual(a.matrix.elements);
      expect(b.massing).toEqual(a.massing);
      expect(signature(b.shell)).toBe(signature(a.shell));
      expect(signature(b.hull)).toBe(signature(a.hull));
    }
  });
});

/**
 * A hand-built world: a square island under a grid of streets, so the buildings
 * of a real chunk can be checked without generating a world.
 */
const SIZE = 800;
const CELL = 10;
const BLOCK = 150;

function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

function curve(id: number, coords: readonly [number, number][], tier: RoadTier = 'street'): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [], nodes: [] };
}

function gridWorld(): WorldDescription {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) hf.set(ix, iy, 20 + hf.worldX(ix) * 0.02 + hf.worldY(iy) * 0.05);
  }
  const roads: RoadCurve[] = [];
  const line = -2 * BLOCK;
  for (let i = 0; i <= 4; i++) {
    const at = line + i * BLOCK;
    roads.push(curve(roads.length, [[at, line], [at, -line]]));
    roads.push(curve(roads.length, [[line, at], [-line, at]]));
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
    tram: { route: [], edges: [], corridors: [], stops: [], crossings: [], length: 0 },
  };
}

describe('the buildings of a real chunk', () => {
  const world = gridWorld();
  const layers = buildLayers(world);
  const source = new ChunkSource(world, layers);
  const lookup = buildingLookup(world, layers);
  const reach = Math.ceil(SIZE / 2 / CHUNK_SIZE);

  it('lays a building on the ground the roads left, and nowhere else', () => {
    let count = 0;
    for (let cy = -reach; cy <= reach; cy++) {
      for (let cx = -reach; cx <= reach; cx++) {
        for (const one of buildChunkBuildings(source.chunk(cx, cy), lookup)) {
          count++;
          let outside = 0;
          eachWorldVertex(one.shell, one, (vertex) => {
            if (!pointInRing({ x: vertex.x, y: vertex.z }, standingGround(one.building))) outside++;
          });
          expect(outside, `${one.building.kind} ${one.building.id} in chunk ${cx}, ${cy}`).toBe(0);
        }
      }
    }
    expect(count).toBe(layers.buildings.buildings.length);
  });

  it('stays inside the draw call cap on every chunk of the map', () => {
    for (let cy = -reach; cy <= reach; cy++) {
      for (let cx = -reach; cx <= reach; cx++) {
        expect(chunkDrawCalls(source.chunk(cx, cy))).toBeLessThanOrEqual(CHUNK_DRAW_CALL_CAP);
      }
    }
  });
});
