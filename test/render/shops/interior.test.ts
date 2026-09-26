import { describe, expect, it } from 'vitest';
import { Box3, Raycaster, Vector3 } from 'three';
import { ShopInterior, type RoomLook } from '../../../src/render/shops/interior.ts';
import { roomStyleOf, THEME_NAMES } from '../../../src/render/shops/room-style.ts';
import { roomOf, SHOP_ROOM_HEIGHT, type Shop, type ShopKind } from '../../../src/world/city/shops.ts';

/** A shop on a lot 10 m across and 12 m deep, its front facing the way asked. */
function shopOf(facing: number, kind: ShopKind = 'weapons', id = 0): Shop {
  return { id, kind, building: 0, district: 0, x: 40, y: -20, facing, width: 10, depth: 12, licence: 2, wealth: 0.5 };
}

function lookOf(shop: Shop, seed = 7): RoomLook {
  return { kind: shop.kind, id: shop.id, seed, wealth: shop.wealth };
}

/** The floor the rooms of these tests stand on. */
const FLOOR = 7;

/**
 * The interiors of spec sections 16.1 and 10.3: a closed room seen from the
 * player's eyes, dealt from the seed and the shop.
 */
describe('shop interiors', () => {
  it('builds one room, turned with the lot and standing on its floor', () => {
    const interior = new ShopInterior();
    const shop = shopOf(Math.PI / 2);
    const room = roomOf(shop);
    interior.show(room, FLOOR, lookOf(shop));
    expect(interior.group.visible).toBe(true);
    expect(interior.group.children.length).toBeGreaterThan(0);
    expect(interior.group.position.toArray()).toEqual([room.x, FLOOR, room.y]);
    // Local +z points out at the road, as a building's shell does: the front
    // faces +y here, so local +z maps to world +z.
    const out = new Vector3(0, 0, 1).applyQuaternion(interior.group.quaternion);
    expect(out.x).toBeCloseTo(Math.cos(room.facing), 6);
    expect(out.z).toBeCloseTo(Math.sin(room.facing), 6);
    interior.dispose();
  });

  it('stands every wall, fitting and person inside the lot it was cut from', () => {
    for (const kind of ['weapons', 'cafe', 'bar'] as const) {
      for (let id = 0; id < 6; id++) {
        const interior = new ShopInterior();
        // The front faces +x, so the lot runs from the door back along -x.
        const shop = shopOf(0, kind, id);
        interior.show(roomOf(shop), FLOOR, lookOf(shop));
        interior.group.updateMatrixWorld(true);
        const box = new Box3().setFromObject(interior.group);
        expect(box.max.x).toBeLessThanOrEqual(shop.x + 0.05);
        expect(box.min.x).toBeGreaterThanOrEqual(shop.x - shop.depth);
        expect(box.max.z).toBeLessThanOrEqual(shop.y + shop.width / 2 + 0.05);
        expect(box.min.z).toBeGreaterThanOrEqual(shop.y - shop.width / 2 - 0.05);
        expect(box.min.y).toBeGreaterThanOrEqual(FLOOR - 0.2);
        expect(box.max.y).toBeLessThanOrEqual(FLOOR + SHOP_ROOM_HEIGHT + 0.2);
        interior.dispose();
      }
    }
  });

  it('closes the room over and under the player, and leaves the doorway open', () => {
    for (const facing of [0, Math.PI / 2, Math.PI, -2.4]) {
      const interior = new ShopInterior();
      const shop = shopOf(facing, 'cafe', 3);
      const room = roomOf(shop);
      interior.show(room, FLOOR, lookOf(shop));
      interior.group.updateMatrixWorld(true);
      const eye = new Vector3(room.x, FLOOR + 1.6, room.y);
      const ray = new Raycaster();
      const hit = (direction: Vector3): number | undefined => {
        ray.set(eye, direction.normalize());
        return ray.intersectObject(interior.group, true)[0]?.distance;
      };
      expect(hit(new Vector3(0, 1, 0))).toBeLessThanOrEqual(SHOP_ROOM_HEIGHT - 1.6 + 0.01);
      expect(hit(new Vector3(0, -1, 0))).toBeLessThanOrEqual(1.6);
      // From the middle of the front, straight out of the door, nothing stands in the way.
      const out = new Vector3(Math.cos(facing), 0, Math.sin(facing));
      eye.set(room.x + out.x * (room.halfDepth - 0.5), FLOOR + 1.2, room.y + out.z * (room.halfDepth - 0.5));
      expect(hit(out.clone())).toBeUndefined();
      interior.dispose();
    }
  });

  it('builds the same room only once, and takes it away when the player leaves', () => {
    const interior = new ShopInterior();
    const shop = shopOf(1);
    const room = roomOf(shop);
    interior.show(room, FLOOR, lookOf(shop));
    const built = interior.group.children.length;
    interior.show(room, FLOOR, lookOf(shop));
    expect(interior.group.children).toHaveLength(built);
    interior.hide();
    expect(interior.group.visible).toBe(false);
    expect(interior.group.children).toHaveLength(0);
    // A second room is built in its place, not beside it.
    interior.show(roomOf(shopOf(1, 'bar', 4)), FLOOR, lookOf(shopOf(1, 'bar', 4)));
    expect(interior.style?.theme).toBeDefined();
    expect(THEME_NAMES.bar).toContain(interior.style?.theme);
    interior.dispose();
  });

  it('fits out the cafés and the bars of one city in many different ways', () => {
    for (const kind of ['cafe', 'bar'] as const) {
      const themes = new Set<string>();
      const looks = new Set<string>();
      for (let id = 0; id < 60; id++) {
        const style = roomStyleOf(7, id, kind, (id % 10) / 10);
        themes.add(style.theme);
        looks.add(`${style.floor.pattern}|${style.wall.pattern}|${style.ceiling.pattern}|${style.lamps.kind}|${style.wall.base}`);
      }
      expect(themes.size).toBeGreaterThanOrEqual(5);
      expect(looks.size).toBeGreaterThan(50);
    }
  });

  it('keeps the colour of a trade on the back wall of its shop', () => {
    const style = roomStyleOf(7, 1, 'clinic', 0.5, 0xff7a8a);
    expect(style.wall.feature).toBe(0xff7a8a);
  });

  it('puts someone behind the counter of every café and bar', () => {
    for (const kind of ['cafe', 'bar'] as const) {
      const interior = new ShopInterior();
      const shop = shopOf(0.3, kind, 2);
      interior.show(roomOf(shop), FLOOR, lookOf(shop));
      // The merged room is one child; every person is another.
      expect(interior.group.children.length).toBeGreaterThan(1);
      interior.dispose();
    }
  });
});
