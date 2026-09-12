import { PerspectiveCamera, Vector3 } from 'three';

/** Locked pitch in radians below horizontal; the camera never rolls or yaws. */
export const CAMERA_PITCH = (58 * Math.PI) / 180;
export const CAMERA_HEADING = 0;
export const BASE_DISTANCE = 36;
/** Close enough on the title screen to read the character's outfit and hair. */
export const PREVIEW_DISTANCE = 6;
const DISTANCE_PER_SPEED = 0.9;
const LEAD_PER_SPEED = 0.6;
/** How fast the focus catches the target, in e-foldings a second. */
const FOLLOW_RATE = 4;

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
   * falls with the hill rather than cutting into it.
   */
  update(dt: number, target: { x: number; y: number; height: number; heading: number; speed: number }): void {
    const lead = Math.abs(target.speed) * LEAD_PER_SPEED;
    const wanted = new Vector3(
      target.x + Math.cos(target.heading) * lead,
      target.height,
      target.y + Math.sin(target.heading) * lead,
    );
    if (!this.initialised) {
      this.focus.copy(wanted);
      this.initialised = true;
    } else {
      // Exponential smoothing, not a linear factor on `dt`. A frame's length
      // varies by a millisecond or two, and a linear factor turns that into
      // camera movement: the same jitter the interpolation of `smooth.ts`
      // takes out of the player would come back through the view.
      this.focus.lerp(wanted, 1 - Math.exp(-FOLLOW_RATE * dt));
    }
    const distance = this.baseDistance + Math.abs(target.speed) * DISTANCE_PER_SPEED;
    // Back off along the fixed view direction so the focus stays centred.
    const back = new Vector3(0, 0, distance).applyEuler(this.camera.rotation);
    this.camera.position.copy(this.focus).add(back);
    this.applyOrientation();
  }
}
