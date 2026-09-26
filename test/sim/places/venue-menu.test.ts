import { describe, expect, it } from 'vitest';
import { BAR_MENU, CAFE_MENU, menuOf } from '../../../src/sim/places/venue-menu.ts';
import { PROP_IDS } from '../../../src/sim/places/shop-goods.ts';
import { venueName } from '../../../src/world/city/venue-names.ts';

/** Spec section 16.1: every café and every bar has a menu and a name of its own. */
describe('venue menus', () => {
  it('deals the same menu for the same seed and shop', () => {
    expect(menuOf(7, 3, true, 0.5, 'The Fox')).toEqual(menuOf(7, 3, true, 0.5, 'The Fox'));
  });

  it('gives two venues of one city different menus', () => {
    const labels = (id: number): string => menuOf(7, id, false, 0.5, 'Café').map((row) => row.label).join('|');
    const menus = new Set([0, 1, 2, 3, 4, 5, 6, 7].map(labels));
    expect(menus.size).toBeGreaterThan(5);
  });

  it('takes at least the rows each section asks for, in the order the sections run', () => {
    for (const [bar, sections] of [[false, CAFE_MENU], [true, BAR_MENU]] as const) {
      for (let id = 0; id < 20; id++) {
        const menu = menuOf(11, id, bar, 0.5, 'House');
        expect(menu[0]?.group).toBe('House');
        const groups = menu.slice(1).map((row) => row.group);
        const order = sections.map((section) => section.group);
        const seen = groups.map((group) => order.indexOf(group));
        expect(seen).toEqual([...seen].sort((a, b) => a - b));
        for (const section of sections) {
          const count = groups.filter((group) => group === section.group).length;
          expect(count).toBeGreaterThanOrEqual(section.least);
          expect(count).toBeLessThanOrEqual(section.most);
        }
      }
    }
  });

  it('charges more in a rich district than in a poor one', () => {
    const total = (wealth: number): number => {
      let sum = 0;
      for (let id = 0; id < 30; id++) sum += menuOf(5, id, true, wealth, 'Bar')[0]?.price ?? 0;
      return sum;
    };
    expect(total(1)).toBeGreaterThan(total(0) * 1.5);
  });

  it('draws every row with a prop the preview knows, at a whole-dollar price', () => {
    for (const section of [...CAFE_MENU, ...BAR_MENU]) {
      for (const item of section.items) {
        expect(PROP_IDS).toContain(item.prop);
        expect(item.health).toBeGreaterThan(0);
      }
    }
    for (const row of menuOf(1, 1, false, 0.2, 'X')) {
      expect(Number.isInteger(row.price)).toBe(true);
      expect(row.price).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('venue names', () => {
  it('names only the cafés and the bars, the same way every time', () => {
    expect(venueName(3, 1, 'weapons')).toBeUndefined();
    expect(venueName(3, 1, 'cafe')).toBe(venueName(3, 1, 'cafe'));
    const names = new Set(Array.from({ length: 40 }, (_, id) => venueName(3, id, id % 2 === 0 ? 'cafe' : 'bar')));
    expect(names.size).toBeGreaterThan(30);
  });
});
