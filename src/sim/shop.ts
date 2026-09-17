/**
 * Being inside a shop (spec section 16.1).
 *
 * `src/world/shops.ts` says which building is which trade; this is the player
 * walking into one. A shop is entered on the interact key from the pavement in
 * front of its door, which puts the player inside the room the building holds.
 * They walk about it like any other ground — nothing in the city is a wall to
 * them — so they leave it by pressing the key again or by simply walking out
 * of the front. The renderer clips the roof and the front wall away while they
 * are in there, which is how a top-down camera sees a room at all.
 *
 * The key is the one the vehicles use, so the press is handed over rather than
 * read twice: a press that opens a shop door marks the key as held, and
 * `SimPhysics.transfer` then sees no edge on that tick. A press this refuses is
 * left alone, so a player standing at a shop door beside their car still gets
 * into the car, a car within reach of its own door keeps the key, and a player
 * working at a lock is left to it (spec section 11.4): that edge is the lock's
 * until it gives way.
 *
 * Two things refuse a shop. A vehicle cannot be driven through the door, and a
 * shopkeeper with the police outside will not serve. The exceptions are the
 * trades that exist to shed recognition (spec section 16.1): the workshop that
 * resprays and the shop that sells a change of clothes take a player the police
 * are looking for, which is the whole point of them.
 *
 * Pure: it reads the record and the shops, and writes the record. The row
 * bought is taken from the input frame as a number, so a replay of a recorded
 * stream buys the same thing off the same counter.
 */
import { wrapAngle } from '../core/math.ts';
import { roomOf, type Shop, type ShopKind, type ShopRoom } from '../world/shops.ts';
import type { InputFrame } from './input.ts';
import { reachesVehicle, type Place } from './on-foot.ts';
import { offersOf, type ShopOffer } from './shop-stock.ts';
import type { SimState } from './simulation.ts';
import { specOf } from './vehicle.ts';

/** Metres of the door a player on foot may enter from. */
export const DOOR_REACH = 4;

/** Metres past the walls of a room a player counts as still inside it. */
export const ROOM_MARGIN = 0.8;

/** Metres out of the door a player who has left stands. */
export const DOOR_STEP = 1.5;

/** What each trade is called, on the panel and beside its icon on the map. */
export const SHOP_LABELS: Readonly<Record<ShopKind, string>> = Object.freeze({
  weapons: 'Gun shop',
  workshop: 'Workshop',
  convenience: 'Store',
  clothing: 'Clothes',
  clinic: 'Clinic',
  broker: 'Property broker',
});

/**
 * The trades that open to a player the police want, because shedding that is
 * what they sell (spec section 16.1).
 */
export const SHELTERS_WANTED: readonly ShopKind[] = ['workshop', 'clothing'];

/** A shop as the simulation needs it: its door, its trade and the room inside. */
export interface ShopPlace extends Place {
  /** The shop's own id, which keys its stock. */
  id: number;
  kind: ShopKind;
  /** What the panel and the map call it: the trade and the district it stands in. */
  name: string;
  /** The licence a weapon shop holds; every other trade reads it for nothing. */
  licence: number;
  /** The room behind the door, as `roomOf` cuts it from the lot. */
  room: ShopRoom;
}

/** The shop the player is inside, as the record carries it. */
export interface ShopVisit {
  /** Index into the world's shops of the shop they walked into. */
  shop: number;
  /** The tick they walked in on. */
  started: number;
  /** What the last trade said, in the words the panel shows. Empty before the first. */
  said: string;
}

/**
 * The shops as the simulation reads them: the door faces out of the lot, which
 * is the way a player who leaves is turned. `districts` is the world's own
 * list, for the names.
 */
export function shopPlaces(shops: readonly Shop[], districts: readonly { name: string }[]): ShopPlace[] {
  return shops.map((shop) => ({
    id: shop.id,
    kind: shop.kind,
    name: `${SHOP_LABELS[shop.kind]} · ${districts[shop.district]?.name ?? 'Downtown'}`,
    licence: shop.licence,
    x: shop.x,
    y: shop.y,
    heading: shop.facing,
    room: roomOf(shop),
  }));
}

/**
 * The shop door the player is standing at, or -1. The nearest one answers,
 * because two shops of one street can stand within reach of each other. A
 * player driving past a door is at it too, so the panel can say why they may
 * not go in.
 */
export function shopAt(places: readonly ShopPlace[], state: SimState): number {
  let at = -1;
  let near = DOOR_REACH;
  for (let i = 0; i < places.length; i++) {
    const place = places[i] as ShopPlace;
    const away = Math.hypot(place.x - state.player.x, place.y - state.player.y);
    if (away > near) continue;
    near = away;
    at = i;
  }
  return at;
}

/**
 * Why a shop will not open, in the words the panel shows, or null when it will.
 * A player at no door is asked nothing, so this answers for one at a door.
 */
export function shopRefusal(state: SimState, place: ShopPlace): string | null {
  if (state.player.driving) return 'Not with a vehicle.';
  if (state.heat > 0 && !SHELTERS_WANTED.includes(place.kind)) return 'Not while the police want you.';
  return null;
}

/** The shop the player is inside, or undefined while they are on the street. */
export function visiting(state: SimState, places: readonly ShopPlace[]): ShopPlace | undefined {
  const visit = state.shop;
  return visit === null ? undefined : places[visit.shop];
}

/** The counter of the shop the player is inside: nothing at all while they are outside one. */
export function shopOffers(state: SimState, places: readonly ShopPlace[]): ShopOffer[] {
  const place = visiting(state, places);
  return place === undefined ? [] : offersOf(state, place);
}

/** True where a point stands inside a shop's room, walls and all. */
export function inRoom(room: ShopRoom, x: number, y: number): boolean {
  const dx = x - room.x;
  const dy = y - room.y;
  const along = dx * Math.cos(room.facing) + dy * Math.sin(room.facing);
  const across = -dx * Math.sin(room.facing) + dy * Math.cos(room.facing);
  return Math.abs(along) <= room.halfDepth + ROOM_MARGIN && Math.abs(across) <= room.halfWidth + ROOM_MARGIN;
}

/**
 * Advance the shops by one tick, before the physics steps.
 *
 * It opens the door the interact key is pressed at, buys the row the input
 * frame names, and puts a player who pressed the key again back on the street.
 * Answers true on the tick the player is moved, which is the tick the physics
 * has to stand them on the ground where they landed.
 */
export function stepShops(state: SimState, input: InputFrame, places: readonly ShopPlace[]): boolean {
  const p = state.player;
  // A player bent over a lock is not going shopping, and the interact key is
  // the lock's while an attempt runs (spec section 11.4): nothing else may read
  // that edge.
  if (state.theft !== null) return false;
  const pressed = input.interact && !p.held.interact;
  const visit = state.shop;
  if (visit !== null) {
    const place = places[visit.shop];
    if (place === undefined) {
      state.shop = null;
      return false;
    }
    if (pressed) {
      // The press is spent here, so the vehicle at the kerb does not open on it.
      p.held.interact = true;
      leave(state, place);
      return true;
    }
    // A player who walked out of the room is out of the shop, and stands where
    // their own feet took them.
    if (!inRoom(place.room, p.x, p.y)) {
      state.shop = null;
      return false;
    }
    const row = Math.trunc(input.buy);
    if (row >= 1) trade(state, place, row - 1);
    return false;
  }
  if (!pressed || p.driving) return false;
  // The vehicle has the key first (spec section 11.2). A player within reach of
  // its door is opening that door: the door is reached from a metre and a shop
  // from four, so the car at the kerb would otherwise be unreachable wherever a
  // shop stands, which is most of a high street.
  if (reachesVehicle(p, state.vehicle, specOf(state.vehicle.cls))) return false;
  const at = shopAt(places, state);
  const place = places[at];
  if (place === undefined || shopRefusal(state, place) !== null) return false;
  p.held.interact = true;
  state.shop = { shop: at, started: state.tick, said: '' };
  const room = place.room;
  p.x = room.x;
  p.y = room.y;
  p.heading = wrapAngle(room.facing + Math.PI);
  p.speed = 0;
  p.vy = 0;
  p.grounded = false;
  return true;
}

/** Put the player back on the pavement outside the door, facing away from it. */
function leave(state: SimState, place: ShopPlace): void {
  const p = state.player;
  state.shop = null;
  p.x = place.x + Math.cos(place.heading) * DOOR_STEP;
  p.y = place.y + Math.sin(place.heading) * DOOR_STEP;
  p.heading = place.heading;
  p.speed = 0;
  p.vy = 0;
  p.grounded = false;
}

/**
 * Buy one row of the counter. A row that is not there and money that is not
 * enough both leave the record as it was; what happened is written into the
 * visit, because the panel draws the record and nothing else.
 */
function trade(state: SimState, place: ShopPlace, row: number): void {
  const visit = state.shop;
  if (visit === null) return;
  const offer = offersOf(state, place)[row];
  if (offer === undefined) return;
  if (state.money < offer.price) {
    visit.said = 'Not enough money.';
    return;
  }
  state.money -= offer.price;
  visit.said = offer.take(state);
}
