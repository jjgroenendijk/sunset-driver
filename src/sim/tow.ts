/**
 * The wrecks the city clears away (spec section 20.2).
 *
 * Every vehicle the player has touched stays in the record for ever
 * (`TrafficState.promoted`), because from the moment it is touched the physics
 * owns it and it can never go back to its tour. A session spent crashing into
 * traffic therefore leaves a trail of burnt-out shells behind it, and the list
 * only ever grows.
 *
 * The city tows them. A shell that has stood {@link TOW_WAIT} ticks since it
 * went up, with the player {@link TOW_REACH} metres away or further, is taken
 * and its record dropped. Only a shell: a car the player abandoned in one
 * piece is still there when they come back, which is what spec section 20.2
 * asks for. A wreck the player is standing over is never taken either, however
 * long it has burnt.
 *
 * The reach is wider than the traffic the renderer draws, so nothing is ever
 * taken in front of the player: a wreck is gone when they return, never gone
 * while they watch. The tow truck itself is not on the road. Driving one to the
 * wreck needs the routing that spec section 20.3 brings for the police, the
 * ambulances and the fire engines, and until that exists this is the parked
 * cars' bargain — the city turns over while nobody is looking at it.
 *
 * A parked car is promoted under `PARKED_ID` plus its bay, and its bay stays
 * empty while its record lasts, so towing a burnt-out parked car also gives
 * the bay back to `parked.ts`. That is the right outcome: the wreck went with
 * the truck and the kerb is free again.
 */
import { TICKS_PER_HOUR } from './clock.ts';
import type { SimState } from './simulation.ts';
import type { PromotedVehicle } from './traffic.ts';

/** Ticks a wreck is left where it stopped before the city takes it: two hours of game time. */
export const TOW_WAIT = 2 * TICKS_PER_HOUR;

/**
 * Metres the player has to be from a wreck before it can be taken. Wider than
 * `TRAFFIC_VIEW` of `src/render/traffic.ts`, which is how far the traffic is
 * drawn, so a wreck never leaves while it is on the screen.
 */
export const TOW_REACH = 240;

/**
 * Take away every wreck the city has had long enough and the player has left
 * far enough behind. Returns how many were taken, which is nothing on almost
 * every tick.
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
    if (!towable(promoted[i] as PromotedVehicle, state.tick, x, y)) continue;
    promoted.splice(i, 1);
    taken++;
  }
  return taken;
}

/** True when a record is a wreck the truck may take at this tick, with the player at `(x, y)`. */
export function towable(record: PromotedVehicle, tick: number, x: number, y: number): boolean {
  const v = record.vehicle;
  const damage = v.damage;
  if (damage.stage !== 'burnt' || damage.blownTick < 0) return false;
  if (tick - damage.blownTick < TOW_WAIT) return false;
  return Math.hypot(v.x - x, v.z - y) >= TOW_REACH;
}
