import { describe, expect, it } from 'vitest';
import { GradedLand } from '../../../src/world/carve/graded-land.ts';
import { Heightfield } from '../../../src/world/terrain/heightfield.ts';
import { DRY_MARGIN } from '../../../src/world/roads/road-ground.ts';
import { SEA_LEVEL } from '../../../src/world/terrain/terrain.ts';
import { TIERS } from '../../../src/world/roads/tiers.ts';
import type { Crossing } from '../../../src/world/types.ts';

/**
 * The land a road of one tier can climb to (issue #399). The fields below are
 * built by hand, so what each check turns on is one feature of the ground: a
 * step, a knoll, a strait.
 */

/** Metres between the nodes of the test grids, and nodes per side. */
const CELL = 10;
const NODES = 41;

/** A heightfield of {@link NODES} nodes a side, filled from a function of the world point. */
function field(height: (x: number, y: number) => number): Heightfield {
  const hf = Heightfield.create(NODES, CELL);
  for (let iy = 0; iy < NODES; iy++) {
    for (let ix = 0; ix < NODES; ix++) hf.set(ix, iy, height(hf.worldX(ix), hf.worldY(iy)));
  }
  return hf;
}

/** Ground a road can drive on, well clear of the waterline. */
const DRY = SEA_LEVEL + DRY_MARGIN + 5;
const CORE = { x: 0, y: 0 };
const STREET = TIERS.street.maxGrade;

describe('graded land', () => {
  it('climbs a slope the tier accepts and stops at one it does not', () => {
    // A ramp of one metre per cell is a grade of 0.1: a street climbs it and a
    // highway does not, and both stand on the same ground.
    const ramp = field((x) => DRY + Math.max(0, x / CELL));
    expect(new GradedLand(ramp, CORE, STREET).at(190, 0)).toBe(true);
    expect(new GradedLand(ramp, CORE, TIERS.highway.maxGrade).at(190, 0)).toBe(false);
  });

  it('leaves a knoll behind steep ground unreached, however flat its top', () => {
    // A flat top 20 m over the plain, with one cell of cliff round it: no road
    // of any tier steps up 20 m in 10 m, so nothing reaches the top.
    const knoll = field((x, y) => (Math.abs(x - 150) <= 30 && Math.abs(y) <= 30 ? DRY + 20 : DRY));
    const graded = new GradedLand(knoll, CORE, STREET);
    expect(graded.at(100, 0)).toBe(true);
    expect(graded.at(150, 0)).toBe(false);
    expect(graded.at(150, 20)).toBe(false);
  });

  it('stays on dry ground and will not wade a strait', () => {
    const split = field((x) => (Math.abs(x - 150) <= 20 ? SEA_LEVEL - 5 : DRY));
    expect(new GradedLand(split, CORE, STREET).at(200, 0)).toBe(false);
  });

  it('goes on from the head of a crossing, and from the head of the next', () => {
    // Three plains in a row, split by two straits. The crossings bridge them in
    // turn, so the far plain is reached over the near one and not on its own.
    const wet = (x: number): boolean => Math.abs(x - 100) <= 20 || Math.abs(x + 100) <= 20;
    const chain = field((x) => (wet(x) ? SEA_LEVEL - 5 : DRY));
    const bridge = (fromX: number, toX: number): Crossing => ({
      fromIsland: 0,
      toIsland: 1,
      from: { x: fromX, y: 0 },
      to: { x: toX, y: 0 },
    });
    const crossings = [bridge(80, 120), bridge(-80, -120)];
    const graded = new GradedLand(chain, CORE, STREET, crossings);
    expect(graded.at(150, 0)).toBe(true);
    expect(graded.at(-150, 0)).toBe(true);
    expect(new GradedLand(chain, CORE, STREET).at(150, 0)).toBe(false);
  });

  it('hops no crossing whose near head it cannot climb to', () => {
    // The near head stands on a knoll the street cannot climb, so the bridge is
    // never arrived at and the far shore stays unreached.
    const ledge = field((x) => {
      if (x < 60) return DRY;
      if (x <= 100) return DRY + 30;
      if (x <= 140) return SEA_LEVEL - 5;
      return DRY;
    });
    const crossing: Crossing = { fromIsland: 0, toIsland: 1, from: { x: 90, y: 0 }, to: { x: 150, y: 0 } };
    expect(new GradedLand(ledge, CORE, STREET, [crossing]).at(170, 0)).toBe(false);
  });
});
