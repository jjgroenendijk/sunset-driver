import { PerspectiveCamera, Vector3 } from 'three';

/** Locked pitch in radians below horizontal; the camera never rolls or yaws. */
export const CAMERA_PITCH = (58 * Math.PI) / 180;
export const CAMERA_HEADING = 0;
export const BASE_DISTANCE = 36;
/** Close enough on the title screen to read the character's outfit and hair. */
export const PREVIEW_DISTANCE = 6;
const DISTANCE_PER_SPEED = 0.9;
const LEAD_PER_SPEED = 0.6;
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

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Move toward the target. `dt` is render time; the camera is not simulation
   * state. `groundY` is the height of the ground under the target, so the
   * camera rides over the hills rather than through them; the focus follows it
   * at the same rate as the rest of the move, which keeps a crest from
   * snapping the view.
   */
  update(dt: number, target: { x: number; y: number; heading: number; speed: number }, groundY = 0): void {
    const lead = Math.abs(target.speed) * LEAD_PER_SPEED;
    const wanted = new Vector3(
      target.x + Math.cos(target.heading) * lead,
      groundY,
      target.y + Math.sin(target.heading) * lead,
    );
    if (!this.initialised) {
      this.focus.copy(wanted);
      this.initialised = true;
    } else {
      this.focus.lerp(wanted, Math.min(1, FOLLOW_RATE * dt));
    }
    const distance = this.baseDistance + Math.abs(target.speed) * DISTANCE_PER_SPEED;
    // Back off along the fixed view direction so the focus stays centred.
    const back = new Vector3(0, 0, distance).applyEuler(this.camera.rotation);
    this.camera.position.copy(this.focus).add(back);
    this.applyOrientation();
  }
}
