import { describe, expect, it } from 'vitest';
import {
  buildWaterAttributes,
  OPEN_SEA,
  waterGeometry,
  waterNear,
  WATER_CELL,
  waveNormalData,
  WAVE_TEXTURE_SIZE,
  type WaterAttributes,
} from '../../../src/render/environment/water.ts';
import { Heightfield } from '../../../src/world/terrain/heightfield.ts';
import type { WorldDescription } from '../../../src/world/types.ts';

const SIZE = 800;
const CELL = 10;
/** Metres from the origin the hand-built shore stands at. */
const SHORE = 250;

/**
 * A hand-built world: one round island in the middle of the map, its ground
 * falling a metre every ten from the summit, so the shore is a circle of known
 * radius and everything past it is sea that deepens outward.
 */
function islandWorld(): WorldDescription {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) {
      hf.set(ix, iy, (SHORE - Math.hypot(hf.worldX(ix), hf.worldY(iy))) / 10);
    }
  }
  return {
    seed: 7,
    size: SIZE,
    archetype: 'archipelago',
    core: { x: 0, y: 0 },
    terrain: hf.toData(),
    water: {
      seaLevel: 0,
      islands: [{ id: 0, x: 0, y: 0, radius: SHORE, main: true }],
      crossings: [],
      rivers: [],
      harbour: { x: 0, y: 0, radius: 10 },
      industry: 0,
    },
    districts: [],
    beaches: [],
    airfields: [],
    roads: [],
    corridors: [],
    tram: { route: [], edges: [], corridors: [], stops: [], crossings: [], length: 0 },
  };
}

const world = islandWorld();
const terrain = new Heightfield(world.terrain);
const attributes = buildWaterAttributes(world);

/** The deepest ground within half a cell of a place, which is what a vertex reads. */
function lowestAround(x: number, y: number): number {
  const step = WATER_CELL / 2;
  let lowest = Infinity;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) lowest = Math.min(lowest, terrain.sample(x + i * step, y + j * step));
  }
  return lowest;
}

/** The world place a vertex stands at, read back through the quarter turn that lays the sheet flat. */
function placeOf(water: WaterAttributes, vertex: number): { x: number; y: number } {
  return { x: water.positions[vertex * 3] as number, y: -(water.positions[vertex * 3 + 1] as number) };
}

/** The cells the sheet drew, as `column,row` of the grid. */
function drawnCells(water: WaterAttributes): Set<string> {
  const out = new Set<string>();
  for (let t = 0; t < water.indices.length; t += 6) {
    const corner = water.indices[t] as number;
    out.add(`${corner % water.gridSize},${Math.floor(corner / water.gridSize)}`);
  }
  return out;
}

/** True where the cell a place falls in was drawn. */
function coversPlace(water: WaterAttributes, cells: Set<string>, x: number, y: number): boolean {
  const i = Math.floor((x - water.minX) / water.cell);
  const j = Math.floor((y - water.minY) / water.cell);
  return cells.has(`${i},${j}`);
}

describe('water surface', () => {
  const cells = drawnCells(attributes);

  it('stands every vertex over the ground its depth was taken from', () => {
    const n = attributes.gridSize;
    expect(attributes.positions).toHaveLength(n * n * 3);
    expect(attributes.depths).toHaveLength(n * n);
    let complaint: string | undefined;
    for (let v = 0; v < n * n; v++) {
      const place = placeOf(attributes, v);
      const depth = attributes.depths[v] as number;
      const wanted = world.water.seaLevel - lowestAround(place.x, place.y);
      const level = Math.abs(depth - wanted) < 5e-5;
      if (!level) complaint ??= `vertex ${v} is ${depth} deep, not ${wanted}`;
      // The sheet itself is flat: the third local axis is what the turn sends up.
      if (attributes.positions[v * 3 + 2] !== 0) complaint ??= `vertex ${v} stands off the sheet`;
      if (attributes.normals[v * 3 + 2] !== 1) complaint ??= `vertex ${v} has a normal off the sheet's`;
    }
    expect(complaint).toBeUndefined();
  });

  it('reaches the open sea past every edge of the map', () => {
    const n = attributes.gridSize;
    const reach = SIZE / 2 + OPEN_SEA;
    expect(attributes.minX).toBeLessThanOrEqual(-reach);
    expect(attributes.minY).toBeLessThanOrEqual(-reach);
    expect(attributes.minX + (n - 1) * WATER_CELL).toBeGreaterThanOrEqual(reach);
    expect(attributes.minY + (n - 1) * WATER_CELL).toBeGreaterThanOrEqual(reach);
    // Anchored on the origin like the chunk grid, so a vertex stands on it.
    expect(Math.abs(attributes.minX % WATER_CELL)).toBe(0);
  });

  it('draws the cells that carry water and no others', () => {
    const n = attributes.gridSize;
    let wet = 0;
    let complaint: string | undefined;
    for (let j = 0; j + 1 < n; j++) {
      for (let i = 0; i + 1 < n; i++) {
        const corners = [j * n + i, j * n + i + 1, (j + 1) * n + i, (j + 1) * n + i + 1];
        const any = corners.some((v) => (attributes.depths[v] as number) > 0);
        if (cells.has(`${i},${j}`) !== any) complaint ??= `cell ${i},${j} is ${any ? 'wet and not drawn' : 'dry and drawn'}`;
        if (any) wet++;
      }
    }
    expect(complaint).toBeUndefined();
    expect(cells.size).toBe(wet);
    expect(attributes.indices).toHaveLength(wet * 6);
    expect(wet).toBeGreaterThan(0);
  });

  it('covers the sea and leaves the island dry', () => {
    // Well inside the shore, and further out than one cell past it, so a cell
    // the shoreline runs through counts neither way.
    for (const r of [0, SHORE * 0.5, SHORE - 2 * WATER_CELL]) {
      expect(coversPlace(attributes, cells, r, 0), `${r} m from the summit`).toBe(false);
    }
    for (const r of [SHORE + 2 * WATER_CELL, SIZE / 2, SIZE / 2 + OPEN_SEA - WATER_CELL]) {
      for (const angle of [0, 1, 2, 3]) {
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        expect(coversPlace(attributes, cells, x, y), `${r} m out at ${angle}`).toBe(true);
      }
    }
  });

  it('winds every triangle to face up once the sheet is laid flat', () => {
    let complaint: string | undefined;
    for (let t = 0; t < attributes.indices.length; t += 3) {
      // The quarter turn about X sends the local (x, y, 0) to the world (x, 0, -y).
      const [a, b, c] = [0, 1, 2].map((k) => {
        const v = attributes.indices[t + k] as number;
        return placeOf(attributes, v);
      }) as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
      // The upward component of the cross product, in the world's own plane.
      const up = -((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
      const upward = up > 0;
      if (!upward) complaint ??= `triangle ${t / 3} faces down`;
    }
    expect(complaint).toBeUndefined();
  });

  it('is the same sheet every time it is built', () => {
    const again = buildWaterAttributes(world);
    expect([...again.depths]).toEqual([...attributes.depths]);
    expect([...again.indices]).toEqual([...attributes.indices]);
  });

  it('hands the renderer a geometry of what it built', () => {
    const geometry = waterGeometry(attributes);
    expect(geometry.getAttribute('position').count).toBe(attributes.gridSize * attributes.gridSize);
    expect(geometry.getAttribute('depth').count).toBe(attributes.gridSize * attributes.gridSize);
    expect(geometry.getIndex()?.count).toBe(attributes.indices.length);
    expect(geometry.boundingSphere).not.toBeNull();
    geometry.dispose();
  });
});

describe('water near a place', () => {
  it('finds no water inland and water at the shore and the sea', () => {
    // The island's shore stands 250 m out, and the sheet's drawn water begins
    // where the deepest of a vertex's samples crosses the waterline. A patch
    // that keeps clear of that finds no water.
    expect(waterNear(attributes, 0, 0, 125)).toBe(false);
    expect(waterNear(attributes, 40, 0, 80)).toBe(false);
    // The patch is a square, and the samples a vertex reads reach √2 cells
    // further on the diagonal than on the axis, so the sheet's drawn water
    // begins nearer on the diagonal: the game's 160 m patch touches it from
    // the summit of an island this size.
    expect(waterNear(attributes, 0, 0, 160)).toBe(true);
    // Closer to the shore on the axis, and anywhere on the sea itself.
    expect(waterNear(attributes, 100, 0, 160)).toBe(true);
    expect(waterNear(attributes, 150, 0, 160)).toBe(true);
    expect(waterNear(attributes, SHORE + 2 * WATER_CELL, 0, 0)).toBe(true);
    expect(waterNear(attributes, SIZE / 2 + OPEN_SEA, SIZE / 2 + OPEN_SEA, 0)).toBe(true);
  });

  it('answers for the drawn sheet exactly: water near is a drawn cell in the patch', () => {
    // A cell is drawn when any corner of it stands in water, so the answer has
    // to be: some cell the sheet draws reaches into the patch. Anything looser
    // draws the sheet, and its mirror, where the player can see no water;
    // anything tighter hides water they can.
    const cells = drawnCells(attributes);
    for (const radius of [0, 60, 160]) {
      for (let y = -700; y <= 700; y += 30) {
        for (let x = -700; x <= 700; x += 30) {
          expect(waterNear(attributes, x, y, radius), `${x},${y} within ${radius}`).toBe(patchTouchesCell(attributes, cells, x, y, radius));
        }
      }
    }
  });

  /** True where any drawn cell of the sheet reaches into the patch of a place. */
  function patchTouchesCell(water: WaterAttributes, cells: Set<string>, x: number, y: number, radius: number): boolean {
    const loI = Math.floor((x - radius - water.minX) / water.cell);
    const hiI = Math.floor((x + radius - water.minX) / water.cell);
    const loJ = Math.floor((y - radius - water.minY) / water.cell);
    const hiJ = Math.floor((y + radius - water.minY) / water.cell);
    for (let j = loJ; j <= hiJ; j++) {
      for (let i = loI; i <= hiI; i++) if (cells.has(`${i},${j}`)) return true;
    }
    return false;
  }
});

describe('wave normal map', () => {
  const size = 64;
  const data = waveNormalData(world.seed, size);

  /** One texel of the map, decoded back into a normal. */
  function normalAt(tx: number, ty: number): { x: number; y: number; z: number } {
    const t = ((ty + size) % size) * size * 4 + ((tx + size) % size) * 4;
    return {
      x: ((data[t] as number) / 255) * 2 - 1,
      y: ((data[t + 1] as number) / 255) * 2 - 1,
      z: ((data[t + 2] as number) / 255) * 2 - 1,
    };
  }

  it('stores a unit normal that leans off the surface it stands on', () => {
    expect(data).toHaveLength(size * size * 4);
    let leaning = 0;
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        const n = normalAt(tx, ty);
        // A byte a side, so a unit vector comes back to about a hundredth.
        expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 1);
        expect(n.z).toBeGreaterThan(0);
        if (Math.hypot(n.x, n.y) > 0.1) leaning++;
        expect(data[(ty * size + tx) * 4 + 3]).toBe(255);
      }
    }
    // A map of nothing but flat texels would be still water.
    expect(leaning).toBeGreaterThan(size * size * 0.3);
  });

  it('tiles without a seam', () => {
    // The waves have a whole number of periods across the tile, so a step over
    // the edge is no larger than a step anywhere inside it.
    let inside = 0;
    let across = 0;
    for (let t = 0; t < size; t++) {
      inside += Math.abs(normalAt(t, 1).x - normalAt(t, 0).x) + Math.abs(normalAt(1, t).y - normalAt(0, t).y);
      across += Math.abs(normalAt(t, 0).x - normalAt(t, -1).x) + Math.abs(normalAt(0, t).y - normalAt(-1, t).y);
    }
    expect(across).toBeLessThan(inside * 1.5);
  });

  it('draws its waves from the seed', () => {
    expect([...waveNormalData(world.seed, size)]).toEqual([...data]);
    expect([...waveNormalData(world.seed + 1, size)]).not.toEqual([...data]);
    expect(waveNormalData(world.seed)).toHaveLength(WAVE_TEXTURE_SIZE * WAVE_TEXTURE_SIZE * 4);
  });
});
