/**
 * The inside of a shop, drawn (spec sections 16.1, 10.3).
 *
 * A handful of shop types are enterable and nothing else has an interior at
 * all, so exactly one room is ever in the scene: the one the player is standing
 * in. It is built when they walk in and let go when they walk out, which is why
 * nothing here streams and nothing here is batched.
 *
 * The room is a closed box — four walls, a floor and a ceiling — and a
 * `ClippingGroup` cuts the roof and the front wall away, so the camera 30 m
 * over the street sees in. The walls are whole: the clip is two planes in world
 * space, not a hole in the geometry, so a room is built the same way whichever
 * way its door faces and the shopfront is still there when the planes move.
 *
 * The room is lit from inside. A shop stands in the shadow of its own building,
 * which the shadow pass still casts (the cut of `cutaway.ts` is not read by it),
 * so the surfaces carry their own glow rather than waiting for a sun that
 * cannot reach them.
 *
 * The trade is read off the back wall: each one has its own colour, so a player
 * looking down at a room knows what they walked into. The goods of the trade
 * stand on the shelves and the counter, with a shopkeeper behind it
 * (`interior-goods.ts`).
 */
import { BoxGeometry, Color, Mesh, MeshStandardMaterial, Plane, Vector3, type BufferGeometry, type Material } from 'three';
import { ClippingGroup } from 'three/webgpu';
import { InteriorGoods } from './interior-goods.ts';
import { SHOP_ROOM_HEIGHT, SHOP_WALL, type ShopKind, type ShopRoom } from '../world/shops.ts';

/** Metres of the floor slab and the ceiling slab. */
const SLAB = 0.12;

/** The counter: how high it stands, how deep it is, and how much of the width it runs across. */
const COUNTER_HEIGHT = 0.95;
const COUNTER_DEPTH = 0.6;
const COUNTER_SHARE = 0.8;

/** The shelves along each side wall: how high, how deep, and how much of the room they run down. */
const SHELF_HEIGHT = 1.7;
const SHELF_DEPTH = 0.4;
const SHELF_SHARE = 0.6;

/** What the room is made of, before the trade colours its back wall. */
const FLOOR_COLOUR = 0x3a3630;
const WALL_COLOUR = 0xd8d2c4;
const FITTING_COLOUR = 0x6b5a44;

/** How much of its own colour each surface gives off, so a room in shadow reads. */
const GLOW = 0.35;
const SIGN_GLOW = 0.7;

/** The colour the back wall of each trade is painted (spec section 16.1). */
const TRADE_COLOUR: Readonly<Record<ShopKind, number>> = Object.freeze({
  weapons: 0xd05a5a,
  workshop: 0x8ac0a0,
  convenience: 0x7ad0c0,
  clothing: 0xd0c05a,
  clinic: 0xff7a8a,
  broker: 0xc0a0e0,
});

/** The one room in the scene: the shop the player is standing in, or nothing. */
export class ShopInterior {
  /** The clip of spec section 10.3: the roof and the front wall are cut off this group. */
  readonly group = new ClippingGroup();
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];
  private goods: InteriorGoods | undefined;
  /** The room on screen, so a frame that has not changed builds nothing. */
  private shown = '';

  constructor() {
    this.group.visible = false;
  }

  /**
   * Build the room of the shop the player has walked into. `floor` is the
   * carved height of the ground under it, which is what the room stands on.
   * Calling it again for the same room does nothing.
   */
  show(room: ShopRoom, floor: number, kind: ShopKind): void {
    const key = `${kind}|${room.x.toFixed(2)}|${room.y.toFixed(2)}|${floor.toFixed(2)}`;
    if (key === this.shown) {
      this.group.visible = true;
      return;
    }
    this.clear();
    this.shown = key;
    this.build(room, kind);
    // The group stands at the middle of the floor and is turned with the lot,
    // the way a building's shell is: local `z` points out at the road and local
    // `x` runs across the front.
    this.group.position.set(room.x, floor, room.y);
    this.group.rotation.set(0, Math.PI / 2 - room.facing, 0);
    this.group.clippingPlanes = [ceilingPlane(floor), frontPlane(room)];
    this.group.visible = true;
  }

  /** Take the room out of the scene. The player has left, or never went in. */
  hide(): void {
    if (this.shown === '') return;
    this.clear();
    this.group.visible = false;
  }

  dispose(): void {
    this.clear();
  }

  /** The walls, the floor, the ceiling and the fittings, in the room's own frame. */
  private build(room: ShopRoom, kind: ShopKind): void {
    const width = room.halfWidth + SHOP_WALL;
    const depth = room.halfDepth + SHOP_WALL;
    const high = SHOP_ROOM_HEIGHT;
    const wall = this.paint(WALL_COLOUR, GLOW);
    // The floor and the ceiling cover the walls as well as the room, so no
    // corner shows daylight.
    this.add(2 * width, SLAB, 2 * depth, 0, -SLAB / 2, 0, this.paint(FLOOR_COLOUR, GLOW));
    this.add(2 * width, SLAB, 2 * depth, 0, high + SLAB / 2, 0, wall);
    // The back wall carries the trade's colour; the front one is what the clip
    // takes away, and is built all the same.
    this.add(2 * width, high, SHOP_WALL, 0, high / 2, -depth + SHOP_WALL / 2, this.paint(TRADE_COLOUR[kind], SIGN_GLOW));
    this.add(2 * width, high, SHOP_WALL, 0, high / 2, depth - SHOP_WALL / 2, wall);
    for (const side of [-1, 1]) {
      this.add(SHOP_WALL, high, 2 * room.halfDepth, side * (room.halfWidth + SHOP_WALL / 2), high / 2, 0, wall);
    }
    const fittings = this.paint(FITTING_COLOUR, GLOW);
    // The counter across the back of the room, and a shelf down each side wall.
    this.add(
      2 * room.halfWidth * COUNTER_SHARE,
      COUNTER_HEIGHT,
      COUNTER_DEPTH,
      0,
      COUNTER_HEIGHT / 2,
      -room.halfDepth * 0.35,
      fittings,
    );
    for (const side of [-1, 1]) {
      this.add(
        SHELF_DEPTH,
        SHELF_HEIGHT,
        2 * room.halfDepth * SHELF_SHARE,
        side * (room.halfWidth - SHELF_DEPTH / 2),
        SHELF_HEIGHT / 2,
        -room.halfDepth * 0.2,
        fittings,
      );
    }
    this.goods = new InteriorGoods(kind, {
      halfWidth: room.halfWidth,
      halfDepth: room.halfDepth,
      counter: { z: -room.halfDepth * 0.35, half: room.halfWidth * COUNTER_SHARE, top: COUNTER_HEIGHT },
      shelf: {
        x: room.halfWidth - SHELF_DEPTH / 2,
        z: -room.halfDepth * 0.2,
        half: room.halfDepth * SHELF_SHARE,
        top: SHELF_HEIGHT,
      },
    });
    this.group.add(this.goods.group);
  }

  private paint(colour: number, glow: number): MeshStandardMaterial {
    const material = new MeshStandardMaterial({
      color: colour,
      roughness: 0.8,
      emissive: new Color(colour),
      emissiveIntensity: glow,
    });
    this.materials.push(material);
    return material;
  }

  private add(
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    material: MeshStandardMaterial,
  ): void {
    const geometry = new BoxGeometry(width, height, depth);
    this.geometries.push(geometry);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
  }

  private clear(): void {
    this.goods?.dispose();
    this.goods = undefined;
    this.group.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.shown = '';
  }
}

/** The plane that cuts the ceiling off: everything over the room goes. */
export function ceilingPlane(floor: number): Plane {
  return new Plane().setFromNormalAndCoplanarPoint(new Vector3(0, -1, 0), new Vector3(0, floor + SHOP_ROOM_HEIGHT, 0));
}

/**
 * The plane that cuts the front wall off: everything on the road side of the
 * inner face of the shopfront goes. The room's `facing` points out at the road,
 * so that is the direction the plane keeps nothing beyond.
 */
export function frontPlane(room: ShopRoom): Plane {
  const out = new Vector3(Math.cos(room.facing), 0, Math.sin(room.facing));
  const face = new Vector3(room.x + out.x * room.halfDepth, 0, room.y + out.z * room.halfDepth);
  return new Plane().setFromNormalAndCoplanarPoint(out.clone().negate(), face);
}
