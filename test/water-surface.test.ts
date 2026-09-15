import { describe, expect, it } from 'vitest';
import { daylightAt, tickAtHour } from '../src/render/daylight.ts';
import { SHADOW_DISTANCE } from '../src/render/sky.ts';
import { createWaterSurface } from '../src/render/water-surface.ts';
import { WATER_CELL } from '../src/render/water.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import type { WorldDescription } from '../src/world/types.ts';

const SIZE = 1600;
const CELL = 10;
/** Metres from the origin the shore stands at: far enough that no water falls within the camera's patch. */
const SHORE = 700;

/**
 * A hand-built world: one round island in the middle of the map, its ground
 * falling a metre every ten from the summit, so the shore is a circle of known
 * radius and everything past it is sea. Larger than the island of
 * `water.test.ts`, so the summit stands clear of the water the camera's patch
 * covers.
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
    roads: [],
    corridors: [],
    tram: { route: [], edges: [], corridors: [], stops: [], crossings: [], length: 0 },
  };
}

describe('the water surface', () => {
  it('hides the sheet where no water stands near, and shows it again where it does', () => {
    const surface = createWaterSurface(islandWorld());
    // Nothing has been said about where the camera stands yet.
    expect(surface.object.visible).toBe(true);

    // Inland: the shore is SHORE out and the patch the camera covers is
    // SHADOW_DISTANCE each way, so no drawn water falls in it.
    surface.follow(0, 0);
    expect(surface.object.visible).toBe(false);
    surface.follow(SHORE / 2, 0);
    expect(surface.object.visible).toBe(false);

    // At the shore and on the sea, the sheet is drawn, and the mirror with it.
    surface.follow(SHORE - SHADOW_DISTANCE, 0);
    expect(surface.object.visible).toBe(true);
    surface.follow(SHORE + 10 * WATER_CELL, 0);
    expect(surface.object.visible).toBe(true);

    // Driving back inland hides it again: the answer follows the camera.
    surface.follow(0, 0);
    expect(surface.object.visible).toBe(false);

    // Held out by hand, the sheet stays out whatever stands near.
    surface.shown = false;
    surface.follow(SHORE + 10 * WATER_CELL, 0);
    expect(surface.object.visible).toBe(false);
    surface.shown = true;
    surface.follow(SHORE + 10 * WATER_CELL, 0);
    expect(surface.object.visible).toBe(true);

    surface.dispose();
  });

  it("takes the light of the day and a new mirror share without rebuilding anything", () => {
    const surface = createWaterSurface(islandWorld());
    expect(() => {
      surface.setDaylight(daylightAt(tickAtHour(18)));
      surface.mirror = 0.2;
      surface.mirror = 0.35;
    }).not.toThrow();
    surface.dispose();
  });
});
