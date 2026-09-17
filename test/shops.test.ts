import { describe, expect, it } from 'vitest';
import {
  buildShops,
  roomOf,
  SHOP_KINDS,
  SHOP_ORDER,
  SHOP_FRONT,
  SHOP_ROOM_DEPTH,
  SHOP_WALL,
  MAX_LICENCE,
  MIN_LICENCE,
  type Shop,
} from '../src/world/shops.ts';
import type { Building, BuildingKind, BuildingMap } from '../src/world/buildings.ts';
import type { District, WorldDescription, Zone } from '../src/world/types.ts';

/** A district with a wealth, which is all the shop rule reads of one. */
function district(id: number, wealth: number, zone: Zone = 'inner'): District {
  return { id, name: `D${id}`, zone, x: id * 100, y: 0, density: 0.5, wealth, culture: 'none' };
}

/**
 * A building on a lot 10 m across and 14 m deep, fronting north. The shops read
 * the front, the facing, the width and the depth of one and nothing else.
 */
function building(id: number, districtId: number, kind: BuildingKind = 'shop-row'): Building {
  const x = id * 12;
  return {
    id,
    parcel: districtId,
    kind,
    seed: id + 1,
    lot: [
      { x: x - 5, y: 0 },
      { x: x + 5, y: 0 },
      { x: x + 5, y: -14 },
      { x: x - 5, y: -14 },
    ],
    area: 140,
    width: 10,
    depth: 14,
    front: { x, y: 0 },
    // Facing +y: the road runs along the front of the row.
    facing: Math.PI / 2,
    shared: { left: false, right: false },
    road: 0,
    district: districtId,
    zone: 'inner',
    skyline: 0.3,
  };
}

function world(districts: District[], seed = 7): WorldDescription {
  return { seed, districts } as unknown as WorldDescription;
}

/** `count` shop rows in one district, and the other kinds a street also holds. */
function street(districtId: number, count: number, others: BuildingKind[] = []): Building[] {
  const rows = Array.from({ length: count }, (_, i) => building(districtId * 100 + i, districtId));
  return [...rows, ...others.map((kind, i) => building(districtId * 100 + count + i, districtId, kind))];
}

function map(buildings: Building[]): BuildingMap {
  return { buildings, area: buildings.length * 140 };
}

/** Spec section 16.1: which building of which district holds which trade. */
describe('shops', () => {
  it('deals every trade down a district with a long high street', () => {
    const shops = buildShops(world([district(0, 0.5)]), map(street(0, 6)));
    expect(shops.map((shop) => shop.kind)).toEqual([...SHOP_ORDER]);
    // No two trades share a building, and every shop stands on a shop row.
    expect(new Set(shops.map((shop) => shop.building)).size).toBe(shops.length);
  });

  it('fills a short high street from the top of the order, so a store comes first', () => {
    const shops = buildShops(world([district(0, 0.5)]), map(street(0, 2)));
    expect(shops.map((shop) => shop.kind)).toEqual(SHOP_ORDER.slice(0, 2));
  });

  it('gives a district with no shop row no shop at all', () => {
    const shops = buildShops(world([district(0, 0.5)]), map(street(0, 0, ['tower', 'house', 'warehouse'])));
    expect(shops).toEqual([]);
  });

  it('keeps each district to its own buildings and numbers the shops in district order', () => {
    const shops = buildShops(world([district(0, 0.5), district(1, 0.5)]), map([...street(0, 3), ...street(1, 3)]));
    expect(shops.map((shop) => shop.id)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(shops.slice(0, 3).every((shop) => shop.district === 0)).toBe(true);
    expect(shops.slice(3).every((shop) => shop.district === 1)).toBe(true);
  });

  it('spreads the trades down the street rather than taking a run of it', () => {
    // Six trades over twelve rows step two apart, so no two shops are neighbours.
    const shops = buildShops(world([district(0, 0.5)]), map(street(0, 12)));
    const at = shops.map((shop) => shop.building % 100).sort((a, b) => a - b);
    for (let i = 1; i < at.length; i++) expect((at[i] as number) - (at[i - 1] as number)).toBeGreaterThan(1);
  });

  it('licenses a weapon shop by the wealth of its district', () => {
    const licenceIn = (wealth: number): number => {
      const shops = buildShops(world([district(0, wealth)]), map(street(0, 6)));
      return (shops.find((shop) => shop.kind === 'weapons') as Shop).licence;
    };
    expect(licenceIn(0)).toBe(MIN_LICENCE);
    expect(licenceIn(0.5)).toBe(2);
    expect(licenceIn(1)).toBe(MAX_LICENCE);
    // Every licence is one the counter can read.
    for (const wealth of [0, 0.2, 0.34, 0.67, 0.99, 1]) {
      expect(licenceIn(wealth)).toBeGreaterThanOrEqual(MIN_LICENCE);
      expect(licenceIn(wealth)).toBeLessThanOrEqual(MAX_LICENCE);
    }
  });

  it('is a pure function of the seed', () => {
    const districts = [district(0, 0.3), district(1, 0.8)];
    const buildings = [...street(0, 5), ...street(1, 7)];
    const once = buildShops(world(districts), map(buildings));
    const again = buildShops(world(districts), map(buildings));
    expect(again).toEqual(once);
    // Another seed deals the same trades over other buildings.
    const other = buildShops(world(districts, 99), map(buildings));
    expect(other.map((shop) => shop.kind)).toEqual(once.map((shop) => shop.kind));
    expect(other.map((shop) => shop.building)).not.toEqual(once.map((shop) => shop.building));
  });

  it('names a trade for every shop type the spec lists', () => {
    expect([...SHOP_ORDER].sort()).toEqual([...SHOP_KINDS].sort());
  });
});

/** Spec section 10.3: the room the shop holds stands inside the building's lot. */
describe('shop rooms', () => {
  it('stands behind the shopfront, inside the walls of the lot', () => {
    const shops = buildShops(world([district(0, 0.5)]), map(street(0, 6)));
    for (const shop of shops) {
      const room = roomOf(shop);
      expect(room.halfWidth).toBeCloseTo(Math.min(shop.width / 2 - SHOP_WALL, SHOP_FRONT / 2));
      expect(room.halfDepth).toBeCloseTo(Math.min(shop.depth, SHOP_ROOM_DEPTH) / 2 - SHOP_WALL);
      // The lot fronts +y, so the room lies at -y of the door and no further
      // back than the lot goes.
      expect(room.x).toBeCloseTo(shop.x);
      expect(room.y).toBeLessThan(shop.y);
      expect(shop.y - (room.y - room.halfDepth)).toBeLessThanOrEqual(shop.depth);
      expect(room.facing).toBe(shop.facing);
    }
  });

  it('keeps a room in a narrow lot big enough to stand in', () => {
    const narrow: Shop = { ...(buildShops(world([district(0, 0.5)]), map(street(0, 1)))[0] as Shop), width: 0.5, depth: 0.5 };
    const room = roomOf(narrow);
    expect(room.halfWidth).toBeGreaterThan(1);
    expect(room.halfDepth).toBeGreaterThan(1);
  });
});
