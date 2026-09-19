import { PerspectiveCamera, Vector3 } from 'three';

/** Locked pitch in radians below horizontal; the camera never rolls or yaws. */
export const CAMERA_PITCH = (58 * Math.PI) / 180;
export const CAMERA_HEADING = 0;
export const BASE_DISTANCE = 36;
const DISTANCE_PER_SPEED = 0.9;
const LEAD_PER_SPEED = 0.6;
/** How fast the focus catches the target, in e-foldings a second. */
const FOLLOW_RATE = 4;
/**
 * How fast the distance catches the one the speed asks for, in e-foldings a
 * second. Slower than the focus: a pull-back that follows the speed at once
 * jumps the view when a car pulls away.
 */
const ZOOM_RATE = 1.2;

/**
 * Metres the camera keeps over a roof when it pulls back over one, and metres
 * every footprint is grown by when the camera asks which roof it is over. A
 * roof just under the lens fills the view, so both are wider than the lens needs.
 */
const ROOF_CLEARANCE = 10;
export const PULL_MARGIN = 6;
/** How fast the camera climbs over a roof, and how fast it comes down again, in e-foldings a second. */
const CLIMB_RATE = 6;
const SETTLE_RATE = 1.5;
/** The most metres the camera pulls back over roofs, and the most steps it takes to find them. */
const MAX_PULL = 400;
const PULL_STEPS = 12;

/** The top of the tallest roof over a ground point, or undefined over open ground. */
export type RoofHeight = (x: number, z: number) => number | undefined;

/**
 * Fixed tilted top-down camera. Pitch and heading are constants; only the
 * position moves. It leads the target in its direction of travel and pulls
 * back as speed rises.
 */
export class FollowCamera {
  readonly camera: PerspectiveCamera;
  private readonly focus = new Vector3();
  private initialised = false;
  private baseDistance = BASE_DISTANCE;
  /** Metres the camera stands back for speed, on top of the base distance. */
  private zoom = 0;
  /** Metres the camera stands back over roofs, on top of its distance (spec section 10.7). */
  private pull = 0;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(45, aspect, 1, 2000);
    this.applyOrientation();
  }

  private applyOrientation(): void {
    this.camera.rotation.set(-CAMERA_PITCH, CAMERA_HEADING, 0, 'YXZ');
  }

  /** How far back the camera sits at rest. The title screen pulls in close. */
  setBaseDistance(distance: number): void {
    this.baseDistance = distance;
  }

  /**
   * Forget where the camera was looking, so the next update puts it straight
   * behind the player instead of sliding there. The developer free camera of
   * `free-camera.ts` calls this when it hands the camera back: the player may
   * be a kilometre from where the follow was left.
   */
  snap(): void {
    this.initialised = false;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Move toward the target. `dt` is render time; the camera is not simulation
   * state. `height` is the ground the target stands on, so the view rises and
   * falls with the hill rather than cutting into it. The camera pulls back for
   * speed only in a vehicle (spec section 10.7): `driving: false` keeps a
   * player on foot at the base distance, walking or sprinting.
   *
   * With `roofs`, the camera does not stand inside a building: it pulls back
   * along its fixed view until it is over the roof under it. It climbs fast and
   * comes down slowly, so a row of roofs does not make it bob.
   */
  update(
    dt: number,
    target: { x: number; y: number; height: number; heading: number; speed: number; driving?: boolean },
    roofs?: RoofHeight,
  ): void {
    const lead = Math.abs(target.speed) * LEAD_PER_SPEED;
    const wanted = new Vector3(
      target.x + Math.cos(target.heading) * lead,
      target.height,
      target.y + Math.sin(target.heading) * lead,
    );
    const zoom = target.driving === false ? 0 : Math.abs(target.speed) * DISTANCE_PER_SPEED;
    // Back off along the fixed view direction so the focus stays centred.
    const back = new Vector3(0, 0, 1).applyEuler(this.camera.rotation);
    if (!this.initialised) {
      this.focus.copy(wanted);
      this.zoom = zoom;
      const distance = this.baseDistance + this.zoom;
      this.pull = roofs === undefined ? 0 : pullOver(this.focus, back, distance, roofs);
      this.initialised = true;
    } else {
      // Exponential smoothing, not a linear factor on `dt`. A frame's length
      // varies by a millisecond or two, and a linear factor turns that into
      // camera movement: the same jitter the interpolation of `smooth.ts`
      // takes out of the player would come back through the view.
      this.focus.lerp(wanted, 1 - Math.exp(-FOLLOW_RATE * dt));
      this.zoom += (zoom - this.zoom) * (1 - Math.exp(-ZOOM_RATE * dt));
      const distance = this.baseDistance + this.zoom;
      const pull = roofs === undefined ? 0 : pullOver(this.focus, back, distance, roofs);
      const rate = pull > this.pull ? CLIMB_RATE : SETTLE_RATE;
      this.pull += (pull - this.pull) * (1 - Math.exp(-rate * dt));
    }
    this.camera.position.copy(this.focus).addScaledVector(back, this.baseDistance + this.zoom + this.pull);
    this.applyOrientation();
  }
}

/**
 * Metres past `distance` the camera must stand back along `back` to be over
 * every roof under it. Each step stands the camera at the height of the roof
 * it found; that moves it back over the ground, where another roof may stand.
 */
export function pullOver(focus: Vector3, back: Vector3, distance: number, roofs: RoofHeight): number {
  let reach = distance;
  for (let i = 0; i < PULL_STEPS; i++) {
    const top = roofs(focus.x + back.x * reach, focus.z + back.z * reach);
    const y = focus.y + back.y * reach;
    if (top === undefined || y >= top + ROOF_CLEARANCE) break;
    reach = Math.min(distance + MAX_PULL, (top + ROOF_CLEARANCE - focus.y) / back.y);
    if (reach >= distance + MAX_PULL) break;
  }
  return reach - distance;
}
