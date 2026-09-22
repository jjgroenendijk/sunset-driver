/**
 * Getting into a vehicle and out of it, as time that passes (spec sections
 * 11.2, 11.5).
 *
 * A door is not a switch. The player walks to it, takes the handle, opens it,
 * gets in and pulls it shut, and the vehicle is theirs to drive only after
 * that; getting out is the same the other way round. This is the record of one
 * of those moves and how long it takes. The move itself — where each limb is at
 * each moment — is drawn by `src/render/boarding.ts` from the same record, so a
 * replay and a loaded save show the body where it was.
 *
 * While a move runs the player is held: on foot they are walked with nothing
 * pressed, and in the seat the vehicle is held on its brakes. The world goes on
 * around them, as it does around a player working at a lock.
 */
import { cos, hypot, sin } from '../core/libm.ts';
import type { PlayerState } from './on-foot.ts';
import { TICK_RATE } from './clock.ts';
import { headingOf, type VehicleSpec, type VehicleState } from './vehicle.ts';

/** Which way the player is going: into the seat, or out of it. */
export type BoardingWay = 'in' | 'out';

/** One move into or out of the player's vehicle. */
export interface BoardingState {
  way: BoardingWay;
  /** The tick the move began on. */
  start: number;
  /**
   * The side of the vehicle the player goes through, in its own frame: -1 is
   * the driver's side, +1 the other. A player gets in on the side they stand
   * on, and always gets out on the driver's.
   */
  side: number;
  /**
   * Ticks of walking to the door before the hand is on it, at the start of a
   * move in. It is the distance at a walk, so a player at the tail of a bus
   * walks the length of it rather than gliding. A move out has none.
   */
  walk: number;
}

/**
 * Ticks each move takes once the player is at the door, at 60 a second. A
 * car's door has to be opened and shut again, and a bike only has to be
 * swung onto, so a bike is quicker.
 */
export const BOARD_TICKS = { in: 66, out: 60 } as const;
export const MOUNT_TICKS = { in: 22, out: 30 } as const;

/** Metres out from the flank the player stands at to reach a door. */
export const DOOR_STAND = 0.35;

/** Ticks at most spent walking to a door, however far round the vehicle it is. */
export const WALK_CAP = 240;

/** Metres per second a player walks to the door at. */
const WALK_PACE = 2.6;

/**
 * Metres along a vehicle, forward of its middle, the driver's door is at: the
 * place a player stands to get in and is stood at when they get out. A car's
 * front door ends at its middle. A van, a truck and a bus are driven from a cab
 * at the nose, and a boat from the console behind its screen.
 */
export function doorAlong(spec: VehicleSpec): number {
  switch (spec.cls) {
    case 'van':
      return spec.halfLength * 0.52 - 0.45;
    case 'truck':
      return spec.halfLength * 0.74;
    case 'bus':
      return spec.halfLength - 0.9;
    case 'boat':
      return -spec.halfLength * 0.28 - 0.4;
    default:
      return 0;
  }
}

/** Ticks the move takes into or out of a vehicle of this class, the walk to the door included. */
export function boardingTicks(spec: VehicleSpec, boarding: { way: BoardingWay; walk: number }): number {
  const ticks = spec.inline ? MOUNT_TICKS : BOARD_TICKS;
  return ticks[boarding.way] + boarding.walk;
}

/** Start a move out of the seat on `tick`, through the driver's door. */
export function createBoarding(way: BoardingWay, tick: number, side: number, walk = 0): BoardingState {
  return { way, start: tick, side: side < 0 ? -1 : 1, walk };
}

/**
 * Start a move into `v` on `tick`, through the side the player stands on,
 * with the walk from where they stand to the door timed at a walk.
 */
export function startBoarding(player: PlayerState, v: VehicleState, spec: VehicleSpec, tick: number): BoardingState {
  const side = sideOf(player, v);
  const { along, across } = local(player, v);
  const standX = doorAlong(spec) - 0.15;
  const standZ = side * (spec.halfWidth + DOOR_STAND);
  // A player in front of the vehicle or behind it walks out to its side first.
  const round = Math.abs(across) < Math.abs(standZ) ? Math.abs(standZ - across) : 0;
  const metres = round + hypot(standX - along, round > 0 ? 0 : standZ - across);
  const walk = Math.min(WALK_CAP, Math.ceil((metres / WALK_PACE) * TICK_RATE));
  return createBoarding('in', tick, side, walk);
}

/**
 * How far through the move the body is at `tick`, 0 to 1. The tick may fall
 * between two, which is how the frame draws the move between them.
 */
export function boardingProgress(boarding: BoardingState, spec: VehicleSpec, tick: number): number {
  return Math.min(1, Math.max(0, (tick - boarding.start) / boardingTicks(spec, boarding)));
}

/** How much of the move is the walk to the door, 0 to 1. */
export function walkShare(boarding: BoardingState, spec: VehicleSpec): number {
  return boarding.walk / boardingTicks(spec, boarding);
}

/** True on the tick the move is over and the player is in the seat, or on their feet. */
export function boardingDone(boarding: BoardingState, spec: VehicleSpec, tick: number): boolean {
  return tick - boarding.start >= boardingTicks(spec, boarding);
}

/** Where a player stands in a vehicle's own frame: metres forward of its middle, and across it. */
function local(player: PlayerState, v: VehicleState): { along: number; across: number } {
  const heading = headingOf(v);
  const dx = player.x - v.x;
  const dy = player.y - v.z;
  return { along: dx * cos(heading) + dy * sin(heading), across: -dx * sin(heading) + dy * cos(heading) };
}

/**
 * The side of a vehicle a player stands on, in its own frame: -1 on the
 * driver's side and +1 on the other. It is the sign of the across measure
 * `vehicleGap` in `on-foot.ts` takes, so a player at the nose goes to the side
 * they are nearer.
 */
export function sideOf(player: PlayerState, v: VehicleState): number {
  return local(player, v).across > 0 ? 1 : -1;
}
