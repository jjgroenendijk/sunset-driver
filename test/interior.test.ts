import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ShopInterior } from '../src/render/interior.ts';
import { roomOf, SHOP_ROOM_HEIGHT, type Shop, type ShopKind } from '../src/world/shops.ts';

/** A shop on a lot 10 m across and 12 m deep, its front facing the way asked. */
function shopOf(facing: number, kind: ShopKind = 'weapons'): Shop {
  return { id: 0, kind, building: 0, district: 0, x: 40, y: -20, facing, width: 10, depth: 12, licence: 2 };
}

/** The floor the rooms of these tests stand on. */
const FLOOR = 7;

/**
 * The interiors of spec sections 16.1 and 10.3: the room, and the clip that
 * takes its roof and its front wall away so the camera overhead sees in.
 */
describe('shop interiors', () => {
  it('builds one room, turned with the lot and standing on its floor', () => {
    const interior = new ShopInterior();
    const shop = shopOf(Math.PI / 2);
    const room = roomOf(shop);
    interior.show(room, FLOOR, shop.kind);
    expect(interior.group.visible).toBe(true);
    expect(interior.group.children.length).toBeGreaterThan(5);
    expect(interior.group.position.toArray()).toEqual([room.x, FLOOR, room.y]);
    // Local +z points out at the road, as a building's shell does: the front
    // faces +y here, so local +z maps to world +z.
    const out = new Vector3(0, 0, 1).applyQuaternion(interior.group.quaternion);
    expect(out.x).toBeCloseTo(Math.cos(room.facing), 6);
    expect(out.z).toBeCloseTo(Math.sin(room.facing), 6);
    interior.dispose();
  });

  it('stands every wall and fitting inside the lot it was cut from', () => {
    const interior = new ShopInterior();
    const shop = shopOf(0);
    const room = roomOf(shop);
    interior.show(room, FLOOR, shop.kind);
    interior.group.updateMatrixWorld(true);
    for (const child of interior.group.children) {
      const middle = new Vector3().setFromMatrixPosition(child.matrixWorld);
      const away = Math.hypot(middle.x - room.x, middle.z - room.y);
      expect(away).toBeLessThanOrEqual(Math.hypot(shop.width, shop.depth) / 2);
      expect(middle.y).toBeGreaterThanOrEqual(FLOOR - 1);
      expect(middle.y).toBeLessThanOrEqual(FLOOR + SHOP_ROOM_HEIGHT + 1);
    }
    interior.dispose();
  });

  it('clips the ceiling and the front wall away, and keeps the room between them', () => {
    const interior = new ShopInterior();
    for (const facing of [0, Math.PI / 2, Math.PI, -2.4]) {
      const shop = shopOf(facing);
      const room = roomOf(shop);
      interior.show(room, FLOOR, shop.kind);
      const planes = interior.group.clippingPlanes;
      expect(planes).toHaveLength(2);
      // A point is drawn only where every plane keeps it.
      const kept = (x: number, y: number, z: number): boolean =>
        planes.every((plane) => plane.distanceToPoint(new Vector3(x, y, z)) >= 0);
      const out = { x: Math.cos(facing), y: Math.sin(facing) };
      // Head height in the middle of the room: kept, or there is nothing to see.
      expect(kept(room.x, FLOOR + 1.6, room.y)).toBe(true);
      // Over the ceiling: the roof goes.
      expect(kept(room.x, FLOOR + SHOP_ROOM_HEIGHT + 0.2, room.y)).toBe(false);
      // Out past the shopfront: the front wall goes.
      const front = room.halfDepth + 0.2;
      expect(kept(room.x + out.x * front, FLOOR + 1.6, room.y + out.y * front)).toBe(false);
      // Just inside it: the room is whole up to the glass.
      const inside = room.halfDepth - 0.2;
      expect(kept(room.x + out.x * inside, FLOOR + 1.6, room.y + out.y * inside)).toBe(true);
      // The back of the room is never cut.
      expect(kept(room.x - out.x * front, FLOOR + 1.6, room.y - out.y * front)).toBe(true);
    }
    interior.dispose();
  });

  it('builds the same room only once, and takes it away when the player leaves', () => {
    const interior = new ShopInterior();
    const shop = shopOf(1);
    const room = roomOf(shop);
    interior.show(room, FLOOR, shop.kind);
    const built = interior.group.children.length;
    interior.show(room, FLOOR, shop.kind);
    expect(interior.group.children).toHaveLength(built);
    interior.hide();
    expect(interior.group.visible).toBe(false);
    expect(interior.group.children).toHaveLength(0);
    // A second room is built in its place, not beside it.
    interior.show(roomOf(shopOf(1, 'clinic')), FLOOR, 'clinic');
    expect(interior.group.children).toHaveLength(built);
    interior.dispose();
  });
});
