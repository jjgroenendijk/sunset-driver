/**
 * What one round does to a vehicle and to the local player, as plain functions
 * of the record.
 *
 * `gunfire.ts` puts every round it casts into a vehicle through
 * {@link roundInto}. A round another player of a room fired into this player
 * arrives over the network instead (spec section 21.5), and
 * {@link takeRound} applies it the same way: each peer has the final word on
 * its own health and its own vehicle (spec section 21.4), so nobody else
 * writes either.
 */
import { hurt } from '../player/on-foot.ts';
import type { SimState } from '../simulation.ts';
import { damageVehicle, disableEngine, ignite } from '../vehicles/damage.ts';
import { unrotate } from '../vehicles/frame.ts';
import type { VehicleState } from '../vehicles/vehicle.ts';
import { roundSeverity, weaponOf, type WeaponId, type WeaponSpec } from './weapon.ts';

/** Scratch for the direction in the vehicle's own axes, so a hit allocates nothing. */
const LOCAL = { x: 0, y: 0, z: 0 };

/**
 * Put one hit into a vehicle: the dent, what it costs the vehicle, and what
 * the round does beyond that. The direction comes in world axes and is read in
 * the vehicle's own frame, so the panel that takes it is the panel that was
 * facing the shot.
 */
export function roundInto(
  state: SimState,
  spec: WeaponSpec,
  v: VehicleState,
  dx: number,
  dh: number,
  dy: number,
  severity: number,
): void {
  unrotate(LOCAL, v, dx, dh, dy);
  // `unrotate` answers the vehicle's own axes: `x` along it, `y` up and `z`
  // across it, which is the order the panel rule reads them in.
  damageVehicle(v.damage, severity, LOCAL.x, LOCAL.z, LOCAL.y, state.seed, state.tick, state.loadout.shots);
  if (spec.effect === 'fire') ignite(v.damage, state.tick);
  if (spec.effect === 'engine') disableEngine(v.damage);
}

/**
 * A round another player fired into this one. `part` is what it went into on
 * the shooter's screen. A round into the car dents the car. A round into the
 * player on foot hurts them, unless they have got into the car since, in which
 * case the car takes it.
 */
export function takeRound(
  state: SimState,
  weapon: WeaponId,
  part: 'person' | 'vehicle',
  dx: number,
  dh: number,
  dy: number,
): void {
  const spec = weaponOf(weapon);
  if (part === 'person' && !state.player.driving) {
    hurt(state.player, spec.damage);
    return;
  }
  roundInto(state, spec, state.vehicle, dx, dh, dy, roundSeverity(spec));
}
