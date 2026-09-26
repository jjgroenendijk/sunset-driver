import { describe, expect, it } from 'vitest';
import { TICKS_PER_HOUR } from '../../../src/sim/clock.ts';
import { GLUT, GOOD_GROUPS, GOOD_IDS, GOODS, goodIndex, priceAt, priceRun, SPIKE, standingPrice, tasteOf } from '../../../src/sim/crime/contraband.ts';
import { dealerLook, dealerPlaces, pitchOf, PITCH_TICKS, type DealerPlace } from '../../../src/sim/crime/dealer.ts';
import type { Place } from '../../../src/sim/player/on-foot.ts';
import type { Culture, District, Zone } from '../../../src/world/types.ts';

/** A district with the three numbers the market reads of one. */
function district(id: number, wealth: number, culture: Culture = 'none', density = 0.5, zone: Zone = 'inner'): District {
  return { id, name: `D${id}`, zone, x: id * 500, y: 0, density, wealth, culture };
}

const POWDER = goodIndex('powder');
const LIQUOR = goodIndex('liquor');

/** Spec section 16.2: what a district asks for a good, and why. */
describe('contraband prices', () => {
  it('answers the same price for the same seed, tick and district', () => {
    const d = district(3, 0.4, 'italian');
    for (const tick of [0, 1234, 500_000]) {
      expect(priceAt(7, tick, d, POWDER)).toBe(priceAt(7, tick, d, POWDER));
    }
    // Another seed is another city, so the same district asks a different price.
    const across = [0, 1234, 500_000].map((tick) => priceAt(8, tick, d, POWDER) === priceAt(7, tick, d, POWDER));
    expect(across.includes(false)).toBe(true);
  });

  it('prices a good by the wealth of the district, its character and its crowd', () => {
    const poor = tasteOf(1, district(0, 0.05), POWDER);
    const rich = tasteOf(1, district(0, 0.95), POWDER);
    // The same district, twice as rich: cocaine costs more where the money is.
    expect(rich).toBeGreaterThan(poor);
    // The culture that trades a good has it at home, so it is cheap there.
    expect(tasteOf(1, district(0, 0.5, 'latin'), POWDER)).toBeLessThan(tasteOf(1, district(0, 0.5), POWDER));
    // A crowded street drinks more than an empty one.
    expect(tasteOf(1, district(0, 0.5, 'none', 0.95), LIQUOR)).toBeGreaterThan(tasteOf(1, district(0, 0.5, 'none', 0.05), LIQUOR));
  });

  it('leaves a gap between two districts worth driving between', () => {
    // The poorest district that trades it against the richest that does not:
    // the spread is the whole trade of spec section 16.2.
    const home = district(0, 0.1, 'latin');
    const away = district(1, 0.95);
    for (let seed = 1; seed <= 8; seed++) {
      expect(standingPrice(seed, away, POWDER) / standingPrice(seed, home, POWDER)).toBeGreaterThan(1.5);
    }
  });

  it('drifts over the day rather than jumping between two ticks', () => {
    const d = district(2, 0.5);
    const start = priceAt(5, 200_000, d, LIQUOR);
    // A tick is nothing: a price a player has just read is still the price.
    expect(Math.abs(priceAt(5, 200_001, d, LIQUOR) - start)).toBeLessThanOrEqual(start * 0.01);
    // Over the day it moves, or there is no market at all.
    let moved = 0;
    for (let hour = 0; hour < 24; hour++) {
      moved = Math.max(moved, Math.abs(priceAt(5, 200_000 + hour * TICKS_PER_HOUR, d, LIQUOR) - start));
    }
    expect(moved).toBeGreaterThan(start * 0.05);
  });

  it('shakes a few markets and leaves the rest of the city alone', () => {
    const districts = Array.from({ length: 12 }, (_, i) => district(i, (i % 5) / 5, 'none', 0.5));
    let shaken = 0;
    let total = 0;
    for (const d of districts) {
      for (let good = 0; good < GOODS.length; good++) {
        const standing = standingPrice(11, d, good);
        for (let hour = 0; hour < 96; hour++) {
          const price = priceAt(11, hour * TICKS_PER_HOUR, d, good);
          total++;
          if (price > standing * SPIKE || price < standing * GLUT) shaken++;
        }
      }
    }
    // A spike or a glut is worth driving to because it is rare, and the streets
    // are not all quiet either.
    expect(shaken).toBeGreaterThan(0);
    expect(shaken / total).toBeLessThan(0.25);
  });

  it('reads the history back rather than remembering it', () => {
    const d = district(4, 0.6);
    const run = priceRun(9, 100_000, d, POWDER, 12, TICKS_PER_HOUR);
    expect(run).toHaveLength(12);
    // The last sample is now, and the first is eleven hours back.
    expect(run[11]).toBe(priceAt(9, 100_000, d, POWDER));
    expect(run[0]).toBe(priceAt(9, 100_000 - 11 * TICKS_PER_HOUR, d, POWDER));
    // A session that has just started has no history before tick 0 to read.
    expect(priceRun(9, 60, d, POWDER, 12, TICKS_PER_HOUR)[0]).toBe(priceAt(9, 0, d, POWDER));
  });

  it('names and prices every good the trade carries, a group at a time', () => {
    expect(GOODS).toHaveLength(GOOD_IDS.length);
    expect(GOODS.map((good) => good.id)).toEqual([...GOOD_IDS]);
    // The panel draws the goods under their headings in the list's order, so a
    // group is one run of the list, the runs come in the order of the headings,
    // and inside a run the goods go cheapest first.
    const order = GOODS.map((good) => GOOD_GROUPS.indexOf(good.group));
    for (let i = 1; i < GOODS.length; i++) {
      expect(order[i] ?? 0).toBeGreaterThanOrEqual(order[i - 1] ?? 0);
      if (order[i] === order[i - 1]) expect(GOODS[i]?.base ?? 0).toBeGreaterThan(GOODS[i - 1]?.base ?? 0);
    }
    for (const good of GOODS) expect(good.blurb.length).toBeGreaterThan(0);
    expect(goodIndex('cigarettes')).toBe(0);
  });
});

/** Spec section 16.2: one dealer per district, and never on the same corner for long. */
describe('the dealers', () => {
  const districts = [district(0, 0.3, 'latin'), district(1, 0.8)];
  /** A snap that puts a corner on the nearest 10 m of road, and finds none past the city. */
  const snap = (x: number, y: number): Place | undefined =>
    Math.abs(x) > 2000 ? undefined : { x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10, heading: 0 };

  it('puts one dealer on the streets of each district', () => {
    const dealers = dealerPlaces(3, districts, snap);
    expect(dealers).toHaveLength(2);
    expect(dealers.map((dealer) => dealer.name)).toEqual(['Dealer · D0', 'Dealer · D1']);
    for (const dealer of dealers) {
      expect(dealer.pitches.length).toBeGreaterThan(1);
      // Every corner is on a road, and none of them is the district's middle.
      for (const pitch of dealer.pitches) {
        expect(Math.abs(pitch.x % 10)).toBe(0);
        expect(Math.hypot(pitch.x - dealer.district.x, pitch.y - dealer.district.y)).toBeGreaterThan(10);
      }
    }
    // Two seeds deal the same districts different corners.
    expect(dealerPlaces(4, districts, snap)[0]?.pitches).not.toEqual(dealers[0]?.pitches);
    expect(dealerPlaces(3, districts, snap)).toEqual(dealers);
  });

  it('leaves a district with no street on it without a dealer', () => {
    expect(dealerPlaces(3, [district(9, 0.5)], () => undefined)).toEqual([]);
  });

  it('moves to the next corner every spell, and works them all', () => {
    const dealer = dealerPlaces(3, districts, snap)[0] as DealerPlace;
    const walked: Place[] = [];
    for (let spell = 0; spell < dealer.pitches.length; spell++) walked.push(pitchOf(dealer, spell * PITCH_TICKS));
    // Every corner in turn, and a different one each spell.
    expect([...walked].sort((a, b) => a.x - b.x)).toEqual([...dealer.pitches].sort((a, b) => a.x - b.x));
    // A spell holds still from its first tick to its last.
    expect(pitchOf(dealer, PITCH_TICKS)).toEqual(pitchOf(dealer, PITCH_TICKS * 2 - 1));
    expect(pitchOf(dealer, 0)).not.toEqual(pitchOf(dealer, PITCH_TICKS));
  });

  it('dresses a dealer as the district they work, the same way every session', () => {
    const dealer = dealerPlaces(3, districts, snap)[0] as DealerPlace;
    expect(dealerLook(3, dealer)).toEqual(dealerLook(3, dealer));
    expect(dealerLook(3, dealer)).not.toEqual(dealerLook(4, dealer));
  });
});
