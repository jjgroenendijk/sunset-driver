/**
 * The shop rooms in the scene (spec sections 16.1, 10.3): the one the player is
 * standing in, and the few nearest them, so the street can look in through a
 * shopfront.
 *
 * A room is built when the player comes within {@link ROOM_REACH} of its door
 * and let go when they walk away, at most one new room a frame: a furnished bar
 * is several hundred parts to merge, and a street of them built in one frame
 * would be a hitch. The room the player is inside is built at once, whatever the
 * budget says. No more than {@link ROOM_CUTS} stand at once, because each is cut
 * out of its building by a box the building shader tests (`cutaway.ts`).
 *
 * Each room is closed, and its lid is lifted off whenever the camera stands over
 * it, so a player who plays top down looks down into the room they walk into,
 * and one in first person sees a ceiling.
 */
import { Group } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import { SHOP_ROOM_HEIGHT, type ShopKind, type ShopRoom } from '../../world/city/shops.ts';
import { ROOM_CUTS, type RoomCut } from '../camera/cutaway.ts';
import { ShopInterior } from './interior.ts';
import { FLOOR_RISE } from './room-shell.ts';

/** Metres from the player to a shop's door within which its room is built. */
export const ROOM_REACH = 40;

/**
 * Metres a room already built is let off in the race for a place, so a room at
 * the edge of the reach is not built and let go on alternate frames.
 */
const KEEP = 8;

/** A shop whose room may be shown: which one it is, and the room its lot holds. */
export interface RoomPlace {
  kind: ShopKind;
  id: number;
  wealth: number;
  room: ShopRoom;
  /** The door, where the player's distance is measured to. */
  x: number;
  y: number;
}

/** One room in the scene, and the floor it was stood on. */
interface Shown {
  interior: ShopInterior;
  floor: number;
  room: ShopRoom;
}

/** The rooms near the player, built and let go as they walk. */
export class ShopRooms {
  readonly group = new Group();
  private readonly shown = new Map<number, Shown>();
  private readonly dress: ((material: MeshStandardNodeMaterial) => void) | undefined;
  /**
   * The height of the top of the floor of the room the player is inside, or
   * undefined when they are in none. The eyes stand on it: on a slope it is
   * over the ground the player walks on.
   */
  floor: number | undefined;

  constructor(dress?: (material: MeshStandardNodeMaterial) => void) {
    this.dress = dress;
  }

  /**
   * The rooms to show this frame, nearest first: the one the player is inside,
   * then the nearest others within {@link ROOM_REACH}, up to {@link ROOM_CUTS}.
   */
  pick(places: readonly RoomPlace[], x: number, y: number, inside: number | undefined): RoomPlace[] {
    const near: { place: RoomPlace; score: number }[] = [];
    for (const place of places) {
      const distance = Math.hypot(place.x - x, place.y - y);
      const kept = this.shown.has(place.id) ? KEEP : 0;
      if (place.id !== inside && distance - kept > ROOM_REACH) continue;
      near.push({ place, score: place.id === inside ? -Infinity : distance - kept });
    }
    near.sort((a, b) => a.score - b.score || a.place.id - b.place.id);
    return near.slice(0, ROOM_CUTS).map((entry) => entry.place);
  }

  /**
   * Show the rooms picked, build at most one that is not yet built (and the
   * one the player is inside, whatever), and let the rest go. `floorOf` says
   * what a room stands on, and `cameraY` whether each lid is lifted. Answers
   * the rooms standing, for the cut of `cutaway.ts`.
   */
  update(
    picked: readonly RoomPlace[],
    inside: number | undefined,
    seed: number,
    floorOf: (room: ShopRoom) => number,
    cameraY: number,
  ): RoomCut[] {
    const wanted = new Set(picked.map((place) => place.id));
    for (const [id, shown] of this.shown) {
      if (wanted.has(id)) continue;
      shown.interior.dispose();
      this.group.remove(shown.interior.group);
      this.shown.delete(id);
    }
    let budget = 1;
    const cuts: RoomCut[] = [];
    this.floor = undefined;
    for (const place of picked) {
      let shown = this.shown.get(place.id);
      if (shown === undefined) {
        if (budget <= 0 && place.id !== inside) continue;
        budget--;
        shown = this.build(place, seed, floorOf(place.room));
      }
      shown.interior.open = cameraY > shown.floor + FLOOR_RISE + SHOP_ROOM_HEIGHT;
      if (place.id === inside) this.floor = shown.interior.floor;
      cuts.push({ room: shown.room, floor: shown.floor });
    }
    return cuts;
  }

  /** The room of the shop the player is inside, if it is built: the preview and the tests read it. */
  interiorOf(id: number): ShopInterior | undefined {
    return this.shown.get(id)?.interior;
  }

  /** How many rooms stand in the scene. */
  get count(): number {
    return this.shown.size;
  }

  dispose(): void {
    for (const shown of this.shown.values()) shown.interior.dispose();
    this.shown.clear();
    this.group.clear();
  }

  private build(place: RoomPlace, seed: number, floor: number): Shown {
    const interior = new ShopInterior(this.dress);
    interior.show(place.room, floor, { kind: place.kind, id: place.id, wealth: place.wealth, seed });
    this.group.add(interior.group);
    const shown = { interior, floor, room: place.room };
    this.shown.set(place.id, shown);
    return shown;
  }
}
