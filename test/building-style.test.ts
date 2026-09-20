import { describe, expect, it } from 'vitest';
import type { BufferAttribute } from 'three';
import {
  BLOCK_CONCRETE,
  BLOCK_CURTAIN,
  BLOCK_NEON,
  BLOCK_PORTHOLE,
  BLOCK_STONE,
  BLOCK_STUCCO,
} from '../src/render/block-mesh.ts';
import {
  buildChunkBuildings,
  massingOf,
  shapeOf,
  styleOf,
  type BuildingPlacement,
  type BuildingStyle,
} from '../src/render/building-mesh.ts';
import { planFor } from '../src/render/building-style.ts';
import { buildingOf, chunkOf, districtOf, lookupOf, GROUND } from './building-fixture.ts';
import type { Building } from '../src/world/buildings.ts';
import type { District } from '../src/world/types.ts';

/** A rich, dense downtown on the coast, where every style of spec section 10.3 can stand. */
const CORE: District = districtOf('core', 0.7, 'none', 0.8);

/** A tower on a wide lot, tall enough for every style, standing in the core. */
function towerOf(id: number, seed: number): Building {
  return { ...buildingOf(id, 'tower', seed), zone: 'core', skyline: 0.9 };
}

/** The style of a tower with this seed, on the ground the fixture stands on. */
function styleFor(seed: number): BuildingStyle {
  const building = towerOf(0, seed);
  return styleOf(building, CORE, GROUND, massingOf(building, CORE, 0).height);
}

/** The first seed that draws a style, so each test reads one style at a time. */
function seedFor(style: BuildingStyle): number {
  for (let seed = 1; seed < 500; seed++) if (styleFor(seed) === style) return seed;
  throw new Error(`no seed draws ${style}`);
}

/** The parts a built shell carries, as a set of the numbers in its `part` attribute. */
function partsOf(placed: BuildingPlacement): Set<number> {
  const part = placed.shell.getAttribute('part') as BufferAttribute | undefined;
  const out = new Set<number>();
  if (part === undefined) return out;
  for (let v = 0; v < part.count; v++) out.add(part.getX(v));
  return out;
}

function built(seed: number, detail: 'near' | 'mid' | 'far' = 'near'): BuildingPlacement {
  return buildChunkBuildings(chunkOf([towerOf(0, seed)]), lookupOf(CORE), detail)[0] as BuildingPlacement;
}

const STYLES: readonly BuildingStyle[] = ['masonry', 'glass', 'brutalist', 'deco', 'miami'];

describe('the style a tall building is dressed in', () => {
  it('draws all five styles of spec section 10.3 in one downtown', () => {
    const drawn = new Set<BuildingStyle>();
    for (let seed = 1; seed < 200; seed++) drawn.add(styleFor(seed));
    for (const style of STYLES) expect(drawn, style).toContain(style);
  });

  it('gives a building the same style at every detail, since nothing about it moves', () => {
    for (let seed = 1; seed < 40; seed++) expect(styleFor(seed)).toBe(styleFor(seed));
  });

  it('never styles a building that is not a tower or a mid-rise', () => {
    for (const kind of ['house', 'shop-row', 'warehouse', 'roadhouse', 'parking-garage'] as const) {
      for (let seed = 1; seed < 40; seed++) {
        const building = { ...buildingOf(0, kind, seed), zone: 'core' as const, skyline: 0.9 };
        expect(styleOf(building, CORE, GROUND, 40), kind).toBe('masonry');
      }
    }
  });

  it('builds every styled tower as a block, so no style costs a draw call of its own', () => {
    for (const style of STYLES) {
      const placed = built(seedFor(style));
      expect(placed.batch, style).toBe(style === 'masonry' ? 'facade' : 'block');
    }
  });

  it('masses an Art Deco tower as the stack of setbacks the style is', () => {
    expect(planFor('deco')).toBe('setbacks');
    const building = towerOf(0, seedFor('deco'));
    const massing = massingOf(building, CORE, 0);
    const shape = shapeOf(building.seed, 'tower', massing, building.shared, planFor('deco'));
    expect(shape.plan).toBe('setbacks');
    expect(shape.parts.length).toBeGreaterThan(1);
  });

  it('gives each style the surfaces it is drawn by', () => {
    // The material shades a wall by its part, so this is what tells a curtain
    // wall from raw concrete once both are in the same batch.
    const wants: Readonly<Record<string, readonly number[]>> = {
      glass: [BLOCK_CURTAIN],
      brutalist: [BLOCK_CONCRETE],
      deco: [BLOCK_STONE, BLOCK_NEON],
      miami: [BLOCK_STUCCO, BLOCK_PORTHOLE, BLOCK_NEON],
    };
    for (const style of ['glass', 'brutalist', 'deco', 'miami'] as const) {
      const parts = partsOf(built(seedFor(style)));
      for (const part of wants[style] as readonly number[]) expect(parts, `${style} part ${part}`).toContain(part);
    }
  });

  it('keeps a styled tower its own colour at every detail', () => {
    for (const style of ['glass', 'brutalist', 'deco', 'miami'] as const) {
      const seed = seedFor(style);
      const near = tintOf(built(seed, 'near'));
      for (const detail of ['mid', 'far'] as const) expect(tintOf(built(seed, detail)), style).toEqual(near);
    }
  });

  it('costs a fraction at mid detail of what it costs at near, as the LOD asks', () => {
    for (const style of ['glass', 'brutalist', 'deco', 'miami'] as const) {
      const seed = seedFor(style);
      const near = count(built(seed, 'near'));
      const mid = count(built(seed, 'mid'));
      expect(mid, style).toBeLessThan(near / 4);
      expect(mid, style).toBeGreaterThan(count(built(seed, 'far')));
    }
  });
});

/** The colour every vertex of a shell carries, which is the building's own. */
function tintOf(placed: BuildingPlacement): readonly number[] {
  const tint = placed.shell.getAttribute('tint') as BufferAttribute;
  return [tint.getX(0), tint.getY(0), tint.getZ(0)].map((one) => Math.round(one * 255));
}

function count(placed: BuildingPlacement): number {
  return placed.shell.getAttribute('position').count;
}
