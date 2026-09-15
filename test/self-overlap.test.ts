import { describe, expect, it } from 'vitest';
import { bendOverlaps, selfOverlap, stepOverlaps, untangle } from '../src/world/self-overlap.ts';
import type { Point } from '../src/world/types.ts';

/**
 * A road lies over its own carriageway where two places on it stand closer
 * than its width but a half turn of that width or more apart along it (#252).
 */

const line = (coords: readonly [number, number][]): Point[] => coords.map(([x, y]) => ({ x, y }));

describe('self overlap', () => {
  it('finds the zigzag of #252 on an arterial', () => {
    const zigzag = line([
      [-810, 1390],
      [-820, 1390],
      [-810, 1370],
      [-830, 1370],
      [-820, 1360],
      [-850, 1360],
    ]);
    expect(selfOverlap(zigzag, 'arterial')).toBeDefined();
  });

  it('finds a road that crosses itself', () => {
    const loop = line([
      [0, 0],
      [100, 0],
      [100, 100],
      [50, 100],
      [50, -50],
    ]);
    expect(selfOverlap(loop, 'street')).toEqual({ first: 0, second: 3 });
  });

  it('passes a right-angle corner and a hairpin wider than the road', () => {
    expect(
      selfOverlap(
        line([
          [0, 0],
          [50, 0],
          [50, 50],
        ]),
        'highway',
      ),
    ).toBeUndefined();
    // Two legs 40 m apart, joined by a half circle, on an 11 m street.
    const hairpin: Point[] = [{ x: 0, y: 0 }];
    for (let k = 0; k <= 12; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 12;
      hairpin.push({ x: 100 + 20 * Math.cos(a), y: 20 + 20 * Math.sin(a) });
    }
    hairpin.push({ x: 0, y: 40 });
    expect(selfOverlap(hairpin, 'street')).toBeUndefined();
  });

  it('gives the same answer when a point is added on a straight stretch', () => {
    const turn = line([
      [1900, 370],
      [1900, 390],
      [1910, 380],
    ]);
    const split = line([
      [1900, 370],
      [1900, 382.34],
      [1900, 390],
      [1910, 380],
    ]);
    expect(selfOverlap(turn, 'arterial') !== undefined).toBe(selfOverlap(split, 'arterial') !== undefined);
  });

  it('refuses a step back over the road a trace carries on from', () => {
    const before = line([
      [0, 0],
      [20, 0],
      [40, 0],
    ]);
    expect(stepOverlaps(line([[40, 0]]), { x: 30, y: 3 }, 'street', before)).toBe(true);
    expect(stepOverlaps(line([[40, 0]]), { x: 40, y: 20 }, 'street', before)).toBe(false);
    expect(stepOverlaps(before, { x: 60, y: 3 }, 'street')).toBe(false);
  });

  it('refuses a bend that folds a road back onto itself', () => {
    const road = line([
      [0, 0],
      [30, 0],
      [60, 0],
    ]);
    expect(bendOverlaps(road, 1, { x: 45, y: 2 }, 'street')).toBe(false);
    expect(bendOverlaps(road, 1, { x: 10, y: 2 }, 'street')).toBe(true);
  });

  it('cuts a spike out of a road and keeps its two ends', () => {
    const spiked = line([
      [0, 0],
      [40, 0],
      [80, 0],
      [60, 1],
      [100, 30],
    ]);
    const cut = untangle(spiked, 'street', () => true);
    expect(cut).toBeDefined();
    expect(selfOverlap(cut as Point[], 'street')).toBeUndefined();
    expect(cut?.[0]).toEqual(spiked[0]);
    expect(cut?.[cut.length - 1]).toEqual(spiked[spiked.length - 1]);
    expect(untangle(spiked, 'street', () => false)).toBeUndefined();
  });
});
