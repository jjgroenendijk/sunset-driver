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
 * The safehouse stash and garage are never touched (spec section 11.7). They
 * are a store of their own (`safehouse.ts`), so nothing here can reach them:
 * what an arrest takes is the contraband in the player's hands, and the drive
 * home is what puts a run's takings out of its reach.
 *
 * A player who owns no safehouse comes back at `SimState.origin`, which is
 * where the session started. There is nowhere else to put them.
 */
import { hypot } from '../../core/libm.ts';
import { MAX_HEALTH, type Place } from './on-foot.ts';
import { standDownAll } from '../police/police.ts';
import { activeHome, type SafehousePlace } from '../places/safehouse.ts';
import type { SimState } from '../simulation.ts';
import { createLoadout } from '../weapons/weapon.ts';

/** Dollars a death costs at the hospital. */
export const HOSPITAL_FEE = 200;

/** Dollars an arrest costs in bribes. */
export const ARREST_BRIBE = 400;

/** Dollars an arrest costs a player who gave themselves up (spec section 14): less, which is why they did. */
export const SURRENDER_BRIBE = 150;

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
    const distance = hypot(station.x - x, station.y - y);
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = station;
  }
  return best;
}

/**
 * Where a player comes back after a fate: their active safehouse after a death,
 * and the nearest police station after an arrest (spec section 11.7). An arrest
 * in a world with no police station falls back on the safehouse, and a player
 * who owns none falls back on where the session started, because a player has
 * to come back somewhere.
 */
export function respawnPlace(
  state: SimState,
  fate: Fate,
  stations: readonly Place[],
  homes: readonly SafehousePlace[] = [],
): Place {
  const station = fate === 'arrest' ? nearestStation(stations, state.player.x, state.player.y) : undefined;
  return station ?? activeHome(state, homes) ?? state.origin;
}

/**
 * End the run in the record and put the player at `place`, on foot and at full
 * health. The vehicle they were in stays where it was.
 *
 * The weapons go, with their attachments and their rounds. `shots` is kept,
 * because it keys the random stream of every shot, and a shot after a respawn
 * must not repeat a shot before it. An arrest takes the contraband in the
 * player's hands as well (spec section 11.7); a death leaves it, because a
 * hospital is not an evidence room. The fee takes what the player has and no
 * more. Heat is cleared: the police have what they wanted, or the player is
 * gone.
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
  if (fate === 'arrest') {
    for (let good = 0; good < state.market.stash.length; good++) {
      state.market.stash[good] = 0;
      state.market.paid[good] = 0;
    }
  }
  const bribe = state.police.surrendered ? SURRENDER_BRIBE : ARREST_BRIBE;
  const cost = Math.min(Math.max(0, state.money), fate === 'death' ? HOSPITAL_FEE : bribe);
  state.money -= cost;
  state.heat = 0;
  // The chase is over with the heat: the units that ran it go home, so the
  // next small crime brings out what it is worth and not the force a
  // six-star chase left standing round the station.
  standDownAll(state);
  state.theft = null;
  state.boarding = null;
  // Whatever they were doing is over: a lock half picked, a shop they were
  // standing in, a deal open on a corner (spec sections 16.1, 16.2) and a front
  // door they had open (spec section 16.3). None of them is anywhere near where
  // they come back.
  state.shop = null;
  state.market.deal = null;
  state.property.visit = null;
  state.arrested = false;
  state.respawn = { cause: fate, tick: state.tick, cost };
}
