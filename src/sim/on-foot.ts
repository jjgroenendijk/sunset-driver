/**
 * The player out of the car (spec sections 11.2, 11.5).
 *
 * This holds three things and nothing else: the record of a player on foot, the
 * numbers a person is made of, and the pure rules for getting in and out of a
 * vehicle. `physics.ts` turns them into a Rapier capsule and a kinematic
 * character controller; nothing here touches Rapier, so the rules can be read
 * and tested headless.
 *
 * The player walks in the map's own axes, because the camera never turns (spec
 * section 10.7): the forward key walks up the screen whatever the player faces.
 * Heading is the way they face, and it follows the way they walk.
 */
import { type CharacterAppearance, resolveAppearance } from './character.ts';
import { headingOf, type VehicleSpec, type VehicleState } from './vehicle.ts';

/** Metres per second at a walk, and at a sprint. */
export const WALK_SPEED = 2.6;
export const SPRINT_SPEED = 5.6;

/** Radians per second the player turns toward the way they are walking. */
export const TURN_RATE = 12;

/**
 * Metres per second a jump leaves the ground at. Under Earth's gravity that is
 * a jump of about 0.9 m, which clears a kerb and not a wall.
 */
export const JUMP_SPEED = 4.2;

/** Metres per second a fall is capped at, so a long drop stays a number. */
export const TERMINAL_SPEED = 55;

/** Metres of kerb or step the player walks up without jumping. */
export const STEP_HEIGHT = 0.35;

/** Metres of clear ground that must stand beyond a step for it to be taken. */
export const STEP_WIDTH = 0.2;

/** Metres the feet are pulled back down to the ground over, so a slope is walked and not hopped. */
export const SNAP_DISTANCE = 0.3;

/** The gap the controller keeps between the player and everything else, in metres. */
export const SKIN = 0.02;

/** Radians of slope the player can climb, and the slope they slide back down. */
export const MAX_CLIMB = (50 * Math.PI) / 180;
export const MIN_SLIDE = (48 * Math.PI) / 180;

/** Metres clear of a vehicle's body the player can still reach its door from. */
export const ENTER_REACH = 1.6;

/** Metres clear of the body the player stands when they step out of a vehicle. */
export const EXIT_CLEARANCE = 0.5;

/**
 * Metres per second under which a vehicle may be stepped out of. A door is
 * opened at a stop or at a crawl, never at speed.
 */
export const EXIT_SPEED = 2.5;

/** Health at full, and what a player starts a session with. */
export const MAX_HEALTH = 100;

/**
 * What each source of healing is worth (spec section 11.5). Health regenerates
 * through these and through nothing else: there is no passive regeneration and
 * there is no armour.
 */
export type HealSource = 'pickup' | 'food' | 'rest';

export const HEAL_BY_SOURCE: Readonly<Record<HealSource, number>> = Object.freeze({
  pickup: 25,
  food: 40,
  rest: MAX_HEALTH,
});

/** The keys that were down last tick, so a press acts once rather than every tick. */
export interface HeldKeys {
  interact: boolean;
  jump: boolean;
}

/**
 * The player, as saved. Plain numbers: the Rapier capsule is built from this,
 * never stored in it, the same way the vehicle's body is.
 */
export interface PlayerState {
  /** Where they stand on the map, in metres. `y` is the map's `y`, which is world `z`. */
  x: number;
  y: number;
  /** Metres from sea level to their feet, or to the floor of the vehicle they are in. */
  height: number;
  /** Which way they face, in radians, growing toward `+y`. */
  heading: number;
  /** Metres per second over the ground: what the speedometer and the camera read. */
  speed: number;
  /** Metres per second up. Only a player on foot has one; a jump starts it. */
  vy: number;
  /** True while the feet are on the ground rather than in the air. */
  grounded: boolean;
  /** True while the player is in their vehicle (spec section 11.5). */
  driving: boolean;
  /** 0 to {@link MAX_HEALTH}. Death and arrest are spec section 11.7. */
  health: number;
  held: HeldKeys;
}

/** A player in their vehicle at the origin, at full health. */
export function createPlayerState(): PlayerState {
  return {
    x: 0,
    y: 0,
    height: 0,
    heading: 0,
    speed: 0,
    vy: 0,
    grounded: false,
    driving: true,
    health: MAX_HEALTH,
    held: { interact: false, jump: false },
  };
}

/** The capsule a body type stands in: radius and half the height of its straight part. */
export interface Capsule {
  radius: number;
  halfHeight: number;
  /** Metres from the middle of the capsule down to the feet. */
  rise: number;
}

/**
 * The capsule the chosen build stands in (spec section 11.1). A broad build is
 * both wider and taller than a slim one, so the look the player picked is the
 * body the physics gives them.
 */
export function capsuleOf(appearance: CharacterAppearance): Capsule {
  const body = resolveAppearance(appearance).body;
  const radius = body.shoulder * 0.35;
  const halfHeight = Math.max(0.05, body.height / 2 - radius);
  return { radius, halfHeight, rise: radius + halfHeight };
}

/** Metres per second the player walks at, given whether they are sprinting. */
export function paceOf(sprint: boolean): number {
  return sprint ? SPRINT_SPEED : WALK_SPEED;
}

/** Move an angle toward another by at most `step`, the short way round. */
export function turnToward(from: number, to: number, step: number): number {
  let delta = (to - from) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  if (Math.abs(delta) <= step) return to;
  return from + Math.sign(delta) * step;
}

/** A place on the map and the way to face there. */
export interface Place {
  x: number;
  y: number;
  heading: number;
}

/**
 * Metres of clear ground between the player and a vehicle's body, and 0 where
 * they are standing against it. It is measured from the body itself rather than
 * from its middle, so a bus is reached from beside the bus and not from beside
 * its centre. A door, a swing of a bat (spec section 11.6) and anything else
 * that reaches for a vehicle asks this.
 */
export function vehicleGap(player: PlayerState, v: VehicleState, spec: VehicleSpec): number {
  const heading = headingOf(v);
  const dx = player.x - v.x;
  const dy = player.y - v.z;
  const along = dx * Math.cos(heading) + dy * Math.sin(heading);
  const across = -dx * Math.sin(heading) + dy * Math.cos(heading);
  const overLength = Math.max(0, Math.abs(along) - spec.halfLength);
  const overWidth = Math.max(0, Math.abs(across) - spec.halfWidth);
  return Math.hypot(overLength, overWidth);
}

/** True when the player stands close enough to a vehicle to open its door. */
export function reachesVehicle(player: PlayerState, v: VehicleState, spec: VehicleSpec): boolean {
  return vehicleGap(player, v, spec) <= ENTER_REACH;
}

/**
 * Where the player stands when they step out: beside the driver's door, clear
 * of the body, facing the way the vehicle faces. The vehicle's own frame has
 * the axle along local `+z`, so the driver's side is `-z`.
 */
export function exitPlace(v: VehicleState, spec: VehicleSpec): Place {
  const heading = headingOf(v);
  const offset = spec.halfWidth + EXIT_CLEARANCE;
  return { x: v.x + Math.sin(heading) * offset, y: v.z - Math.cos(heading) * offset, heading };
}

/**
 * Where a vehicle put down beside a player on foot stands: on their other side,
 * clear of them, facing the way they face. A vehicle dropped on the player
 * would leave them standing inside its body.
 */
export function besidePlayer(player: PlayerState, spec: VehicleSpec): Place {
  const offset = spec.halfWidth + EXIT_CLEARANCE;
  return {
    x: player.x - Math.sin(player.heading) * offset,
    y: player.y + Math.cos(player.heading) * offset,
    heading: player.heading,
  };
}

/**
 * Heal the player from one of the sources of spec section 11.5. This is the
 * hook the pickups, the shops and the safehouse beds call; nothing heals a
 * player on its own.
 */
export function heal(player: PlayerState, source: HealSource): void {
  player.health = Math.min(MAX_HEALTH, player.health + HEAL_BY_SOURCE[source]);
}

/** Take health off the player. Death and arrest at zero are spec section 11.7. */
export function hurt(player: PlayerState, amount: number): void {
  player.health = Math.max(0, player.health - Math.max(0, amount));
}
