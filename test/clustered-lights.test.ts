import { describe, expect, it } from 'vitest';
import { DirectionalLight, PointLight } from 'three';
import { LightsNode, type NodeFrame } from 'three/webgpu';
import { gridToBuild, PinnedClusterLightsNode, type GridSize } from '../src/render/clustered-lights.ts';

/** The addon's tile size, which every size is fitted to before it is compared. */
const TILE = 32;

/** 1600x900 fitted to whole 32-pixel tiles: 50 across, 29 down. */
const PINNED: GridSize = { width: 1600, height: 928 };

describe('gridToBuild', () => {
  it('builds the pinned grid first, fitted to whole tiles', () => {
    expect(gridToBuild(null, { width: 1600, height: 900 }, { width: 800, height: 450 }, TILE)).toEqual(PINNED);
  });

  it('keeps the grid over a buffer the pin already covers', () => {
    // The full-size buffer the pin was cut from, and the render scales of the
    // tiers below it (0.85, 0.75, 0.5): none of them may build anything.
    for (const scale of [1, 0.85, 0.75, 0.5]) {
      expect(
        gridToBuild(PINNED, PINNED, { width: Math.floor(1600 * scale), height: Math.floor(900 * scale) }, TILE),
      ).toBeNull();
    }
  });

  it('grows past the pin only for a buffer larger than the grid standing', () => {
    const grown = gridToBuild(PINNED, PINNED, { width: 2000, height: 1200 }, TILE);
    expect(grown).toEqual({ width: 2016, height: 1216 });
    // The grid now standing covers the old sizes, so they build nothing more.
    expect(gridToBuild(grown ?? PINNED, PINNED, { width: 1600, height: 900 }, TILE)).toBeNull();
  });

  it('grows when one axis alone outgrows the grid', () => {
    // A window made wider but no taller still widens the tiles, so the grid
    // follows the wider axis.
    expect(gridToBuild(PINNED, PINNED, { width: 1700, height: 900 }, TILE)).toEqual({ width: 1728, height: 928 });
  });
});

describe('PinnedClusterLightsNode', () => {
  it('keys the plain shader until a light it can cluster arrives, and again after it leaves', () => {
    const sun = new DirectionalLight();
    const node = new PinnedClusterLightsNode({ width: 1600, height: 900 });
    const plain = new LightsNode().setLights([sun]).customCacheKey();

    node.setLights([sun]);
    expect(node.customCacheKey()).toBe(plain);

    node.setLights([sun, new PointLight()]);
    expect(node.customCacheKey()).not.toBe(plain);

    node.setLights([sun]);
    expect(node.customCacheKey()).toBe(plain);
  });

  it('runs no compute while there is nothing to cluster', () => {
    const node = new PinnedClusterLightsNode({ width: 1600, height: 900 }).setLights([new DirectionalLight()]);
    // A frame with no renderer: the addon's own update would throw on it.
    expect(node.updateBefore({} as NodeFrame)).toBeUndefined();
  });
});
