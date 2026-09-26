import { describe, expect, it } from 'vitest';
import { DistrictWatch, TITLE_GAP, TITLE_SETTLE } from '../../../src/ui/hud/district-title.ts';

/** Walk a watch through a run of ticks in one district, and say which titles it asked for. */
function walk(watch: DistrictWatch, from: number, to: number, district: number): number[] {
  const titles: number[] = [];
  for (let tick = from; tick < to; tick++) {
    const title = watch.step(tick, district);
    if (title >= 0) titles.push(title);
  }
  return titles;
}

describe('the district title', () => {
  it('names the district the player settles in, once', () => {
    const watch = new DistrictWatch();
    expect(walk(watch, 0, TITLE_SETTLE, 3)).toEqual([]);
    expect(walk(watch, TITLE_SETTLE, TITLE_SETTLE * 10, 3)).toEqual([3]);
  });

  it('says nothing for a border crossed back and forth', () => {
    const watch = new DistrictWatch();
    walk(watch, 0, TITLE_GAP, 1);
    // A car along the border is in each district for a moment at a time.
    const titles: number[] = [];
    for (let tick = TITLE_GAP; tick < TITLE_GAP * 3; tick += 20) {
      titles.push(...walk(watch, tick, tick + 10, 2), ...walk(watch, tick + 10, tick + 20, 1));
    }
    expect(titles).toEqual([]);
  });

  it('names the next district after the gap, and not before', () => {
    const watch = new DistrictWatch();
    expect(walk(watch, 0, 100, 1)).toEqual([1]);
    // A district crossed straight after is named once the gap has passed.
    const titles = walk(watch, 100, TITLE_GAP * 2, 2);
    expect(titles).toEqual([2]);
    const again = new DistrictWatch();
    walk(again, 0, 100, 1);
    expect(walk(again, 100, TITLE_SETTLE + TITLE_GAP - 1, 2)).toEqual([]);
  });
});
