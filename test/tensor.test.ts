import { beforeAll, describe, expect, it } from 'vitest';
import { directionDelta } from '../src/core/math.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { buildTensorField, type TensorField } from '../src/world/tensor.ts';
import type { WorldDescription } from '../src/world/types.ts';
import { landPoints, sweepSeeds } from './helpers.ts';
import { worldsFor } from './world-pool.ts';

/** A field costs a whole world to build, so the quick tier takes a couple of seeds. */
const SEED_COUNT = process.env.SWEEP_SEEDS ? 12 : 2;
const DEG = Math.PI / 180;
const deg = (radians: number): string => `${(radians / DEG).toFixed(1)}°`;

interface Case {
  seed: number;
  world: WorldDescription;
  hf: Heightfield;
  field: TensorField;
}
const cases: Case[] = [];
/** The generated worlds, in seed order; filled before any test runs. */
const worlds: WorldDescription[] = [];

/**
 * Nearest sea cell within `limit` metres, over the height grid itself. The
 * field follows a smoothed shoreline; this is the unsmoothed truth it is
 * measured against.
 */
function nearestWater(hf: Heightfield, seaLevel: number, x: number, y: number, limit: number): { d: number; toWater: number } | undefined {
  const cells = Math.ceil(limit / hf.cellSize);
  const cx = Math.round((x - hf.originX) / hf.cellSize);
  const cy = Math.round((y - hf.originY) / hf.cellSize);
  let best = Infinity;
  let toWater = 0;
  for (let iy = cy - cells; iy <= cy + cells; iy++) {
    for (let ix = cx - cells; ix <= cx + cells; ix++) {
      if (hf.at(ix, iy) >= seaLevel) continue;
      const px = hf.worldX(ix);
      const py = hf.worldY(iy);
      const d = Math.hypot(px - x, py - y);
      if (d < best) {
        best = d;
        toWater = Math.atan2(py - y, px - x);
      }
    }
  }
  return best <= limit ? { d: best, toWater } : undefined;
}

function quantile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
}

describe(`tensor field (${SEED_COUNT} seeds)`, () => {
  const seeds = sweepSeeds(SEED_COUNT);
  /** The first seed's world, generated a second time for the purity check. */
  let regeneratedFirst: WorldDescription;

  beforeAll(async () => {
    // Every seed, then the first seed again for the purity check below.
    const generated = await worldsFor([...seeds, seeds[0] as number]);
    worlds.push(...generated.slice(0, seeds.length));
    regeneratedFirst = generated[seeds.length] as WorldDescription;
  });

  it('builds a field for every seed', () => {
    for (let i = 0; i < seeds.length; i++) {
      const world = worlds[i] as WorldDescription;
      const hf = new Heightfield(world.terrain);
      cases.push({ seed: seeds[i] as number, world, hf, field: buildTensorField(world) });
    }
    for (const c of cases) expect(c.field.grids.length).toBeGreaterThan(0);
  });

  it('is a pure function of the world description', () => {
    for (const c of cases) {
      // Same world twice: the build carries nothing over between fields.
      const twin = buildTensorField(c.world);
      // And from a world regenerated from the seed: pure all the way down. Only
      // the first seed pays for a second generation; the sweep covers the rest.
      const regenerated = c === cases[0] ? buildTensorField(regeneratedFirst) : twin;
      for (const again of [twin, regenerated]) {
        expect(again.cityAngle).toBe(c.field.cityAngle);
        expect(again.grids).toStrictEqual(c.field.grids);
        for (const p of landPoints(c.world, 200, 0xd37)) {
          const a = c.field.sample(p.x, p.y);
          const b = again.sample(p.x, p.y);
          expect(b.major).toBe(a.major);
          expect(b.minor).toBe(a.minor);
          expect(b.strength).toBe(a.strength);
        }
      }
    }
    // Different seeds, different city: the field is seeded, not fixed.
    const angles = new Set(cases.map((c) => c.field.cityAngle));
    expect(angles.size).toBe(cases.length);
  });

  it('keeps the major and minor directions square and in range', () => {
    for (const c of cases) {
      for (const p of landPoints(c.world, 200, 0xa11)) {
        const s = c.field.sample(p.x, p.y);
        expect(Number.isFinite(s.major)).toBe(true);
        expect(s.major).toBeGreaterThan(-Math.PI / 2);
        expect(s.major).toBeLessThanOrEqual(Math.PI / 2);
        expect(directionDelta(s.minor, s.major + Math.PI / 2)).toBeLessThan(1e-9);
        expect(s.strength).toBeGreaterThanOrEqual(0);
        expect(s.strength).toBeLessThanOrEqual(1);
      }
    }
  });

  it('turns continuously: neighbouring samples differ by a small angle', () => {
    for (const c of cases) {
      const near: number[] = [];
      const far: number[] = [];
      for (const p of landPoints(c.world, 1500, 0xc07)) {
        const s = c.field.sample(p.x, p.y);
        // Where the influences cancel the field prefers no direction at all, and
        // the direction it reports is meaningless. Streamlines stop there too.
        if (s.strength < 0.15) continue;
        far.push(Math.max(directionDelta(s.major, c.field.majorAt(p.x + 2, p.y)), directionDelta(s.major, c.field.majorAt(p.x, p.y + 2))));
        near.push(Math.max(directionDelta(s.major, c.field.majorAt(p.x + 0.5, p.y)), directionDelta(s.major, c.field.majorAt(p.x, p.y + 0.5))));
      }
      expect(far.length).toBeGreaterThan(100);
      far.sort((a, b) => a - b);
      near.sort((a, b) => a - b);
      const median = quantile(far, 0.5);
      const p99 = quantile(far, 0.99);
      expect(median, `seed ${c.seed}: median turn over 2 m ${deg(median)}`).toBeLessThan(3 * DEG);
      expect(p99, `seed ${c.seed}: 99th percentile turn over 2 m ${deg(p99)}`).toBeLessThan(10 * DEG);
      // The sharpest bend is a kink, not a jump: a quarter of the step turns a
      // quarter as far, which a discontinuity would not do.
      const worstNear = quantile(near, 1);
      expect(worstNear, `seed ${c.seed}: worst turn over 0.5 m ${deg(worstNear)}`).toBeLessThan(20 * DEG);
    }
  });

  it('lays a planned district out on its own grid', () => {
    let checked = 0;
    for (const c of cases) {
      const devs: number[] = [];
      for (const g of c.field.grids) {
        const d = c.world.districts[g.districtId];
        if (!d || (d.zone !== 'core' && d.zone !== 'inner' && d.zone !== 'industrial')) continue;
        // Steep ground and the waterfront are meant to override the grid; this is
        // about the quiet interior, where nothing else is pulling.
        if (c.hf.slope(g.x, g.y) > 0.05) continue;
        if (nearestWater(c.hf, c.world.water.seaLevel, g.x, g.y, 300)) continue;
        const dev = directionDelta(c.field.majorAt(g.x, g.y), g.angle);
        expect(dev, `${d.name} (seed ${c.seed}) runs ${deg(dev)} off its grid`).toBeLessThan(25 * DEG);
        devs.push(dev);
      }
      checked += devs.length;
      if (devs.length >= 4) {
        devs.sort((a, b) => a - b);
        expect(quantile(devs, 0.5), `seed ${c.seed} median grid deviation`).toBeLessThan(12 * DEG);
      }
    }
    expect(checked).toBeGreaterThan(2 * SEED_COUNT);
  });

  it('runs parallel to the shore at the waterfront', () => {
    for (const c of cases) {
      const devs: number[] = [];
      for (const p of landPoints(c.world, 4000, 0x5ea)) {
        if (devs.length >= 60) break;
        const w = nearestWater(c.hf, c.world.water.seaLevel, p.x, p.y, 90);
        // Right at the edge the nearest wet cell is a poor normal; a little back
        // from it the shore has a direction worth following.
        if (!w || w.d < 25) continue;
        devs.push(directionDelta(c.field.majorAt(p.x, p.y), w.toWater + Math.PI / 2));
      }
      expect(devs.length, `seed ${c.seed}: waterfront samples`).toBeGreaterThan(20);
      devs.sort((a, b) => a - b);
      const median = quantile(devs, 0.5);
      const p75 = quantile(devs, 0.75);
      expect(median, `seed ${c.seed}: median ${deg(median)} off the shore`).toBeLessThan(20 * DEG);
      expect(p75, `seed ${c.seed}: 75th percentile ${deg(p75)} off the shore`).toBeLessThan(30 * DEG);
    }
  });

  it('follows the contour on steep ground', () => {
    for (const c of cases) {
      const devs: number[] = [];
      for (const p of landPoints(c.world, 6000, 0x510e)) {
        if (devs.length >= 60) break;
        if (c.hf.slope(p.x, p.y) < 0.25) continue;
        if (nearestWater(c.hf, c.world.water.seaLevel, p.x, p.y, 200)) continue;
        const g = c.hf.gradient(p.x, p.y);
        devs.push(directionDelta(c.field.majorAt(p.x, p.y), Math.atan2(g.gy, g.gx) + Math.PI / 2));
      }
      expect(devs.length, `seed ${c.seed}: steep samples`).toBeGreaterThan(20);
      devs.sort((a, b) => a - b);
      const median = quantile(devs, 0.5);
      expect(median, `seed ${c.seed}: median ${deg(median)} off the contour`).toBeLessThan(25 * DEG);
    }
  });
});
