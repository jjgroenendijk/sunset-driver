/**
 * Death, arrest and respawn (spec section 11.7).
 *
 * A run ends in one of two ways. A player whose health reaches 0 dies, and
 * comes back at the active safehouse without their weapons, a hospital fee
 * poorer. A player the police take in is arrested, and comes back at the
 * nearest police station without their weapons or contraband, a bribe poorer.
 * Death wins when both happen on one tick.
 *
 * The rules here only change the record. `stepSim` resolves them at the end of
 * the tick, after the physics has written it, and asks the physics to stand the
 * player at the place they come back to. Nothing is random and nothing reads a
 * clock, so a run that ends on the same tick of the same stream comes back the
 * same.
 *
 * The safehouse stash and garage are never touched (spec section 11.7). The
 * safehouses of spec section 16.3 have not landed, so `SimState.safehouse` is
 * a placeholder: where the session started. The inventory of spec section 16.2
 * has not landed either, so an arrest has no contraband to take yet.
 */
import { MAX_HEALTH, type Place } from './on-foot.ts';
import type { SimState } from './simulation.ts';
import { createLoadout } from './weapon.ts';

/** Dollars a death costs at the hospital. */
export const HOSPITAL_FEE = 200;

/** Dollars an arrest costs in bribes. */
export const ARREST_BRIBE = 400;

/** How a run ended. */
export type Fate = 'death' | 'arrest';

/** The last respawn: how the run ended and the tick it ended on. */
export interface RespawnRecord {
  cause: Fate;
  tick: number;
  /** Dollars it took, which is less than the fee when the player could not pay all of it. */
  cost: number;
}

/** How the run ends this tick, or null while it goes on. */
export function fateOf(state: SimState): Fate | null {
  if (state.player.health <= 0) return 'death';
  if (state.arrested) return 'arrest';
  return null;
}

/**
 * The station nearest a place, or undefined where the world has none. Stations
 * at the same distance go to the one listed first, so the answer does not
 * depend on anything but the list.
 */
export function nearestStation(stations: readonly Place[], x: number, y: number): Place | undefined {
  let best: Place | undefined;
  let bestDistance = Infinity;
  for (const station of stations) {
    const distance = Math.hypot(station.x - x, station.y - y);
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = station;
  }
  return best;
}

/**
 * Where a player comes back after a fate. An arrest in a world with no police
 * station comes back at the safehouse, because a player has to come back
 * somewhere.
 */
export function respawnPlace(state: SimState, fate: Fate, stations: readonly Place[]): Place {
  const station = fate === 'arrest' ? nearestStation(stations, state.player.x, state.player.y) : undefined;
  return station ?? state.safehouse;
}

/**
 * End the run in the record and put the player at `place`, on foot and at full
 * health. The vehicle they were in stays where it was.
 *
 * The weapons go, with their attachments and their rounds. `shots` is kept,
 * because it keys the random stream of every shot, and a shot after a respawn
 * must not repeat a shot before it. The fee takes what the player has and no more. Heat is
 * cleared: the police have what they wanted, or the player is gone.
 */
export function respawn(state: SimState, fate: Fate, place: Place): void {
  const p = state.player;
  p.x = place.x;
  p.y = place.y;
  p.heading = place.heading;
  p.speed = 0;
  p.vy = 0;
  p.grounded = false;
  p.driving = false;
  p.health = MAX_HEALTH;
  const shots = state.loadout.shots;
  state.loadout = createLoadout();
  state.loadout.shots = shots;
  const cost = Math.min(Math.max(0, state.money), fate === 'death' ? HOSPITAL_FEE : ARREST_BRIBE);
  state.money -= cost;
  state.heat = 0;
  state.theft = null;
  // Whatever they were doing is over: a lock half picked, and a shop they were
  // standing in (spec section 16.1), which is nowhere near where they come back.
  state.shop = null;
  state.arrested = false;
  state.respawn = { cause: fate, tick: state.tick, cost };
}
