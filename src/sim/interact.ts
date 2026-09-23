/**
 * What a press of the interact key would do to a vehicle now (spec sections
 * 11.2, 11.4, 11.5).
 *
 * The HUD reads this to say so before the key is pressed. It asks the same
 * questions `transfer` in `physics.ts` asks, in the same order, and changes
 * nothing, so the prompt on screen is the press the simulation would act on.
 *
 * The places the key opens — a shop door, a front door, a dealer's corner and
 * a contact's corner — say it in their own panels. This is only the vehicle.
 */
import { travelling } from './metro.ts';
import { EXIT_SPEED, reachesVehicle } from './on-foot.ts';
import { fateOf } from './respawn.ts';
import type { SimState } from './simulation.ts';
import { reachablePromoted } from './steal.ts';
import { isLocked } from './theft.ts';
import { specOf, type VehicleClass } from './vehicle.ts';

/** What the key does to a vehicle, in the words the prompt shows. */
export type VehicleAction = 'get in' | 'get on' | 'board' | 'hotwire' | 'get out';

/**
 * The action a press of the interact key would take on a vehicle, or null
 * where it would take none. Nothing is offered while something else holds
 * the key: a lock being worked at, a door half open, a panel, a trip on the
 * metro, an officer's hand or the end of a run.
 */
export function vehicleAction(state: SimState): VehicleAction | null {
  if (busy(state)) return null;
  const p = state.player;
  if (p.driving) return Math.abs(state.vehicle.speed) > EXIT_SPEED ? null : 'get out';
  const own = state.vehicle;
  const ownSpec = specOf(own.cls);
  if (reachesVehicle(p, own, ownSpec)) return isLocked(own, ownSpec) ? 'hotwire' : entry(own.cls);
  const record = reachablePromoted(state, p);
  if (record === undefined) return null;
  const v = record.vehicle;
  return isLocked(v, specOf(v.cls)) ? 'hotwire' : entry(v.cls);
}

/** True while the key belongs to something other than a vehicle door. */
function busy(state: SimState): boolean {
  return (
    state.theft !== null ||
    state.boarding !== null ||
    state.shop !== null ||
    state.property.visit !== null ||
    state.market.deal !== null ||
    state.missions.visit !== null ||
    state.police.cuffs !== null ||
    state.police.surrendered ||
    travelling(state) ||
    fateOf(state) !== null
  );
}

/** The way into a vehicle: onto a saddle, aboard a hull, into a seat. */
function entry(cls: VehicleClass): VehicleAction {
  if (cls === 'motorcycle') return 'get on';
  return cls === 'boat' ? 'board' : 'get in';
}
