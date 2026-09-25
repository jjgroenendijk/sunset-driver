/**
 * Weapons lying in the world to be picked up (spec section 11.6): what the
 * dead drop, and what a police car holds.
 *
 * A pickup is a record like everything else in the state: the weapon, the
 * rounds in it and behind it, what is fitted to it, and where it lies. The
 * player takes one by walking over it. `src/render/pickups.ts` draws them.
 *
 * A wrecked police unit leaves what its car held through {@link dropPoliceCar}
 * (`police.ts`). A person of the crowd carries no weapon: what the dead of
 * spec section 13.1 leave is a little cash on the body (`casualty.ts`).
 */
import { rngFor, Subsystem } from '../core/rng.ts';
import { cos, hypot, sin } from '../core/libm.ts';
import { TICK_RATE } from './clock.ts';
import type { SimState } from './simulation.ts';
import {
  DEFAULT_WEAPON,
  normaliseAttachments,
  slotSpec,
  takeWeapon,
  weaponOf,
  type Attachment,
  type Calibre,
  type LoadoutState,
  type WeaponId,
} from './weapon.ts';

/** One weapon lying in the world. */
export interface PickupState {
  /** Unique within a session, so the renderer can follow one pickup from frame to frame. */
  id: number;
  weapon: WeaponId;
  /** What is fitted to it, in the order of `ATTACHMENTS`. */
  attachments: Attachment[];
  /** Rounds in its magazine. */
  loaded: number;
  /** Rounds of its calibre lying with it. */
  rounds: number;
  /** Where it lies, in map metres with `h` above sea level. */
  x: number;
  y: number;
  h: number;
  /** The tick it was dropped. It is gone {@link PICKUP_LIFE} ticks later. */
  droppedTick: number;
}

/** Metres from a pickup the player's feet take it from, across and up. */
const PICKUP_REACH = 1.1;
const PICKUP_HEIGHT = 1.5;

/**
 * Ticks a pickup lies before it is gone: three minutes. This is the only thing
 * that clears the ground: there is no cap on how many lie at once.
 */
export const PICKUP_LIFE = 3 * 60 * TICK_RATE;

/** Metres apart the weapons of one body land, so they do not lie in one heap. */
const DROP_SPREAD = 0.7;

/** What a police car holds (spec section 11.6): a shotgun or an M4. */
export const POLICE_CAR_WEAPONS: readonly WeaponId[] = ['remington-870', 'm4a1'];

/** Magazines of spare rounds that lie with a police car's weapon. */
const POLICE_CAR_SPARE = 2;

/** Put one weapon down in the world, and answer the pickup. */
export function dropWeapon(
  state: SimState,
  weapon: WeaponId,
  loaded: number,
  rounds: number,
  attachments: readonly Attachment[],
  x: number,
  y: number,
  h: number,
): PickupState {
  const pickup: PickupState = {
    id: state.nextPickup,
    weapon,
    attachments: normaliseAttachments(weaponOf(weapon), attachments),
    loaded: Math.max(0, Math.floor(loaded)),
    rounds: Math.max(0, Math.floor(rounds)),
    x,
    y,
    h,
    droppedTick: state.tick,
  };
  state.nextPickup += 1;
  state.pickups.push(pickup);
  return pickup;
}

/**
 * Drop everything a body carried where it fell (spec section 11.6): each
 * weapon but bare fists, with the rounds in its magazine and its attachments.
 * The pool of a calibre lies with the first weapon dropped that takes it, so no
 * round is dropped twice. The weapons lie in a ring round the body.
 */
export function dropCarried(state: SimState, loadout: LoadoutState, x: number, y: number, h: number): PickupState[] {
  const dropped: PickupState[] = [];
  const spent: Calibre[] = [];
  const slots = loadout.slots.filter((slot) => slot.id !== DEFAULT_WEAPON);
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i] as (typeof slots)[number];
    const spec = slotSpec(slot);
    let rounds = 0;
    if (spec.calibre !== undefined && !spent.includes(spec.calibre)) {
      spent.push(spec.calibre);
      rounds = loadout.ammo[spec.calibre];
    }
    const angle = (2 * Math.PI * i) / slots.length;
    const reach = slots.length > 1 ? DROP_SPREAD : 0;
    const px = x + cos(angle) * reach;
    const py = y + sin(angle) * reach;
    dropped.push(dropWeapon(state, slot.id, slot.loaded, rounds, slot.attachments, px, py, h));
  }
  return dropped;
}

/**
 * The weapon a police car holds. It is a property of the car, keyed on its id,
 * so the same car searched twice in a replay holds the same gun.
 */
export function policeCarWeapon(seed: number, vehicleId: number): WeaponId {
  return rngFor(seed, 0, Subsystem.Drops, vehicleId).pick(POLICE_CAR_WEAPONS);
}

/** Drop what a police car holds beside it: its weapon, loaded, with spare magazines (spec section 11.6). */
export function dropPoliceCar(state: SimState, vehicleId: number, x: number, y: number, h: number): PickupState {
  const spec = weaponOf(policeCarWeapon(state.seed, vehicleId));
  return dropWeapon(state, spec.id, spec.capacity, spec.capacity * POLICE_CAR_SPARE, [], x, y, h);
}

/**
 * One tick of the pickups: the player on foot takes what they stand over, and
 * a pickup that has lain its life out is gone. A pickup that would give the
 * player nothing stays where it lies.
 */
export function stepPickups(state: SimState): void {
  const player = state.player;
  const list = state.pickups;
  for (let i = list.length - 1; i >= 0; i--) {
    const pickup = list[i] as PickupState;
    if (state.tick - pickup.droppedTick >= PICKUP_LIFE) {
      list.splice(i, 1);
      continue;
    }
    if (player.driving) continue;
    if (hypot(pickup.x - player.x, pickup.y - player.y) > PICKUP_REACH) continue;
    if (Math.abs(pickup.h - player.height) > PICKUP_HEIGHT) continue;
    if (takeWeapon(state.loadout, pickup.weapon, pickup.loaded, pickup.rounds, pickup.attachments)) {
      list.splice(i, 1);
    }
  }
}
