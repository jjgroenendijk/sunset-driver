/**
 * Which buildings are shops (spec section 16.1).
 *
 * A handful of shop types are enterable; every other building is exterior only
 * (spec section 10.3). This says which shop row holds which of them. The row
 * itself is a building like any other: `buildings.ts` has already put it on its
 * lot, and a shop is that building with a trade written on it, so nothing here
 * moves a wall or claims a piece of ground.
 *
 * The shops are dealt by district, one trade per building. A district's own
 * shop rows are its high street, and {@link SHOP_ORDER} is the order the trades
 * take them: the commonest first, so a district with one shop row gets the
 * convenience store and only a district with a real high street gets the
 * property broker. The buildings are then spread down the street rather than
 * taken in a run, so two shops are rarely neighbours.
 *
 * Pure: the same world gives the same shops, in the same order, on the same
 * buildings. Built in the chunk workers beside the buildings, like the police
 * and metro stations, and answered to the main thread once.
 */
import { spread } from '../core/math.ts';
import { genRng, Subsystem } from '../core/rng.ts';
import { cos, sin } from '../core/libm.ts';
import type { Building, BuildingMap } from './buildings.ts';
import type { District, WorldDescription } from './types.ts';

/** The shop types of spec section 16.1. */
export type ShopKind = 'weapons' | 'workshop' | 'convenience' | 'clothing' | 'clinic' | 'broker';

/** Every shop type. Nothing else should list them. */
export const SHOP_KINDS: readonly ShopKind[] = ['weapons', 'workshop', 'convenience', 'clothing', 'clinic', 'broker'];

/**
 * The order the trades take a district's shop rows, commonest first. A district
 * with fewer shop rows than there are trades fills the list from the top, so
 * every district that builds a shop at all has somewhere to buy food and every
 * trade is on the map wherever one high street is long enough.
 */
export const SHOP_ORDER: readonly ShopKind[] = ['convenience', 'workshop', 'clothing', 'clinic', 'weapons', 'broker'];

/** The lowest and the highest licence a weapon shop can hold (spec section 16.1). */
export const MIN_LICENCE = 1;
export const MAX_LICENCE = 3;

/**
 * One shop, on the ground floor of the building that holds it. The room inside
 * it is built from the lot the building stands on, so a shop on a narrow lot is
 * a narrow shop.
 */
export interface Shop {
  id: number;
  kind: ShopKind;
  /** Id of the building whose ground floor it takes, as `buildings.ts` numbers them. */
  building: number;
  district: number;
  /** The middle of the shopfront: where the door is, on the building's own front edge. */
  x: number;
  y: number;
  /** Which way the front faces, in radians: from the shop out towards its road. */
  facing: number;
  /** Metres across the front, and from the front to the back of the lot. */
  width: number;
  depth: number;
  /**
   * The licence a weapon shop holds, {@link MIN_LICENCE} to {@link MAX_LICENCE},
   * and {@link MIN_LICENCE} on every other kind, which reads it for nothing. A
   * richer district licenses more (spec section 16.1); what each licence sells
   * over the counter, and what the back room sells instead, is `src/sim/shop.ts`.
   */
  licence: number;
}

/** Metres of wall between the edge of the lot and the room inside it. */
export const SHOP_WALL = 0.4;

/** Metres of the lot's depth the room takes at most; behind it is the back of the building. */
export const SHOP_ROOM_DEPTH = 9;

/**
 * Metres of frontage one shopfront takes at most. A shop row is a row of
 * storefronts and the enterable shop is one of them: the rest of the row is
 * scenery and a robbery target (spec section 16.1), so a shop on a 28 m row is
 * still a shop and not a hall.
 */
export const SHOP_FRONT = 7;

/** Metres of floor to ceiling inside a shop. The clip of the renderer reads it. */
export const SHOP_ROOM_HEIGHT = 3.2;

/** The smallest room a lot can hold, each way from its middle. */
const MIN_HALF = 1.6;

/**
 * The room inside a shop: where its floor is and how far its walls stand. The
 * simulation reads it to know when the player has walked out, and the renderer
 * builds the interior of spec section 10.3 from it, so the walls a player
 * leaves through are the walls they were shown.
 */
export interface ShopRoom {
  /** The middle of the floor. */
  x: number;
  y: number;
  /** Half the room across the front, and from the front wall to the back one. */
  halfWidth: number;
  halfDepth: number;
  /** Which way the front faces, in radians: from the room out towards its road. */
  facing: number;
}

/**
 * The room a shop's lot holds: one shopfront of the row, in the middle of it.
 * It stands inside the lot, a wall's thickness in from the front, and is no
 * wider than {@link SHOP_FRONT} and no deeper than {@link SHOP_ROOM_DEPTH}, so
 * a shop on a wide or a deep lot keeps the rest of the building as the
 * storefronts and back rooms the player never goes into.
 */
export function roomOf(shop: Shop): ShopRoom {
  const halfWidth = Math.max(MIN_HALF, Math.min(shop.width / 2 - SHOP_WALL, SHOP_FRONT / 2));
  const halfDepth = Math.max(MIN_HALF, Math.min(shop.depth, SHOP_ROOM_DEPTH) / 2 - SHOP_WALL);
  // `facing` points out of the lot towards the road, so the room lies behind
  // the shopfront: its middle is that far back from the door.
  const back = SHOP_WALL + halfDepth;
  return {
    x: shop.x - cos(shop.facing) * back,
    y: shop.y - sin(shop.facing) * back,
    halfWidth,
    halfDepth,
    facing: shop.facing,
  };
}

/**
 * The shops of a world, ascending by district and then by the order the trades
 * were dealt. The buildings are passed in because a caller that has them
 * should not pay for them twice.
 */
export function buildShops(world: WorldDescription, buildings: BuildingMap): Shop[] {
  const streets = highStreets(world, buildings.buildings);
  const shops: Shop[] = [];
  for (let district = 0; district < streets.length; district++) {
    const rows = streets[district] as Building[];
    if (rows.length === 0) continue;
    const trades = SHOP_ORDER.slice(0, Math.min(rows.length, SHOP_ORDER.length));
    // Spread down the street: the first shop stands where the district's own
    // stream puts it and the rest are a stride apart, so two shops are rarely
    // neighbours and no two trades land on one building.
    const rng = genRng(world.seed, Subsystem.Shops, district);
    const picks = spread(rows.length, trades.length, Math.floor(rng.float() * rows.length));
    for (let i = 0; i < trades.length; i++) {
      const row = rows[picks[i] as number] as Building;
      shops.push({
        id: shops.length,
        kind: trades[i] as ShopKind,
        building: row.id,
        district,
        x: row.front.x,
        y: row.front.y,
        facing: row.facing,
        width: row.width,
        depth: row.depth,
        licence: licenceFor(world.districts[district]),
      });
    }
  }
  return shops;
}

/**
 * The shop rows of each district, by district id, ascending by building id. A
 * district with none has an empty street and takes no shop: nothing here turns
 * a house or a tower into one.
 */
function highStreets(world: WorldDescription, buildings: readonly Building[]): Building[][] {
  const streets: Building[][] = world.districts.map(() => []);
  for (const building of buildings) {
    if (building.kind !== 'shop-row') continue;
    streets[building.district]?.push(building);
  }
  return streets;
}

/**
 * The licence a district's weapon shop holds: the poorest third of the city
 * sells hardware over the counter and keeps the rest in the back room, and the
 * richest third is licensed for rifles.
 */
function licenceFor(district: District | undefined): number {
  const wealth = district?.wealth ?? 0;
  return MIN_LICENCE + Math.min(MAX_LICENCE - MIN_LICENCE, Math.floor(wealth * MAX_LICENCE));
}
