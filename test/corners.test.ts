import { describe, expect, it } from 'vitest';
import { plucks } from '../src/audio/busking.ts';
import type { Cue } from '../src/audio/cue.ts';
import { TICKS_PER_DAY } from '../src/sim/clock.ts';
import { BUSKER_REACH, StreetCorners, type CornerSpot, type PlacedProp } from '../src/sim/corners.ts';
import type { WaitingPassenger } from '../src/sim/stop-queue.ts';
import { sweepSeeds } from './helpers.ts';
import { gridTrafficRoads } from './traffic-grid.ts';

const SEEDS = sweepSeeds(4);

/** The tick of an hour of the first day. */
const at = (hour: number, day = 0): number => Math.round((day + hour / 24) * TICKS_PER_DAY);

function cornersOf(seed: number): StreetCorners {
  return new StreetCorners(seed, gridTrafficRoads());
}

describe('the occupied corners of spec section 20.1', () => {
  it('lays out the same corners for the same seed, and some on every seed', () => {
    for (const seed of SEEDS) {
      const a = cornersOf(seed).spots;
      const b = cornersOf(seed).spots;
      expect(a.length).toBeGreaterThan(0);
      expect(b).toEqual(a);
    }
  });

  it('keeps each kind to its hours', () => {
    let club = 0;
    for (const seed of SEEDS) {
      const corners = cornersOf(seed);
      for (const spot of corners.spots) {
        for (let day = 0; day < 3; day++) {
          // Four in the morning: nothing but the end of a club's night is out.
          if (spot.kind !== 'club') expect(corners.isOut(spot, at(4.5, day))).toBe(false);
          if (spot.kind === 'club' && corners.isOut(spot, at(23, day))) club++;
          if (spot.kind === 'club') expect(corners.isOut(spot, at(15, day))).toBe(false);
        }
      }
    }
    // A club somewhere has its queue out at night.
    expect(club).toBeGreaterThan(0);
  });

  it('stands every person and every prop close round their spot, on the pavement', () => {
    const seed = SEEDS[0] as number;
    const corners = cornersOf(seed);
    const out: WaitingPassenger[] = [];
    const props: PlacedProp[] = [];
    const tick = at(12.5);
    const people = corners.passengers(-1e6, -1e6, 1e6, 1e6, tick, out);
    const placed = corners.props(-1e6, -1e6, 1e6, 1e6, tick, props);
    expect(people).toBeGreaterThan(0);
    const near = (x: number, y: number): boolean => corners.spots.some((s) => Math.hypot(s.x - x, s.y - y) < 4);
    for (let i = 0; i < people; i++) {
      const pose = (out[i] as WaitingPassenger).pose;
      expect(near(pose.x, pose.y)).toBe(true);
      expect(pose.speed).toBe(0);
    }
    for (let i = 0; i < placed; i++) expect(near((props[i] as PlacedProp).x, (props[i] as PlacedProp).y)).toBe(true);
  });

  it('gives every busker an amp, and plays their notes the same way twice', () => {
    let heard = 0;
    for (const seed of SEEDS) {
      const corners = cornersOf(seed);
      for (const spot of corners.spots) {
        if (spot.kind === 'busker') expect(spot.prop?.kind).toBe('amp');
      }
      const busker = corners.spots.find((s) => s.kind === 'busker');
      if (busker === undefined) continue;
      const found: CornerSpot[] = [];
      // Out of reach, nobody is heard.
      expect(corners.buskers(busker.x + 3 * BUSKER_REACH, busker.y, at(14), found)).toHaveLength(0);
      for (let day = 0; day < 4; day++) {
        const tick = at(14, day);
        if (!corners.isOut(busker, tick)) continue;
        const first: Cue[] = [];
        const again: Cue[] = [];
        plucks(seed, tick - 600, tick, busker.x, busker.y, corners, first);
        plucks(seed, tick - 600, tick, busker.x, busker.y, corners, again);
        expect(again).toEqual(first);
        expect(first.every((cue) => cue.kind === 'pluck')).toBe(true);
        heard += first.length;
      }
    }
    expect(heard).toBeGreaterThan(0);
  });
});
