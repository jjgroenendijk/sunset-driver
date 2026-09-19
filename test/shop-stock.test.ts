import { describe, expect, it } from 'vitest';
import { spread } from '../src/core/math.ts';
import { createSimState } from '../src/sim/simulation.ts';
import { shopPlaces, type ShopPlace } from '../src/sim/shop.ts';
import {
  BACK_ROOM,
  BACK_ROOM_ROWS,
  COUNTER_ROWS,
  licenceOf,
  offersOf,
  roundPrice,
  stockOf,
  weaponPrice,
} from '../src/sim/shop-stock.ts';
import { AMMO_CAP, ARSENAL, fitsOf, WEAPON_IDS, weaponOf, type WeaponId } from '../src/sim/weapon.ts';
import { MAX_LICENCE, MIN_LICENCE, type Shop, type ShopKind } from '../src/world/shops.ts';

/** One shop of a trade, with the licence a test wants it to hold. */
function place(kind: ShopKind, licence = 2, id = 0): ShopPlace {
  const shop: Shop = { id, kind, building: id, district: 0, x: 0, y: 0, facing: 0, width: 10, depth: 12, licence };
  return shopPlaces([shop], [{ name: 'Old Town' }])[0] as ShopPlace;
}

/** Spec section 16.1: what a counter holds and what it asks for it. */
describe('shop prices', () => {
  it('prices every weapon of the arsenal above nothing and below a fortune', () => {
    for (const id of WEAPON_IDS) {
      const price = weaponPrice(weaponOf(id));
      expect(price, id).toBeGreaterThan(0);
      expect(price, id).toBeLessThan(20_000);
      expect(price % 5, id).toBe(0);
    }
  });

  it('prices a weapon by the licence it needs, so a rifle costs more than a pistol', () => {
    expect(weaponPrice(ARSENAL['glock-17'])).toBeGreaterThan(weaponPrice(ARSENAL['baseball-bat']));
    expect(weaponPrice(ARSENAL['ak-47'])).toBeGreaterThan(weaponPrice(ARSENAL['glock-17']));
    expect(weaponPrice(ARSENAL['rpg-7'])).toBeGreaterThan(weaponPrice(ARSENAL['ak-47']));
  });

  it('prices a round by how few of them a player may carry', () => {
    expect(roundPrice('9×19')).toBe(1);
    expect(roundPrice('rocket')).toBeGreaterThan(roundPrice('.50 BMG'));
    expect(roundPrice('.50 BMG')).toBeGreaterThan(roundPrice('9×19'));
  });

  it('gives the heavy and thrown weapons a licence no shop holds', () => {
    for (const id of WEAPON_IDS) {
      const spec = weaponOf(id);
      const licence = licenceOf(spec);
      expect(licence, id).toBeGreaterThanOrEqual(MIN_LICENCE);
      if (spec.cls === 'heavy' || spec.cls === 'thrown') expect(licence, id).toBeGreaterThan(MAX_LICENCE);
      else expect(licence, id).toBeLessThanOrEqual(MAX_LICENCE);
    }
  });
});

describe('shop stock', () => {
  it('stocks a counter and a back room, and never the fists a player starts with', () => {
    const stock = stockOf(11, place('weapons', 2));
    expect(stock.counter.length).toBe(COUNTER_ROWS);
    expect(stock.back.length).toBe(BACK_ROOM_ROWS);
    const all = [...stock.counter, ...stock.back];
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain('fists' as WeaponId);
  });

  it('sells over the counter only what the licence covers, and the rest from the back', () => {
    for (const licence of [MIN_LICENCE, 2, MAX_LICENCE]) {
      const stock = stockOf(3, place('weapons', licence));
      for (const id of stock.counter) expect(licenceOf(weaponOf(id)), id).toBeLessThanOrEqual(licence);
      for (const id of stock.back) expect(licenceOf(weaponOf(id)), id).toBeGreaterThan(licence);
    }
  });

  it('charges the back room its premium', () => {
    const state = createSimState(5);
    state.money = 100_000;
    const shop = place('weapons', 2);
    const rows = offersOf(state, shop);
    const back = rows.filter((row) => row.label.includes('back room'));
    expect(back.length).toBe(BACK_ROOM_ROWS);
    for (const row of back) {
      const id = row.label.replace(' · back room', '');
      const spec = WEAPON_IDS.map((weapon) => weaponOf(weapon)).find((candidate) => candidate.name === id);
      expect(spec, id).toBeDefined();
      if (spec !== undefined) expect(row.price).toBe(weaponPrice(spec) * BACK_ROOM);
    }
  });

  it('is a pure function of the seed and the shop', () => {
    expect(stockOf(9, place('weapons', 3, 4))).toEqual(stockOf(9, place('weapons', 3, 4)));
    expect(stockOf(9, place('weapons', 3, 4))).not.toEqual(stockOf(9, place('weapons', 3, 5)));
  });

  it('offers ammunition and an attachment for the weapon in the player hands', () => {
    const state = createSimState(2);
    state.loadout.slots = [{ id: 'mp5', loaded: 30, attachments: [] }];
    state.loadout.current = 0;
    const rows = offersOf(state, place('weapons', 2));
    expect(rows.some((row) => row.label.includes('9×19'))).toBe(true);
    expect(rows.some((row) => row.label.includes('MP5'))).toBe(true);
    // Every attachment the weapon takes is on the counter, each shown fitted.
    const fitted = rows.filter((row) => row.group === 'Attachments');
    expect(fitted.length).toBe(fitsOf(weaponOf('mp5')).length);
    for (const row of fitted) {
      expect(row.look.kind).toBe('weapon');
      if (row.look.kind === 'weapon') expect(row.look.attachments.length).toBe(1);
    }
  });

  it('sells one box of each calibre the player carries, and none for a full pool', () => {
    const state = createSimState(2);
    state.loadout.slots = [
      { id: 'glock-17', loaded: 17, attachments: [] },
      { id: 'mp5', loaded: 30, attachments: [] },
      { id: 'ak-47', loaded: 30, attachments: [] },
    ];
    state.loadout.current = 0;
    state.loadout.ammo['7.62×39'] = AMMO_CAP['7.62×39'];
    const ammo = offersOf(state, place('weapons', 2)).filter((row) => row.group === 'Ammunition');
    expect(ammo.map((row) => row.label)).toEqual(['17 × 9×19']);
  });

  it('gives every row of every counter a heading, a look and a line to read', () => {
    const state = createSimState(4);
    state.player.health = 10;
    for (const kind of ['weapons', 'workshop', 'convenience', 'clothing', 'clinic'] as const) {
      const rows = offersOf(state, place(kind, 3));
      expect(rows.length, kind).toBeGreaterThan(3);
      for (const row of rows) {
        expect(row.group, row.label).not.toBe('');
        expect(row.blurb, row.label).not.toBe('');
        expect(row.look, row.label).toBeDefined();
      }
    }
  });
});

describe('spread', () => {
  it('picks distinct indices, far apart, from wherever it is offset', () => {
    for (const total of [1, 2, 5, 12, 39]) {
      for (const count of [1, 2, 4, 6, 40]) {
        for (const offset of [0, 1, 7, 38]) {
          const picks = spread(total, count, offset % total);
          expect(picks.length).toBe(Math.min(count, total));
          expect(new Set(picks).size).toBe(picks.length);
          for (const at of picks) {
            expect(at).toBeGreaterThanOrEqual(0);
            expect(at).toBeLessThan(total);
          }
        }
      }
    }
    expect(spread(0, 3, 0)).toEqual([]);
    expect(spread(10, 0, 0)).toEqual([]);
  });
});
