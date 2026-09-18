/**
 * Taking a vehicle of the traffic (spec sections 5.3, 11.4).
 *
 * A vehicle the player has touched is promoted: its record sits in
 * `TrafficState.promoted` and the physics owns it. This is the rule for getting
 * into one, and the swap that makes it the player's vehicle. Nothing here
 * touches Rapier; `physics.ts` opens the door and rebuilds the bodies.
 *
 * The record holds one vehicle of the player's, `state.vehicle`. So a theft is
 * a swap: the stolen vehicle becomes the player's, and the one they leave
 * behind takes its place in the promoted list, under the same id. The id stays
 * promoted, so the tour of the vehicle that was taken is not driven again by a
 * second copy of it, and the car left at the kerb is a car of the city like any
 * other: it can be shot, burned, towed or taken back.
 */
import { EXIT_SPEED, ENTER_REACH, vehicleGap, type PlayerState } from './on-foot.ts';
import type { SimState } from './simulation.ts';
import { promotedOf, type PromotedVehicle } from './traffic.ts';
import { specOf } from './vehicle.ts';

/**
 * The promoted vehicle nearest a player on foot that they can get into, or
 * undefined where none is in reach. A wreck that has burned out is not a
 * vehicle any more, and a door is only opened at a crawl. A tie goes to the
 * lower id, so the answer does not depend on anything but the record.
 */
export function reachablePromoted(state: SimState, player: PlayerState): PromotedVehicle | undefined {
  let best: PromotedVehicle | undefined;
  let closest = Infinity;
  for (const record of state.traffic.promoted) {
    const v = record.vehicle;
    if (v.damage.stage === 'burnt' || Math.abs(v.speed) > EXIT_SPEED) continue;
    const gap = vehicleGap(player, v, specOf(v.cls));
    if (gap > ENTER_REACH || gap >= closest) continue;
    closest = gap;
    best = record;
  }
  return best;
}

/**
 * Make the promoted vehicle under `id` the player's, and leave the player's own
 * in its place. The paint moves with each vehicle: a promoted record carries
 * the colour the city painted it, and the player's vehicle carries its own.
 */
export function swapInto(state: SimState, id: number): void {
  const record = promotedOf(state.traffic, id);
  if (record === undefined) return;
  const stolen = record.vehicle;
  stolen.paint = record.paint;
  record.vehicle = state.vehicle;
  record.paint = state.vehicle.paint;
  state.vehicle = stolen;
}
