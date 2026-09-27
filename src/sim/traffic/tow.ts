/**
 * The wrecks the city clears away (spec section 20.2).
 *
 * Every vehicle the player has touched stays in the record
 * (`TrafficState.promoted`) until something takes it out, because from the
 * moment it is touched the physics owns it. A session spent crashing into
 * traffic would leave a trail of burnt-out shells behind it, and the list
 * would only ever grow.
 *
 * The city tows them. A shell that has stood {@link TOW_WAIT} ticks since it
 * went up draws a tow truck (`city/tow-truck.ts`), which drives to it over the
 * road graph, winches it onto its deck and takes it away while the player
 * watches.
 *
 * Out of sight nobody needs to watch. A shell that is due and lies
 * {@link TOW_REACH} metres or more from the player is simply taken, and its
 * record dropped. A car of the city that was only bumped, and is not on fire,
 * goes as soon as the player is that far from it: its tour drives it again, or
 * its bay stands it at the kerb again. Near the player such a car drives on by
 * itself (`rejoin.ts`). The player's own car, left where they took another
 * (`left`), is never taken out of sight: a car the player abandoned in one
 * piece is still there when they come back, which is what spec section 20.2
 * asks for.
 *
 * A parked car is promoted under `PARKED_ID` plus its bay, and its bay stays
 * empty while its record lasts, so towing a burnt-out parked car also gives
 * the bay back to `parked.ts`. That is the right outcome: the wreck went with
 * the truck and the kerb is free again.
 */
import { hypot } from '../../core/libm.ts';
import { TICKS_PER_HOUR } from '../clock.ts';
import type { SimState } from '../simulation.ts';
import { isFlammable } from '../vehicles/damage.ts';
import type { PromotedVehicle } from './traffic.ts';
import { callTow } from '../city/emergency.ts';

/** Ticks a wreck is left where it stopped before the city sends for it: half an hour of game time. */
export const TOW_WAIT = TICKS_PER_HOUR / 2;

/**
 * Metres the player has to be from a wreck before it can be taken without a
 * truck. Wider than `TRAFFIC_VIEW` of `src/render/vehicles/traffic.ts`, which
 * is how far the traffic is drawn, so nothing vanishes while it is on the
 * screen: what the player can see goes on a truck.
 */
export const TOW_REACH = 240;

/**
 * Take away every wreck the city has had long enough and the player has left
 * far enough behind, and send a truck for the ones they have not. Returns how
 * many were taken, which is nothing on almost every tick.
 */
export function stepTowing(state: SimState): number {
  const promoted = state.traffic.promoted;
  if (promoted.length === 0) return 0;
  const p = state.player;
  const x = p.driving ? state.vehicle.x : p.x;
  const y = p.driving ? state.vehicle.z : p.y;
  let taken = 0;
  // Backwards, so a removal does not skip the record after it.
  for (let i = promoted.length - 1; i >= 0; i--) {
    const record = promoted[i] as PromotedVehicle;
    if (towable(record, state.tick, x, y)) {
      promoted.splice(i, 1);
      taken++;
    } else if (burntOut(record, state.tick)) {
      callTow(state, record.id, record.vehicle.x, record.vehicle.z);
    }
  }
  return taken;
}

/** True when the truck may take a record at this tick, with the player at `(x, y)`. */
function towable(record: PromotedVehicle, tick: number, x: number, y: number): boolean {
  const v = record.vehicle;
  const damage = v.damage;
  if (hypot(v.x - x, v.z - y) < TOW_REACH) return false;
  if (isFlammable(damage)) return record.left !== true;
  return burntOut(record, tick);
}

/** True for a shell that has stood {@link TOW_WAIT} ticks since it went up. */
function burntOut(record: PromotedVehicle, tick: number): boolean {
  const damage = record.vehicle.damage;
  return damage.stage === 'burnt' && damage.blownTick >= 0 && tick - damage.blownTick >= TOW_WAIT;
}
