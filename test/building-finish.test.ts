import type { BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import type { BuildingKind } from '../src/world/buildings.ts';
import { BLOCK_BEACON, BLOCK_CROWN } from '../src/render/block-mesh.ts';
import {
  FINISH_STEP,
  GLOW_FLUORESCENT,
  GLOW_KINDS,
  GLOW_WARM,
  WALL_CONCRETE,
  WALL_METAL,
  WALL_STUCCO,
  finishCode,
  finishOf,
} from '../src/render/building-finish.ts';
import { buildChunkBuildings, type BuildingPlacement } from '../src/render/building-mesh.ts';
import { beaconPhase, daylightAt, BEACON_CYCLE } from '../src/render/daylight.ts';
import { tickAtHour } from '../src/render/daylight.ts';
import { buildingOf, chunkOf, districtOf, lookupOf } from './building-fixture.ts';

/** A rich, dense downtown, where a tower stands tall enough to carry a beacon. */
const CORE = districtOf('core', 0.7, 'none', 0.8);
/** A poor outer district, where the walls are the grimiest. */
const EDGE = districtOf('suburban', 0.1, 'none', 0.2);

const KINDS: readonly BuildingKind[] = [
  'tower',
  'mid-rise',
  'shop-row',
  'house',
  'warehouse',
  'roadhouse',
  'parking-garage',
];

/** The finish of one kind at a seed, in the core. */
function finish(kind: BuildingKind, seed: number, wealth = CORE.wealth) {
  return finishOf(kind, 'masonry', seed, wealth);
}

describe('the finish of a building', () => {
  it('gives every kind a wall, a light and a weathering inside their ranges', () => {
    for (const kind of KINDS) {
      for (let seed = 1; seed < 60; seed++) {
        const one = finish(kind, seed);
        expect(one.wall, kind).toBeGreaterThanOrEqual(0);
        expect(one.wall, kind).toBeLessThan(6);
        expect(one.glow, kind).toBeLessThan(GLOW_KINDS);
        expect(one.lit, kind).toBeGreaterThan(0);
        expect(one.lit, kind).toBeLessThanOrEqual(1);
        expect(one.age, kind).toBeGreaterThanOrEqual(0);
        expect(one.age, kind).toBeLessThanOrEqual(1);
      }
    }
  });

  it('builds a warehouse of corrugated metal and a parking garage of concrete', () => {
    for (let seed = 1; seed < 40; seed++) {
      expect([WALL_METAL, WALL_CONCRETE]).toContain(finish('warehouse', seed).wall);
      expect(finish('parking-garage', seed).wall).toBe(WALL_CONCRETE);
    }
  });

  it('lets a style overrule the kind, so a Miami tower is stucco', () => {
    for (let seed = 1; seed < 20; seed++) {
      expect(finishOf('tower', 'miami', seed, 0.6).wall).toBe(WALL_STUCCO);
      expect(finishOf('tower', 'brutalist', seed, 0.6).wall).toBe(WALL_CONCRETE);
    }
  });

  it('lights a rich tower as offices and a poor one as flats', () => {
    const rich = [...Array(60).keys()].filter((seed) => finish('tower', seed, 0.95).glow === GLOW_FLUORESCENT);
    const poor = [...Array(60).keys()].filter((seed) => finish('tower', seed, 0.05).glow === GLOW_WARM);
    expect(rich.length).toBeGreaterThan(30);
    expect(poor.length).toBeGreaterThan(30);
  });

  it('weathers a poor district harder than a rich one', () => {
    let grimier = 0;
    for (let seed = 1; seed < 60; seed++) {
      if (finish('house', seed, 0.1).age > finish('house', seed, 0.9).age) grimier++;
    }
    expect(grimier).toBe(59);
  });

  it('survives the byte the facade is packed into, wall and light alike', () => {
    for (const kind of KINDS) {
      for (let seed = 1; seed < 40; seed++) {
        const one = finish(kind, seed);
        const code = finishCode(one);
        // What `facade-pack.ts` does to the channel, and what the material undoes.
        const byte = Math.round(code[0] * 255);
        const number = Math.round(byte / FINISH_STEP);
        expect(Math.floor(number / GLOW_KINDS), kind).toBe(one.wall);
        expect(number % GLOW_KINDS, kind).toBe(one.glow);
      }
    }
  });
});

/** The parts a building's shell and its rooftop dressing carry. */
function partsOf(placed: BuildingPlacement): Set<number> {
  const out = new Set<number>();
  for (const geometry of [placed.shell, placed.dress]) {
    const part = geometry?.getAttribute('part') as BufferAttribute | undefined;
    if (part === undefined) continue;
    for (let v = 0; v < part.count; v++) out.add(part.getX(v));
  }
  return out;
}

/** The finish every vertex of a shell carries, which is the building's own. */
function codeOf(placed: BuildingPlacement): readonly number[] {
  const finish = placed.shell.getAttribute('finish') as BufferAttribute;
  return [finish.getX(0), finish.getY(0), finish.getZ(0)];
}

describe('the finish on the geometry', () => {
  it('writes one finish on every vertex of a building, at every detail', () => {
    const building = { ...buildingOf(0, 'house', 9), zone: 'suburban' as const };
    const near = codeOf(buildChunkBuildings(chunkOf([building]), lookupOf(EDGE), 'near')[0] as BuildingPlacement);
    for (const detail of ['mid', 'far'] as const) {
      const placed = buildChunkBuildings(chunkOf([building]), lookupOf(EDGE), detail)[0] as BuildingPlacement;
      expect(codeOf(placed), detail).toEqual(near);
      const finish = placed.shell.getAttribute('finish') as BufferAttribute;
      expect(finish.count).toBe(placed.shell.getAttribute('position').count);
    }
  });

  it('crowns a tall tower and beacons it, at near detail and at mid', () => {
    const tower = { ...buildingOf(0, 'tower', 3), zone: 'core' as const, skyline: 0.95 };
    for (const detail of ['near', 'mid'] as const) {
      const tall = buildChunkBuildings(chunkOf([tower]), lookupOf(CORE), detail)[0] as BuildingPlacement;
      expect(partsOf(tall), detail).toContain(BLOCK_CROWN);
      expect(partsOf(tall), detail).toContain(BLOCK_BEACON);
    }

    const house = { ...buildingOf(0, 'house', 3), zone: 'suburban' as const };
    const low = buildChunkBuildings(chunkOf([house]), lookupOf(EDGE), 'near')[0] as BuildingPlacement;
    expect(partsOf(low)).not.toContain(BLOCK_BEACON);
    expect(partsOf(low)).not.toContain(BLOCK_CROWN);
  });
});

describe('the small hours and the blink', () => {
  it('is deepest in the small hours and gone by day', () => {
    expect(daylightAt(tickAtHour(2)).late).toBe(1);
    expect(daylightAt(tickAtHour(23)).late).toBeGreaterThan(0.2);
    expect(daylightAt(tickAtHour(14)).late).toBe(0);
    expect(daylightAt(tickAtHour(20)).late).toBe(0);
  });

  it('blinks the beacons once a cycle, off the tick alone', () => {
    expect(beaconPhase(0)).toBe(0);
    expect(beaconPhase(BEACON_CYCLE)).toBe(0);
    expect(beaconPhase(BEACON_CYCLE / 2)).toBeCloseTo(0.5);
    expect(beaconPhase(7 * BEACON_CYCLE + 9)).toBeCloseTo(9 / BEACON_CYCLE);
  });
});
