import { describe, expect, it } from 'vitest';
import { alleySeeds, type AlleyGround } from '../src/world/alleys.ts';
import { RoadNetwork } from '../src/world/road-network.ts';
import type { RoadCurve } from '../src/world/types.ts';

/**
 * An alley is one service lane inside one block (spec section 6.2). These pin
 * where `alleySeeds` says a lane is worth laying, on hand-built streets, so the
 * rule is readable without generating a world.
 */

/** A straight street running east to west at `y`. */
function street(id: number, y: number, from = -300, to = 300): RoadCurve {
  const points = [];
  for (let x = from; x <= to; x += 20) points.push({ x, y });
  return { id, tier: 'street', points, bridges: [], tunnels: [], interchanges: [], nodes: [] };
}

/** Downtown: 28 m of lot front to back, and a block 200 m long. */
const GROUND: AlleyGround = {
  within: () => true,
  minStrip: () => ({ depth: 28, area: 120 }),
  blockLength: () => 200,
  streetGap: () => 90,
};

/** The index the seeds are measured against: every street already laid. */
function indexOf(streets: readonly RoadCurve[]): RoadNetwork {
  const index = new RoadNetwork(2000, () => 0, 25);
  for (const curve of streets) index.add({ ...curve, interchanges: [] });
  return index;
}

describe('alleys', () => {
  it('lays a lane down the middle of a block deep enough to halve', () => {
    const streets = [street(0, 0), street(1, 100)];
    const seeds = alleySeeds(streets, indexOf(streets), GROUND);
    expect(seeds.length).toBeGreaterThan(0);
    // Every seed stands on the midline between the two streets, whichever of
    // them it was measured from.
    for (const seed of seeds) expect(Math.abs(seed.y - 50)).toBeLessThan(1);
  });

  it('refuses a block too shallow to leave a strip worth building on', () => {
    // 50 m apart leaves 25 m each side, and a 28 m lot front to back does not
    // fit in it, let alone beside the alley's own ground.
    const streets = [street(0, 0), street(1, 50)];
    expect(alleySeeds(streets, indexOf(streets), GROUND)).toEqual([]);
  });

  it('refuses open ground, where nothing stands within reach of the street', () => {
    const streets = [street(0, 0)];
    expect(alleySeeds(streets, indexOf(streets), GROUND)).toEqual([]);
  });

  it('offers the shallow side of a block first, so the lane runs down its long axis', () => {
    // A street with a deep block one side and a shallow one the other. The
    // shallow side is the one a lane halves, and the fill takes the first seed
    // it is given.
    const streets = [street(0, 0), street(1, 100), street(2, -160)];
    const seeds = alleySeeds(streets, indexOf(streets), GROUND);
    expect(seeds.length).toBeGreaterThan(0);
    expect(Math.abs((seeds[0] as { y: number }).y - 50)).toBeLessThan(1);
  });

  it('gives the same seeds in the same order however the streets are ordered', () => {
    const streets = [street(0, 0), street(1, 100), street(2, -160)];
    const forward = alleySeeds(streets, indexOf(streets), GROUND);
    const backward = alleySeeds([...streets].reverse(), indexOf(streets), GROUND);
    expect(backward.map((s) => [s.x, s.y])).toEqual(forward.map((s) => [s.x, s.y]));
  });
});
