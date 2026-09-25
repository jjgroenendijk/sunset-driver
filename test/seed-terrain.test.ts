import { expect, it } from 'vitest';
import { buildWaterAttributes } from '../src/render/water.ts';
import { compareNumbers } from '../src/core/sort.ts';
import { archetypeNamed } from '../src/world/archetype.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { MAX_WORLD_SIZE, MIN_WORLD_SIZE } from '../src/world/size.ts';
import { coastNoise, islandAt, TERRAIN_CELL } from '../src/world/terrain.ts';
import { type Point, type WorldDescription } from '../src/world/types.ts';
import { stableJson } from './helpers.ts';
import { REPEAT_COUNT } from './seed-limits.ts';
import { wetFraction, standsClearOfWater, heightsHash, seaFraction } from './seed-probes.ts';
import { seeds, worlds, repeats } from './seed-fixture.ts';
import { sweepSuite } from './seed-suite.ts';

/**
 * The seed sweep of spec section 3, on the ground a world is built on: its size,
 * its heights, its islands and its water.
 */
sweepSuite('terrain', () => {
  it('is byte-identical across runs', () => {
    for (const seed of seeds.slice(0, REPEAT_COUNT)) {
      const a = worlds.get(seed) as WorldDescription;
      const b = repeats.get(seed) as WorldDescription;
      expect(heightsHash(b.terrain.heights)).toBe(heightsHash(a.terrain.heights));
      expect(stableJson({ ...b, terrain: null })).toBe(stableJson({ ...a, terrain: null }));
    }
  });

  it('draws a square world between 3 km and 6 km', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      expect(w.size).toBeGreaterThanOrEqual(MIN_WORLD_SIZE);
      expect(w.size).toBeLessThanOrEqual(MAX_WORLD_SIZE);
      expect(w.size % TERRAIN_CELL).toBe(0);
      expect(new Heightfield(w.terrain).extent).toBe(w.size);
    }
  });

  it('keeps every height finite and bounded', () => {
    for (const seed of seeds) {
      const h = (worlds.get(seed) as WorldDescription).terrain.heights;
      let min = Infinity;
      let max = -Infinity;
      let finite = true;
      for (let i = 0; i < h.length; i++) {
        const v = h[i] as number;
        if (!Number.isFinite(v)) finite = false;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      expect(finite, `seed ${seed}`).toBe(true);
      expect(min).toBeGreaterThan(-40);
      expect(max).toBeLessThan(260);
    }
  });

  it('holds as many islands as its archetype asks for, and some sea', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const f = seaFraction(w);
      expect(f, `seed ${seed}`).toBeGreaterThan(0.12);
      const { islands } = archetypeNamed(w.archetype);
      expect(w.water.islands.length, `seed ${seed}, ${w.archetype}`).toBeGreaterThanOrEqual(islands.min);
      expect(w.water.islands.length, `seed ${seed}, ${w.archetype}`).toBeLessThanOrEqual(islands.max);
    }
  });

  it('puts the core on dry, gentle ground', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      expect(hf.sample(w.core.x, w.core.y), `seed ${seed}, ${w.archetype}`).toBeGreaterThan(w.water.seaLevel);
      expect(hf.slope(w.core.x, w.core.y), `seed ${seed}, ${w.archetype}`).toBeLessThan(0.15);
    }
  });

  it('carves every river below sea level from source to mouth, and the harbour', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      for (const river of w.water.rivers) {
        for (const p of river.path) expect(hf.sample(p.x, p.y)).toBeLessThan(w.water.seaLevel);
      }
      expect(hf.sample(w.water.harbour.x, w.water.harbour.y)).toBeLessThan(-5);
    }
  });

  it('lays one water surface over the sea, the straits, the river and the harbour', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const water = buildWaterAttributes(w);
      // The cells the sheet drew, one flag per cell of its grid. A sheet holds
      // tens of thousands of them, so the flags are a byte each rather than a
      // key in a set.
      const drawn = new Uint8Array(water.gridSize * water.gridSize);
      for (let t = 0; t < water.indices.length; t += 6) drawn[water.indices[t] as number] = 1;
      const covers = (p: Point): boolean => {
        const column = Math.floor((p.x - water.minX) / water.cell);
        const row = Math.floor((p.y - water.minY) / water.cell);
        if (column < 0 || row < 0 || column >= water.gridSize || row >= water.gridSize) return false;
        return drawn[row * water.gridSize + column] === 1;
      };

      expect(covers(w.water.harbour), `seed ${seed}: the harbour is dry`).toBe(true);
      // The river is the narrowest water on the map, so it is what says whether
      // the sheet is cut finely enough to hold a channel.
      for (const p of w.water.rivers.flatMap((river) => river.path)) {
        expect(covers(p), `seed ${seed}: the river at ${p.x.toFixed(0)}, ${p.y.toFixed(0)} is dry`).toBe(true);
      }
      for (const c of w.water.crossings) {
        const mid = { x: (c.from.x + c.to.x) / 2, y: (c.from.y + c.to.y) / 2 };
        if (hf.sample(mid.x, mid.y) >= w.water.seaLevel) continue;
        expect(covers(mid), `seed ${seed}: the strait between ${c.fromIsland} and ${c.toIsland} is dry`).toBe(true);
      }
      // Dry ground carries no water: a district that stands clear of the shore
      // has none of the sheet over it.
      for (const d of w.districts) {
        if (!standsClearOfWater(hf, d.x, d.y, w.water.seaLevel, water.cell)) continue;
        expect(covers(d), `seed ${seed}: water stands over ${d.name}`).toBe(false);
      }
    }
  });

  it('links every island to the rest by short shore-to-shore crossings', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const noise = coastNoise(w.seed);
      const landOf = (p: Point): number => islandAt(w.water.islands, w.size, noise, p.x, p.y);
      const idOf = (i: number): number => (w.water.islands[i] as { id: number }).id;
      for (const isl of w.water.islands) expect(hf.sample(isl.x, isl.y), `island ${isl.id} seed ${seed}`).toBeGreaterThan(w.water.seaLevel);
      // Union-find over crossings: one connected archipelago. A crossing names
      // its islands by id, and an id is not an index: the islands dropped
      // while the map was planned leave gaps in the ids.
      const indexOf = (id: number): number => w.water.islands.findIndex((isl) => isl.id === id);
      const parent = w.water.islands.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] as number)));
      for (const c of w.water.crossings) {
        const { from, to } = c;
        expect(hf.sample(from.x, from.y)).toBeGreaterThanOrEqual(w.water.seaLevel);
        expect(hf.sample(to.x, to.y)).toBeGreaterThanOrEqual(w.water.seaLevel);
        // Both bridge heads stand on the island the crossing claims, so the
        // union-find above joins the land the roads will actually reach. A
        // chord that lands on one island twice, or on a rock in the strait,
        // bridges nothing (spec section 7.2).
        expect(c.fromIsland, `seed ${seed}: a crossing joins island ${c.fromIsland} to itself`).not.toBe(c.toIsland);
        const ends = [idOf(landOf(from)), idOf(landOf(to))].sort(compareNumbers);
        const claimed = [c.fromIsland, c.toIsland].sort(compareNumbers);
        expect(ends, `seed ${seed}: a crossing claims islands ${claimed.join(' and ')} but lands on ${ends.join(' and ')}`).toEqual(claimed);
        // Water under most of the span. Not all of it: a crossing may step over
        // a rock in the strait to reach ground a bridge head can stand on.
        expect(wetFraction(hf, from, to, w.water.seaLevel), `seed ${seed}`).toBeGreaterThan(0.5);
        const span = Math.hypot(from.x - to.x, from.y - to.y);
        expect(span).toBeGreaterThan(20);
        expect(span, `seed ${seed}`).toBeLessThan(w.size * 0.12);
        parent[find(indexOf(c.fromIsland))] = find(indexOf(c.toIsland));
      }
      const roots = new Set(w.water.islands.map((_, i) => find(i)));
      expect(roots.size, `seed ${seed}`).toBe(1);
    }
  });
});
