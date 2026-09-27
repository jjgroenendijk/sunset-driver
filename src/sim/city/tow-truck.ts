/**
 * The tow truck (spec section 20.2): the third kind of unit the city sends out,
 * beside the engines and the ambulances of `emergency.ts`.
 *
 * `traffic/tow.ts` calls one to a vehicle that has to go: a wreck that has
 * burnt out, or a car left where it should not be. The truck is dispatched and
 * routed like any other unit. When it pulls up, it hooks the vehicle: the
 * record leaves `TrafficState.promoted` and rides on the truck as its
 * {@link TowLoad}. The truck then winches it from where it stood up onto its
 * deck, and drives it away when the work is done. The load goes with the truck
 * when it is taken off the map.
 *
 * A vehicle that has gone by the time the truck arrives — taken by the player,
 * put back on its tour, or dropped out of sight — leaves nothing to hook, and
 * the truck drives off empty.
 *
 * The lift is a pure function of the tick and the load, so nothing is stepped
 * here but the hook itself. `render/vehicles/traffic.ts` draws the load where
 * {@link loadPose} puts it, with the paint it had.
 */
import { cos, sin } from '../../core/libm.ts';
import { TICK_RATE } from '../clock.ts';
import type { SimState } from '../simulation.ts';
import { promotedOf } from '../traffic/traffic.ts';
import { rideHeight, specOf, type VehicleClass } from '../vehicles/vehicle.ts';
import type { EmergencyUnit } from './emergency.ts';

/** A vehicle on a tow truck: what it is, and where it stood when the truck hooked it. */
export interface TowLoad {
  /** The id it was promoted under, so the truck that took it is known. */
  id: number;
  cls: VehicleClass;
  paint: number;
  /** The tick it was hooked on, which the lift is timed from. */
  since: number;
  /** The middle of its body when it was hooked, `y` up, and its turn. */
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** Ticks between the truck pulling up and the winch starting. */
export const WINCH_DELAY = 2 * TICK_RATE;

/** Ticks the winch takes to bring a load up onto the deck. */
export const WINCH_TICKS = 7 * TICK_RATE;

/** Metres over the road the deck of a truck stands at. */
export const DECK_UP = 1.1;

/** Metres along the truck from its middle to the middle of the deck: behind the cab. */
export const DECK_ALONG = -1.1;

/** Metres a load rises over the straight line between where it stood and the deck, halfway up. */
const LIFT_ARC = 1.2;

/**
 * Hook the vehicle a truck was sent for, if it is still there to hook. Its
 * record leaves the traffic and rides on the truck from here on. Answers false
 * where it has gone.
 */
export function hookUp(state: SimState, unit: EmergencyUnit, target: number): boolean {
  const record = target >= 0 ? promotedOf(state.traffic, target) : undefined;
  // A car the player is sitting in, or working the lock of, is theirs.
  if (record === undefined || state.theft?.target === target) return false;
  const v = record.vehicle;
  unit.load = { id: record.id, cls: v.cls, paint: record.paint, since: state.tick, x: v.x, y: v.y, z: v.z, qx: v.qx, qy: v.qy, qz: v.qz, qw: v.qw };
  const promoted = state.traffic.promoted;
  promoted.splice(promoted.indexOf(record), 1);
  return true;
}

/** How far up onto the deck a load is at a tick: 0 where it stood and 1 on the deck. */
export function liftAt(load: TowLoad, tick: number): number {
  const t = Math.min(1, Math.max(0, (tick - load.since - WINCH_DELAY) / WINCH_TICKS));
  return t * t * (3 - 2 * t);
}

/** Where a load is drawn: the middle of its body, `y` up, and its turn as a quaternion. */
export interface LoadPose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** The pose of the load on a truck at a tick, written into `out`. */
export function loadPose(unit: EmergencyUnit, load: TowLoad, tick: number, out: LoadPose): LoadPose {
  const t = liftAt(load, tick);
  const deckX = unit.x + cos(unit.heading) * DECK_ALONG;
  const deckZ = unit.y + sin(unit.heading) * DECK_ALONG;
  const deckY = unit.height + DECK_UP + rideHeight(specOf(load.cls));
  out.x = load.x + (deckX - load.x) * t;
  out.z = load.z + (deckZ - load.z) * t;
  out.y = load.y + (deckY - load.y) * t + LIFT_ARC * 4 * t * (1 - t);
  // The deck's turn is a yaw of minus the heading, as every body of the game is.
  const dqy = sin(-unit.heading / 2);
  const dqw = cos(-unit.heading / 2);
  // The shorter way round, then a normalised straight line between the two.
  const sign = load.qy * dqy + load.qw * dqw < 0 ? -1 : 1;
  const qx = load.qx * (1 - t);
  const qy = load.qy * (1 - t) + sign * dqy * t;
  const qz = load.qz * (1 - t);
  const qw = load.qw * (1 - t) + sign * dqw * t;
  const length = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
  out.qx = qx / length;
  out.qy = qy / length;
  out.qz = qz / length;
  out.qw = qw / length;
  return out;
}
