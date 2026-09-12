/**
 * What the player is carrying (spec section 11.6): the weapons, the rounds in
 * them and the pools behind them, and everything that moves rounds about.
 *
 * A magazine is two numbers — the rounds in the weapon and the pool behind it —
 * because ammunition is per calibre and shared by every weapon that takes it.
 * Emptying a Glock and reloading a Beretta therefore draws on the same 9×19.
 *
 * The record is plain numbers, like the rest of the simulation state. The
 * firing model that reads it is `weapon.ts`.
 */
import { AMMO_CAP, CALIBRES, type Calibre, type WeaponId, type WeaponSpec } from './weapon.ts';
import { DEFAULT_WEAPON, weaponOf } from './arsenal.ts';

/** Magazines of spare ammunition a weapon comes with when it is given out. */
export const SPARE_MAGAZINES = 3;

/** One weapon the player is carrying, and the rounds in its magazine. */
export interface WeaponSlot {
  id: WeaponId;
  /** Rounds in the magazine. Always 0 on a melee weapon. */
  loaded: number;
}

/**
 * What the player is carrying, as the record holds it: the weapons, the pools
 * behind them and the state of the one in their hands. Plain numbers, like
 * everything else in the state.
 */
export interface LoadoutState {
  /** The weapons carried, in the order the cycle key walks them. */
  slots: WeaponSlot[];
  /** Which slot is in their hands, an index into {@link LoadoutState.slots}. */
  current: number;
  /** Rounds held per calibre, shared by every weapon that takes it. */
  ammo: Record<Calibre, number>;
  /** The tick the weapon in hand last fired, or -1 before its first shot. */
  firedTick: number;
  /** The tick the reload finishes, or -1 while nothing is being reloaded. */
  reloadTick: number;
  /** Radians of recoil still standing, which widens the next shot. */
  recoil: number;
  /** True while the player is aiming rather than firing from the hip. */
  aiming: boolean;
  /** Shots fired this session. It keys the random stream of each one. */
  shots: number;
  /** The keys that were down last tick, so a press acts once rather than every tick. */
  held: { fire: boolean; reload: boolean; cycle: boolean };
}

/** An empty pool of every calibre. */
function emptyAmmo(): Record<Calibre, number> {
  const ammo = {} as Record<Calibre, number>;
  for (const calibre of CALIBRES) ammo[calibre] = 0;
  return ammo;
}

/** A player carrying their fists and nothing else, which is how a session starts. */
export function createLoadout(): LoadoutState {
  return {
    slots: [{ id: DEFAULT_WEAPON, loaded: 0 }],
    current: 0,
    ammo: emptyAmmo(),
    firedTick: -1,
    reloadTick: -1,
    recoil: 0,
    aiming: false,
    shots: 0,
    held: { fire: false, reload: false, cycle: false },
  };
}

/** The slot in the player's hands. */
export function currentSlot(loadout: LoadoutState): WeaponSlot {
  const slot = loadout.slots[loadout.current] ?? (loadout.slots[0] as WeaponSlot);
  return slot;
}

/** The weapon in the player's hands. */
export function currentWeapon(loadout: LoadoutState): WeaponSpec {
  return weaponOf(currentSlot(loadout).id);
}

/** The pool a weapon draws on. A melee weapon needs none, so it has none. */
export function poolOf(loadout: LoadoutState, spec: WeaponSpec): number {
  return spec.calibre === undefined ? 0 : loadout.ammo[spec.calibre];
}

/**
 * Put rounds into a calibre's pool, up to what a player can carry. Answers how
 * many went in, so a pickup can say what was left behind.
 */
export function addAmmo(loadout: LoadoutState, calibre: Calibre, rounds: number): number {
  const room = AMMO_CAP[calibre] - loadout.ammo[calibre];
  const taken = Math.max(0, Math.min(room, Math.floor(rounds)));
  loadout.ammo[calibre] += taken;
  return taken;
}

/**
 * Give the player a weapon and select it. A weapon picked up comes loaded, with
 * {@link SPARE_MAGAZINES} magazines behind it; one they already carry only
 * brings the ammunition. This is what a weapon shop, a dropped weapon and the
 * debug picker all come to.
 */
export function giveWeapon(loadout: LoadoutState, id: WeaponId, spare = SPARE_MAGAZINES): void {
  const spec = weaponOf(id);
  let index = loadout.slots.findIndex((slot) => slot.id === id);
  if (index < 0) {
    loadout.slots.push({ id, loaded: spec.capacity });
    index = loadout.slots.length - 1;
  }
  if (spec.calibre !== undefined) addAmmo(loadout, spec.calibre, spec.capacity * spare);
  select(loadout, index);
}

/** Put a weapon the player carries into their hands. Answers false where they do not carry it. */
export function selectWeapon(loadout: LoadoutState, id: WeaponId): boolean {
  const index = loadout.slots.findIndex((slot) => slot.id === id);
  if (index < 0) return false;
  select(loadout, index);
  return true;
}

/** Walk the carried weapons by `step`, wrapping round in both directions. */
export function cycleWeapon(loadout: LoadoutState, step: number): void {
  const count = loadout.slots.length;
  const next = (((loadout.current + step) % count) + count) % count;
  select(loadout, next);
}

/**
 * Take a slot into the hands. A weapon swapped for another drops the reload
 * that was running and the recoil that was standing with it: what is in the
 * hands now is a fresh weapon.
 */
function select(loadout: LoadoutState, index: number): void {
  loadout.current = index;
  loadout.reloadTick = -1;
  loadout.firedTick = -1;
  loadout.recoil = 0;
}

/** True while a reload is running. */
export function reloading(loadout: LoadoutState): boolean {
  return loadout.reloadTick >= 0;
}

/**
 * Start a reload. It takes the weapon's own time, and it is refused where there
 * is nothing to reload: a full magazine, an empty pool, a melee weapon, or a
 * reload already running.
 */
export function beginReload(loadout: LoadoutState, tick: number): boolean {
  if (reloading(loadout)) return false;
  const slot = currentSlot(loadout);
  const spec = weaponOf(slot.id);
  if (spec.capacity === 0 || spec.calibre === undefined) return false;
  if (slot.loaded >= spec.capacity) return false;
  if (loadout.ammo[spec.calibre] <= 0) return false;
  loadout.reloadTick = tick + spec.reloadTicks;
  return true;
}

/**
 * Finish a reload that has come due: the pool fills the magazine, as far as the
 * pool goes. This is the one place rounds move from the calibre to the weapon.
 */
export function finishReload(loadout: LoadoutState, tick: number): void {
  if (!reloading(loadout) || tick < loadout.reloadTick) return;
  loadout.reloadTick = -1;
  const slot = currentSlot(loadout);
  const spec = weaponOf(slot.id);
  if (spec.calibre === undefined) return;
  const taken = Math.min(spec.capacity - slot.loaded, loadout.ammo[spec.calibre]);
  slot.loaded += taken;
  loadout.ammo[spec.calibre] -= taken;
}
