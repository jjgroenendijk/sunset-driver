import { describe, expect, it } from 'vitest';
import { ROOM_CUTS } from '../../../src/render/camera/cutaway.ts';
import { ROOM_REACH, ShopRooms, type RoomPlace } from '../../../src/render/shops/rooms.ts';
import { roomOf, SHOP_ROOM_HEIGHT, type Shop } from '../../../src/world/city/shops.ts';

/** A convenience store every 15 m along the x axis, fronting +y. */
function placeAt(id: number): RoomPlace {
  const shop: Shop = {
    id,
    kind: 'convenience',
    building: id,
    district: 0,
    x: id * 15,
    y: 0,
    facing: Math.PI / 2,
    width: 10,
    depth: 12,
    licence: 1,
    wealth: 0.5,
  };
  return { kind: shop.kind, id, wealth: shop.wealth, room: roomOf(shop), x: shop.x, y: shop.y };
}

const STREET = Array.from({ length: 20 }, (_, i) => placeAt(i));
const FLOOR = 3;
const floorOf = (): number => FLOOR;

/** Spec section 16.1: the street looks into the shops near the player. */
describe('shop rooms near the player', () => {
  it('picks the nearest rooms within reach, no more than the cut holds', () => {
    const rooms = new ShopRooms();
    const picked = rooms.pick(STREET, 0, 5, undefined);
    expect(picked.length).toBeLessThanOrEqual(ROOM_CUTS);
    expect(picked.map((place) => place.id)).toEqual([0, 1, 2]);
    for (const place of picked) expect(Math.hypot(place.x, place.y - 5)).toBeLessThanOrEqual(ROOM_REACH);
    // Far from every shop, nothing is picked.
    expect(rooms.pick(STREET, 0, 500, undefined)).toEqual([]);
  });

  it('always picks the room the player is inside, first', () => {
    const rooms = new ShopRooms();
    const picked = rooms.pick(STREET, 0, 500, 7);
    expect(picked.map((place) => place.id)).toEqual([7]);
    expect(rooms.pick(STREET, 0, 5, 2)[0]?.id).toBe(2);
  });

  it('builds one new room a frame, but the one the player is inside at once', () => {
    const rooms = new ShopRooms();
    const picked = rooms.pick(STREET, 15, 5, undefined);
    expect(rooms.update(picked, undefined, 7, floorOf, 30)).toHaveLength(1);
    expect(rooms.update(picked, undefined, 7, floorOf, 30)).toHaveLength(2);
    expect(rooms.update(picked, undefined, 7, floorOf, 30)).toHaveLength(3);
    expect(rooms.count).toBe(3);
    expect(rooms.floor).toBeUndefined();
    // Walking into a shop far down the street builds it now and lets the rest go.
    const inside = rooms.pick(STREET, 200, 5, 13);
    const cuts = rooms.update(inside, 13, 7, floorOf, 30);
    expect(cuts.map((cut) => cut.room)).toContainEqual(STREET[13]?.room);
    expect(rooms.floor).toBeGreaterThan(FLOOR);
    expect(rooms.interiorOf(1)).toBeUndefined();
    rooms.dispose();
  });

  it('lifts the lid off for a camera over the ceiling, and keeps it on for one inside', () => {
    const rooms = new ShopRooms();
    const picked = rooms.pick(STREET, 0, 5, 0);
    rooms.update(picked, 0, 7, floorOf, FLOOR + 1.6);
    expect(rooms.interiorOf(0)?.open).toBe(false);
    rooms.update(picked, 0, 7, floorOf, FLOOR + SHOP_ROOM_HEIGHT + 20);
    expect(rooms.interiorOf(0)?.open).toBe(true);
    rooms.dispose();
  });
});
