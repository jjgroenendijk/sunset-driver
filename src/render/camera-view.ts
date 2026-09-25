/**
 * The views the game camera of `camera.ts` can take (spec section 10.7), and
 * the turn that looks past a building.
 *
 * Top down is the view the game is played in. Third person stands behind the
 * player and turns with them; first person stands at their eyes. Both are
 * render state like the rest of the camera: nothing in the record reads them.
 */
import type { Vector3 } from 'three';

export type CameraView = 'top-down' | 'third-person' | 'first-person';

/** Each choice of {@link CameraView}, in the order a menu lists them, with what it is called there. */
export const CAMERA_VIEWS: readonly { value: CameraView; label: string }[] = [
  { value: 'top-down', label: 'Top down' },
  { value: 'third-person', label: 'Third person' },
  { value: 'first-person', label: 'First person' },
];

/** The view after `view`, as the view key steps through them. */
export function nextView(view: CameraView): CameraView {
  const at = CAMERA_VIEWS.findIndex((choice) => choice.value === view);
  return (CAMERA_VIEWS[(at + 1) % CAMERA_VIEWS.length] as { value: CameraView }).value;
}

/** Radians below horizontal each chase view looks down at. */
export const THIRD_PITCH = (16 * Math.PI) / 180;
export const FIRST_PITCH = (6 * Math.PI) / 180;
/** First person on foot looks level, as a shooter does: the crosshair is on the horizon. */
export const FIRST_PITCH_ON_FOOT = 0;
/**
 * Degrees of vertical field of view: the game's, and first person's, which is
 * wider, as a shooter's is. Aiming divides it by the weapon's zoom.
 */
export const BASE_FOV = 45;
export const FIRST_FOV = 70;
/** How fast the field of view follows a zoom, in e-foldings a second. */
export const FOV_RATE = 12;
/** Metres behind the player the third-person camera stands, on foot and at the wheel, and per m/s of speed. */
export const THIRD_DISTANCE_ON_FOOT = 5;
export const THIRD_DISTANCE_DRIVING = 9;
export const THIRD_DISTANCE_PER_SPEED = 0.12;
/** Metres over the feet the third-person camera looks at, and the eyes stand, on foot and at the wheel. */
export const LOOK_HEIGHT_ON_FOOT = 1.5;
export const LOOK_HEIGHT_DRIVING = 1.2;
export const EYE_HEIGHT_ON_FOOT = 1.65;
export const EYE_HEIGHT_DRIVING = 1.5;
/**
 * Metres ahead of the middle of the head the eyes stand, on foot and at the
 * wheel. On foot it keeps the inside of the head out of the view; at the wheel
 * it puts the eyes over the bonnet rather than under the roof.
 */
export const EYE_AHEAD_ON_FOOT = 0.25;
export const EYE_AHEAD_DRIVING = 0.9;
/** How fast each chase view turns to the player's heading, in e-foldings a second. */
export const THIRD_TURN_RATE = 3;
export const FIRST_TURN_RATE = 14;
/** Radians the chase views turn per pixel the mouse moves under pointer lock. */
export const LOOK_PER_PIXEL = 0.0025;
/**
 * The pitch the mouse may take each chase view to, in radians below
 * horizontal. Third person stops short of looking up from under the ground.
 */
export const THIRD_PITCH_MIN = (-10 * Math.PI) / 180;
export const FIRST_PITCH_MIN = (-70 * Math.PI) / 180;
export const PITCH_MAX = (70 * Math.PI) / 180;
/**
 * At the wheel the mouse looks aside, and the view goes back behind the car
 * once the mouse has been still this many seconds, at this many e-foldings a
 * second. On foot the mouse steers the view and it stays where it was left.
 */
export const LOOK_HOLD = 1.5;
export const LOOK_RETURN = 2.5;
/** The near plane of the top-down view, and of the chase views, which stand close to what they see. */
export const TOP_NEAR = 1;
export const CHASE_NEAR = 0.1;

/** How fast the top-down camera turns past a building, in e-foldings a second. */
export const TURN_RATE = 1.6;
/** Radians between the headings the turn tries, and how many it tries each way. */
const TURN_STEP = Math.PI / 12;
const TURN_TRIES = 12;
/**
 * Metres between the points the sight line is tested at, and metres over the
 * feet it leaves from. A step under the narrowest building keeps a corner
 * from falling between two points.
 */
const SIGHT_STEP = 1;
const SIGHT_HEIGHT = 1.2;

/** The top of the tallest roof over a ground point, or undefined over open ground. */
export type RoofHeight = (x: number, z: number) => number | undefined;

/**
 * The yaw that stands a camera behind a player facing `heading`. The map's
 * heading 0 faces `+x`, and the camera's yaw 0 looks toward `-z`, so a player
 * facing `-z` is seen from behind at yaw 0.
 */
export function yawBehind(heading: number): number {
  return Math.atan2(-Math.cos(heading), -Math.sin(heading));
}

/** `angle` moved `share` of the short way round toward `goal`. */
export function turnToward(angle: number, goal: number, share: number): number {
  const gap = Math.atan2(Math.sin(goal - angle), Math.cos(goal - angle));
  return angle + gap * share;
}

/** The unit vector from what a camera of this yaw and pitch looks at back to the camera. */
export function backOf(yaw: number, pitch: number, out: Vector3): Vector3 {
  return out.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
}

/**
 * Whether a camera `reach` metres back along `back` from the player at
 * `(x, height, z)` sees them over every roof between. The line leaves from
 * {@link SIGHT_HEIGHT} over the feet, where the body is.
 */
function sees(x: number, height: number, z: number, back: Vector3, reach: number, roofs: RoofHeight): boolean {
  const y0 = height + SIGHT_HEIGHT;
  for (let along = SIGHT_STEP; along <= reach; along += SIGHT_STEP) {
    const top = roofs(x + back.x * along, z + back.z * along);
    if (top !== undefined && top > y0 + back.y * along) return false;
  }
  return true;
}

/**
 * The yaw the top-down camera should turn to so it sees the player past the
 * buildings. The yaw held now is kept while it is clear, so the camera turns
 * only when a roof comes between: it does not swing between two headings that
 * both see, and it does not swing back to north once north sees again. A turn
 * back is a second movement the player did not ask for, and the view they are
 * playing in is the one they have. When the held yaw is blocked, the nearest
 * clear heading either way round is taken. With no clear heading the camera
 * stays, and the cut of `cutaway.ts` does the rest.
 */
export function clearYaw(
  player: { x: number; height: number; y: number },
  held: number,
  pitch: number,
  reach: number,
  roofs: RoofHeight,
  scratch: Vector3,
): number {
  const clear = (yaw: number): boolean =>
    sees(player.x, player.height, player.y, backOf(yaw, pitch, scratch), reach, roofs);
  if (clear(held)) return held;
  for (let i = 1; i <= TURN_TRIES; i++) {
    if (clear(held + i * TURN_STEP)) return held + i * TURN_STEP;
    if (clear(held - i * TURN_STEP)) return held - i * TURN_STEP;
  }
  return held;
}
