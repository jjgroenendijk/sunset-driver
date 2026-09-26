import { describe, expect, it } from 'vitest';
import { Heightfield } from '../../../src/world/terrain/heightfield.ts';
import { RiverWater } from '../../../src/world/decks/river-decks.ts';
import type { Point, RiverDescription } from '../../../src/world/types.ts';

/**
 * A river 40 m wide running north up the middle of a 2 km map to its mouth at
 * the top, and a pond of other water to the east of it.
 */
function rivers(): RiverWater {
  const hf = Heightfield.create(201, 10);
  for (let iy = 0; iy < 201; iy++) {
    for (let ix = 0; ix < 201; ix++) {
      const x = hf.worldX(ix);
      const y = hf.worldY(iy);
      const river = Math.abs(x) < 30;
      const pond = Math.abs(x - 500) < 40 && Math.abs(y) < 40;
      hf.set(ix, iy, river || pond ? -4 : 5);
    }
  }
  const path: Point[] = [];
  const halfWidths: number[] = [];
  for (let i = 0; i <= 20; i++) {
    path.push({ x: 0, y: -1000 + i * 100 });
    halfWidths.push(20);
  }
  const river: RiverDescription = { path, halfWidths };
  return new RiverWater([river], hf, 0);
}

describe('river decks', () => {
  const water = rivers();

  it('takes a short deck square across the river', () => {
    expect(water.spans({ x: -60, y: 0 }, { x: 60, y: 0 })).toBe(true);
    expect(water.spans({ x: -50, y: -30 }, { x: 50, y: 20 })).toBe(true);
  });

  it('refuses a deck that runs along the river rather than across it', () => {
    expect(water.spans({ x: -60, y: -100 }, { x: 60, y: 100 })).toBe(false);
  });

  it('refuses a deck that ends in the water', () => {
    expect(water.spans({ x: -60, y: 0 }, { x: 10, y: 0 })).toBe(false);
  });

  it('refuses a deck longer than a river crossing needs', () => {
    expect(water.spans({ x: -200, y: 0 }, { x: 200, y: 0 })).toBe(false);
  });

  it('refuses a deck near the mouth, where the river runs into the sea', () => {
    expect(water.spans({ x: -60, y: 900 }, { x: 60, y: 900 })).toBe(false);
  });

  it('refuses a deck over water that is not a river', () => {
    expect(water.spans({ x: 440, y: 0 }, { x: 560, y: 0 })).toBe(false);
  });

  it('bridges nothing on a map with no river', () => {
    const dry = new RiverWater([], Heightfield.create(3, 10), 0);
    expect(dry.spans({ x: -60, y: 0 }, { x: 60, y: 0 })).toBe(false);
  });
});
