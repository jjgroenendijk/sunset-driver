/**
 * The inside of a shop, drawn (spec sections 16.1, 10.3).
 *
 * A handful of shop types are enterable and nothing else has an interior at
 * all, so exactly one room is ever in the scene: the one the player is standing
 * in. It is built when they walk in and let go when they walk out, which is why
 * nothing here streams and nothing here is batched.
 *
 * The player sees the room through their own eyes: the camera goes to first
 * person at the door (spec section 10.7), whatever view they play in. So the
 * room is closed — a floor, four walls, a ceiling — with a shopfront of glass
 * that the street shows through, since the building the room stands in is cut
 * away while they are inside.
 *
 * Every room is dealt from the seed and its shop (`room-style.ts`): the theme
 * it is fitted out in, the floor, the walls, the ceiling, the lamps and the
 * shopfront. A café and a bar are then furnished by `venue-fit.ts` — a counter,
 * seating, pictures and people — and every other trade keeps its counter,
 * its shelves and its goods (`interior-goods.ts`), with the back wall in the
 * trade's own colour.
 *
 * The room is lit from inside. A shop stands in the shadow of its own building,
 * which the shadow pass still casts, so the surfaces carry their own glow and
 * the lamps glow hard enough for the bloom to light them.
 */
import { Group, type BufferGeometry, type Material } from 'three';
import { genRng, Subsystem } from '../../core/rng.ts';
import { isVenue, type ShopKind, type ShopRoom } from '../../world/city/shops.ts';
import { CharacterModel } from '../people/character.ts';
import { glow, InteriorGoods } from './interior-goods.ts';
import { RoomKit } from './room-kit.ts';
import { buildShell, FLOOR_RISE, type Shell } from './room-shell.ts';
import { roomStyleOf, type RoomStyle } from './room-style.ts';
import { fitVenue, type Figure } from './venue-fit.ts';

/** The counter: how high it stands, how deep it is, and how much of the width it runs across. */
const COUNTER_HEIGHT = 0.95;
const COUNTER_DEPTH = 0.6;
const COUNTER_SHARE = 0.8;

/** The shelves along each side wall: how high, how deep, and how much of the room they run down. */
const SHELF_HEIGHT = 1.7;
const SHELF_DEPTH = 0.4;
const SHELF_SHARE = 0.6;

/** The colour the back wall of each trade is painted (spec section 16.1). A café and a bar paint their own. */
const TRADE_COLOUR: Readonly<Partial<Record<ShopKind, number>>> = Object.freeze({
  weapons: 0xd05a5a,
  workshop: 0x8ac0a0,
  convenience: 0x7ad0c0,
  clothing: 0xd0c05a,
  clinic: 0xff7a8a,
  broker: 0xc0a0e0,
});

/** Which shop a room is, which is what deals its look. */
export interface RoomLook {
  kind: ShopKind;
  /** The shop's own id, which keys its style. */
  id: number;
  seed: number;
  /** The wealth of its district, 0 to 1. */
  wealth: number;
}

/** The one room in the scene: the shop the player is standing in, or nothing. */
export class ShopInterior {
  readonly group = new Group();
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];
  private readonly figures: CharacterModel[] = [];
  private goods: InteriorGoods | undefined;
  /** The room on screen, so a frame that has not changed builds nothing. */
  private shown = '';
  /** The look of the room on screen, for the preview and the tests. */
  style: RoomStyle | undefined;
  /**
   * The height of the top of the floor on screen, or undefined with no room.
   * The floor stands on the highest ground under the room, so on a slope it
   * is over the ground the player walks on, and the eyes are stood on it.
   */
  floor: number | undefined;

  constructor() {
    this.group.visible = false;
  }

  /**
   * Build the room of the shop the player has walked into. `floor` is the
   * carved height of the ground under it, which is what the room stands on.
   * Calling it again for the same room does nothing.
   */
  show(room: ShopRoom, floor: number, look: RoomLook): void {
    const key = `${look.kind}|${look.id}|${look.seed}|${room.x.toFixed(2)}|${room.y.toFixed(2)}|${floor.toFixed(2)}`;
    if (key === this.shown) {
      this.group.visible = true;
      return;
    }
    this.clear();
    this.shown = key;
    this.build(room, look);
    // The group stands at the middle of the floor and is turned with the lot,
    // the way a building's shell is: local `z` points out at the road and local
    // `x` runs across the front.
    this.group.position.set(room.x, floor, room.y);
    this.group.rotation.set(0, Math.PI / 2 - room.facing, 0);
    this.group.visible = true;
    this.floor = floor + FLOOR_RISE;
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

  /** The shell, the fittings and the people, in the room's own frame. */
  private build(room: ShopRoom, look: RoomLook): void {
    const venue = isVenue(look.kind);
    const style = roomStyleOf(look.seed, look.id, look.kind, look.wealth, TRADE_COLOUR[look.kind]);
    this.style = style;
    const kit = new RoomKit(style.glow, style.light);
    const rng = genRng(look.seed, Subsystem.Venues, look.id + 0x30000);
    const shell = buildShell(kit, rng, style, room.halfWidth, room.halfDepth);
    const figures = venue ? fitVenue(kit, rng, style, shell, look.kind === 'bar') : [];
    if (!venue) this.fitTrade(kit, style, shell, look.kind);
    const built = kit.build();
    this.group.add(built.group);
    this.geometries.push(...built.geometries);
    this.materials.push(...built.materials);
    for (const figure of figures) this.figure(figure);
  }

  /** A shop's counter across the back of the room, a shelf down each side wall, and its goods. */
  private fitTrade(kit: RoomKit, style: RoomStyle, shell: Shell, kind: ShopKind): void {
    const { halfWidth, halfDepth } = shell;
    const counterZ = -halfDepth * 0.35;
    const floor = FLOOR_RISE;
    kit.block(2 * halfWidth * COUNTER_SHARE, COUNTER_HEIGHT, COUNTER_DEPTH, 0, floor, counterZ, style.wood);
    kit.block(2 * halfWidth * COUNTER_SHARE + 0.08, 0.04, COUNTER_DEPTH + 0.06, 0, floor + COUNTER_HEIGHT - 0.04, counterZ + 0.02, style.metal);
    for (const side of [-1, 1]) {
      const x = side * (halfWidth - SHELF_DEPTH / 2);
      kit.block(SHELF_DEPTH, SHELF_HEIGHT, 2 * halfDepth * SHELF_SHARE, x, floor, -halfDepth * 0.2, style.wood);
    }
    this.goods = new InteriorGoods(kind, {
      halfWidth,
      halfDepth,
      counter: { z: counterZ, half: halfWidth * COUNTER_SHARE, top: COUNTER_HEIGHT + floor },
      shelf: {
        x: halfWidth - SHELF_DEPTH / 2,
        z: -halfDepth * 0.2,
        half: halfDepth * SHELF_SHARE,
        top: SHELF_HEIGHT + floor,
      },
    });
    this.group.add(this.goods.group);
  }

  /** Someone in a café or a bar, standing where the layout put them. */
  private figure(figure: Figure): void {
    const model = new CharacterModel(figure.appearance);
    glow(model.group);
    model.group.rotation.y = figure.turn;
    model.group.position.set(figure.x, FLOOR_RISE, figure.z);
    this.group.add(model.group);
    this.figures.push(model);
  }

  private clear(): void {
    this.goods?.dispose();
    this.goods = undefined;
    for (const figure of this.figures) figure.dispose();
    this.figures.length = 0;
    this.group.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.shown = '';
    this.style = undefined;
    this.floor = undefined;
  }
}
