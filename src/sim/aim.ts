/**
 * Where the player aims (spec section 11.5): the pointer on the map, pulled
 * onto a target standing near it.
 *
 * The input frame carries the point the pointer stands on, so a replay aims
 * where the player aimed. The pull is worked out here from the record, so it
 * is the same pull on every machine. A player with no pointer — a keyboard
 * alone, or a touch screen — aims the way they face, as before.
 */
import { atan2, hypot } from '../core/libm.ts';
import type { InputFrame } from './input.ts';
import type { SimState } from './simulation.ts';

/** Metres from the pointer a target is pulled in from, from the hip and aimed. */
export const SNAP_RADIUS = 2;
export const SNAP_RADIUS_AIMED = 3;

/**
 * Ticks after a shot the player keeps facing the aim. A player who fires and
 * then walks away turns back to the way they walk once this runs out.
 */
export const FACE_TICKS = 45;

/** Radians per second a player on foot turns toward the aim. Quick, not instant. */
export const AIM_TURN_RATE = 5 * Math.PI;

/** Metres a pointer must stand off the player for its direction to mean anything. */
const DEAD_ZONE = 0.4;

/** An aim point on the map, and whether it was pulled onto a target. */
export interface AimPoint {
  x: number;
  y: number;
  snapped: boolean;
}

/**
 * The point the player aims at, or undefined where there is no pointer.
 *
 * The pointer is pulled onto the nearest target inside the snap radius: an
 * enforcer, a police unit or a car that has left its tour. The crowd is not a
 * target — it walks loops outside the record — and nor is the player's own
 * vehicle.
 */
export function aimPoint(state: SimState, input: InputFrame): AimPoint | undefined {
  if (!input.pointing) return undefined;
  const px = input.pointX;
  const py = input.pointY;
  const me = state.player;
  let best = input.aim ? SNAP_RADIUS_AIMED : SNAP_RADIUS;
  let x = px;
  let y = py;
  let snapped = false;
  const consider = (tx: number, ty: number): void => {
    const off = hypot(tx - px, ty - py);
    if (off >= best || hypot(tx - me.x, ty - me.y) < DEAD_ZONE) return;
    best = off;
    x = tx;
    y = ty;
    snapped = true;
  };
  for (const unit of state.enforcers.units) if (unit.health > 0) consider(unit.x, unit.y);
  for (const unit of state.police.units) if (unit.health > 0) consider(unit.x, unit.y);
  for (const car of state.traffic.promoted) consider(car.vehicle.x, car.vehicle.z);
  return { x, y, snapped };
}

/**
 * The direction the player aims in, in the map's radians, or undefined where
 * there is no pointer or it stands on the player.
 */
export function aimYaw(state: SimState, input: InputFrame): number | undefined {
  const point = aimPoint(state, input);
  if (point === undefined) return undefined;
  const dx = point.x - state.player.x;
  const dy = point.y - state.player.y;
  if (hypot(dx, dy) < DEAD_ZONE) return undefined;
  return atan2(dy, dx);
}

/**
 * True while a player on foot should face the aim rather than the way they
 * walk: while they hold the aim, and for a moment after each shot.
 */
export function facesAim(state: SimState, input: InputFrame): boolean {
  if (input.aim || input.fire) return true;
  const fired = state.loadout.firedTick;
  return fired >= 0 && state.tick - fired < FACE_TICKS;
}
