/**
 * The developer free camera. It is a tool, not a view of the game.
 *
 * It flies anywhere on the map while the simulation carries on behind it, so a
 * layout, a junction or a tower can be looked at from any side without driving
 * there. The game camera of spec section 10.7 is untouched: `camera.ts` is
 * still what the game is played through, and this writes into the same
 * `PerspectiveCamera` while it is detached. One camera object means the post
 * chain, the water's mirror and the sun's cascades follow it with no change of
 * their own.
 *
 * Nothing here is simulation state. `src/sim` does not know this exists and a
 * save carries no trace of it. `docs/dev-tooling.md` holds the keys.
 */
import type { PerspectiveCamera } from 'three';

/** Metres a second the camera flies at before the wheel or `Shift` changes it. */
export const FREE_SPEED = 40;

/** The slowest and fastest the wheel may set, in metres a second. */
export const MIN_SPEED = 2;
export const MAX_SPEED = 600;

/** What one notch of the wheel multiplies the speed by. */
export const SPEED_STEP = 1.2;

/** What `Shift` multiplies it by, which is how the map is crossed. */
export const FAST_MULTIPLIER = 6;

/** Radians the view turns per pixel the mouse moves under pointer lock. */
export const LOOK_PER_PIXEL = 0.0025;

/**
 * How far from the horizon the view may pitch. Short of a quarter turn, so the
 * camera never looks straight down and loses which way is forward.
 */
export const MAX_PITCH = (89 * Math.PI) / 180;

/**
 * Where a survey flight starts: metres over the ground it was let go at, and
 * how far below the horizon it looks from there.
 *
 * It is what a phone opens the world on (`ui/touch-fly.ts`). High enough that a
 * district reads as a district rather than as the street the player stood in,
 * and tipped far enough down that the ground fills the frame rather than the
 * sky.
 */
export const SURVEY_HEIGHT = 220;
export const SURVEY_PITCH = (-35 * Math.PI) / 180;

/** The keys, as the camera reads them. `ui/free-camera.ts` samples them. */
export interface FreeCameraInput {
  /** -1..1 along the view direction. */
  forward: number;
  /** -1..1 across it. */
  right: number;
  /** -1..1 up the world's own axis. */
  up: number;
  /** Held for {@link FAST_MULTIPLIER} times the speed. */
  fast: boolean;
}

export const EMPTY_FREE_INPUT: Readonly<FreeCameraInput> = Object.freeze({
  forward: 0,
  right: 0,
  up: 0,
  fast: false,
});

/**
 * Where the free camera stands and where it looks. Pure: it is stepped with a
 * render delta and written onto a camera, so the policy is tested headless.
 */
export class FreeCamera {
  /** Scene coordinates: `x` and `z` are the map's `x` and `y`, `y` is height. */
  x = 0;
  y = 0;
  z = 0;
  /** Radians about the world's up axis. */
  yaw = 0;
  /** Radians above the horizon, negative looking down. */
  pitch = 0;
  /** Metres a second, before `Shift`. */
  speed = FREE_SPEED;

  /**
   * Stand where a camera stands and look where it looks. The rotation is read
   * as `YXZ`, which is the order `camera.ts` writes.
   */
  from(camera: PerspectiveCamera): void {
    this.x = camera.position.x;
    this.y = camera.position.y;
    this.z = camera.position.z;
    this.pitch = clampPitch(camera.rotation.x);
    this.yaw = camera.rotation.y;
  }

  /**
   * Rise to {@link SURVEY_HEIGHT} over the ground at `groundHeight` and tip the
   * view down at it. Where it stands on the map and which way it faces are
   * left alone, so the flight opens on the city the session started in.
   */
  survey(groundHeight: number): void {
    this.y = groundHeight + SURVEY_HEIGHT;
    this.pitch = SURVEY_PITCH;
  }

  /**
   * The way the camera looks across the ground, as a map heading: forward is
   * `(cos h, sin h)` in map `(x, y)`, which is scene `(x, z)`. The minimap
   * turns by this while the camera flies, so its arrow shows the view.
   */
  get heading(): number {
    return Math.atan2(-Math.cos(this.yaw), -Math.sin(this.yaw));
  }

  /** Turn by a mouse movement in pixels, as pointer lock reports it. */
  look(dx: number, dy: number): void {
    this.yaw -= dx * LOOK_PER_PIXEL;
    this.pitch = clampPitch(this.pitch - dy * LOOK_PER_PIXEL);
  }

  /** Set the speed by a number of wheel notches. Up is faster. */
  scaleSpeed(notches: number): void {
    const wanted = this.speed * Math.pow(SPEED_STEP, notches);
    this.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, wanted));
  }

  /**
   * Fly for `dt` seconds of render time. `forward` and `right` move across the
   * camera's own plane, so the view direction is what `W` follows; `up` is the
   * world's own axis, so `R` and `F` rise and fall whatever the pitch.
   */
  update(dt: number, input: FreeCameraInput): void {
    const metres = this.speed * (input.fast ? FAST_MULTIPLIER : 1) * dt;
    const cos = Math.cos(this.pitch);
    // The view direction, as `YXZ` leaves it: the camera looks down local -z.
    const fx = -Math.sin(this.yaw) * cos;
    const fy = Math.sin(this.pitch);
    const fz = -Math.cos(this.yaw) * cos;
    // Across it, level with the ground.
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    this.x += (fx * input.forward + rx * input.right) * metres;
    this.y += (fy * input.forward + input.up) * metres;
    this.z += (fz * input.forward + rz * input.right) * metres;
  }

  /** Put the camera where this stands. Called once a frame while detached. */
  writeTo(camera: PerspectiveCamera): void {
    camera.position.set(this.x, this.y, this.z);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}

function clampPitch(radians: number): number {
  return Math.min(MAX_PITCH, Math.max(-MAX_PITCH, radians));
}
