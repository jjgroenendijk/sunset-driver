import { PerspectiveCamera, Vector3 } from 'three';
import { hashInts } from '../core/hash.ts';
import {
  backOf,
  CHASE_NEAR,
  clearYaw,
  EYE_AHEAD_DRIVING,
  EYE_AHEAD_ON_FOOT,
  EYE_HEIGHT_DRIVING,
  EYE_HEIGHT_ON_FOOT,
  BASE_FOV,
  FIRST_FOV,
  FIRST_PITCH,
  FIRST_PITCH_ON_FOOT,
  FOV_RATE,
  FIRST_PITCH_MIN,
  FIRST_TURN_RATE,
  LOOK_HOLD,
  LOOK_PER_PIXEL,
  LOOK_RETURN,
  LOOK_HEIGHT_DRIVING,
  LOOK_HEIGHT_ON_FOOT,
  THIRD_DISTANCE_DRIVING,
  THIRD_DISTANCE_ON_FOOT,
  THIRD_DISTANCE_PER_SPEED,
  PITCH_MAX,
  THIRD_PITCH,
  THIRD_PITCH_MIN,
  THIRD_TURN_RATE,
  TOP_NEAR,
  TURN_RATE,
  turnToward,
  yawBehind,
  type CameraView,
  type RoofHeight,
} from './camera-view.ts';

export type { CameraView, RoofHeight } from './camera-view.ts';

/** Locked pitch in radians below horizontal of the top-down view; it never rolls. */
export const CAMERA_PITCH = (58 * Math.PI) / 180;
export const CAMERA_HEADING = 0;
export const BASE_DISTANCE = 36;
const DISTANCE_PER_SPEED = 0.9;
/** Metres the top-down camera pulls back per metre an aircraft climbs. */
const DISTANCE_PER_ALTITUDE = 0.9;
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
/**
 * Metres every footprint is grown by when the turn asks which roofs stand
 * between the camera and the player. A little, so a sight line that grazes a
 * wall counts as blocked.
 */
export const TURN_MARGIN = 1;
/** How fast the camera climbs over a roof, and how fast it comes down again, in e-foldings a second. */
const CLIMB_RATE = 6;
const SETTLE_RATE = 1.5;
/** The most metres the camera pulls back over roofs, and the most steps it takes to find them. */
const MAX_PULL = 400;
const PULL_STEPS = 12;
/** How fast a shot's kick settles, in e-foldings a second, and the most metres kicks add up to. */
const KICK_RATE = 18;
const MAX_KICK = 0.6;
/**
 * The jolt of the player's car hitting a person: seconds it lasts, metres it
 * moves the view at the hardest hit, and the two rates it shakes at, per second.
 */
const JOLT_SECONDS = 0.25;
const JOLT_METRES = 0.3;
const JOLT_RATE_X = 23;
const JOLT_RATE_Z = 17;

/** Where the camera follows: the player as the frame draws them. */
export interface CameraTarget {
  x: number;
  y: number;
  height: number;
  heading: number;
  speed: number;
  driving?: boolean;
}

/**
 * How the camera looks this frame (spec section 10.7). `view` is top down
 * unless the player chose otherwise. `pull` stands the top-down camera back
 * over the roof under it; `turn` turns it round the player to a heading from
 * which no roof hides them. The chase views read neither. `mouse` is true
 * while the pointer is locked to the game, so the mouse turns a chase view.
 */
export interface CameraLook {
  view?: CameraView;
  pull?: RoofHeight;
  turn?: RoofHeight;
  mouse?: boolean;
  /**
   * Metres the player's vehicle stands over the ground under it. An aircraft
   * climbing pulls the top-down camera back with it (spec section 10.7), so
   * the ground stays in the view rather than falling away below it.
   */
  altitude?: number;
  /**
   * How much first person zooms in, 1 for none: aiming a weapon narrows the
   * view, and a scope narrows it further. Ignored by the other views.
   */
  zoom?: number;
}

/**
 * The game camera. Top down, it is tilted at a fixed pitch and only moves: it
 * leads the target in its direction of travel and pulls back as speed rises.
 * Its heading is north until the Turn setting swings it past a building, and
 * stays where that turn left it rather than swinging back. The chase views of
 * `camera-view.ts` stand behind the player or at their eyes.
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
  /** Metres the last shots pushed the view, across the map, settling back to nothing. */
  private readonly shake = new Vector3();
  /** Seconds since the last jolt, how hard it was, and the two phases its tick gave it. */
  private joltAge = JOLT_SECONDS;
  private joltSize = 0;
  private joltPhaseX = 0;
  private joltPhaseZ = 0;
  /** The view the camera took last frame, the heading it looks along, and the heading the turn is after. */
  private shown: CameraView = 'top-down';
  private yaw = CAMERA_HEADING;
  private turnGoal = CAMERA_HEADING;
  private pitch = CAMERA_PITCH;
  private readonly back = new Vector3();
  /**
   * The mouse look of the chase views: pixels moved since the last frame, the
   * yaw and pitch it has turned the view by, and seconds since it last moved.
   */
  private lookX = 0;
  private lookY = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private still = LOOK_HOLD;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(BASE_FOV, aspect, TOP_NEAR, 2000);
    this.applyOrientation();
  }

  private applyOrientation(): void {
    this.camera.rotation.set(-this.pitch, this.yaw + this.lookYaw, 0, 'YXZ');
  }

  /** Radians above level the view looks: negative looking down. */
  get elevation(): number {
    return -this.pitch;
  }

  /** The view the camera stands in now. */
  get view(): CameraView {
    return this.shown;
  }

  /**
   * The heading the camera looks along, as a yaw about the up axis: 0 looks
   * north. On foot the keys walk relative to it, so up the screen is forward.
   */
  get heading(): number {
    return this.yaw + this.lookYaw;
  }

  /**
   * Turn a chase view by a movement of the locked mouse, in pixels: right
   * turns the view right, down tilts it down. The next update applies it.
   */
  look(dx: number, dy: number): void {
    this.lookX += dx;
    this.lookY += dy;
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

  /**
   * Push the view back from a shot (spec section 11.5): `metres` against the
   * map direction `(x, y)` the round went. The push settles within a few
   * frames. It is render state, like the rest of the camera.
   */
  kick(x: number, y: number, metres: number): void {
    const length = Math.hypot(x, y);
    if (length === 0) return;
    this.shake.x -= (x / length) * metres;
    this.shake.z -= (y / length) * metres;
    if (this.shake.length() > MAX_KICK) this.shake.setLength(MAX_KICK);
  }

  /**
   * Shake the view for a moment: the player's car has hit a person, or gone
   * over a body. `strength` is the hit's, 0 to 1. The shake is drawn from the
   * tick of the hit, so the same hit shakes the same way. A harder jolt takes
   * over from a softer one still running; a softer one leaves it be.
   */
  jolt(strength: number, tick: number): void {
    const size = JOLT_METRES * Math.min(1, Math.max(0, strength));
    const left = this.joltAge < JOLT_SECONDS ? this.joltSize * (1 - this.joltAge / JOLT_SECONDS) : 0;
    if (size <= left) return;
    this.joltAge = 0;
    this.joltSize = size;
    this.joltPhaseX = (hashInts(tick, 1) / 0x100000000) * Math.PI * 2;
    this.joltPhaseZ = (hashInts(tick, 2) / 0x100000000) * Math.PI * 2;
  }

  /** Where the jolt has the view now, in metres across the map, added to `out`. */
  private joltBy(dt: number, out: Vector3): void {
    if (this.joltAge >= JOLT_SECONDS) return;
    this.joltAge += dt;
    const left = Math.max(0, 1 - this.joltAge / JOLT_SECONDS);
    const t = this.joltAge * Math.PI * 2;
    out.x += this.joltSize * left * Math.sin(JOLT_RATE_X * t + this.joltPhaseX);
    out.z += this.joltSize * left * Math.sin(JOLT_RATE_Z * t + this.joltPhaseZ);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Move toward the target. `dt` is render time; the camera is not simulation
   * state. `height` is the ground the target stands on, so the view rises and
   * falls with the hill rather than cutting into it. The top-down camera pulls
   * back for speed only in a vehicle (spec section 10.7): `driving: false`
   * keeps a player on foot at the base distance, walking or sprinting.
   *
   * A change of view snaps the camera to the new one rather than sliding
   * through the city between them.
   */
  update(dt: number, target: CameraTarget, look: CameraLook = {}): void {
    const view = look.view ?? 'top-down';
    if (view !== this.shown) {
      this.shown = view;
      this.initialised = false;
      this.lookYaw = 0;
      this.lookPitch = 0;
      this.camera.near = view === 'top-down' ? TOP_NEAR : CHASE_NEAR;
      this.camera.updateProjectionMatrix();
    }
    this.fit(view === 'first-person' ? FIRST_FOV / Math.max(1, look.zoom ?? 1) : BASE_FOV, dt);
    if (view === 'top-down') this.followOver(dt, target, look);
    else this.followBehind(dt, target, view === 'first-person', look.mouse === true);
    this.shake.multiplyScalar(Math.exp(-KICK_RATE * dt));
    this.camera.position.add(this.shake);
    this.joltBy(dt, this.camera.position);
    this.applyOrientation();
  }

  /** Ease the field of view toward `fov` degrees, and snap it on a change of view. */
  private fit(fov: number, dt: number): void {
    const next = this.initialised ? this.camera.fov + (fov - this.camera.fov) * (1 - Math.exp(-FOV_RATE * dt)) : fov;
    if (Math.abs(next - this.camera.fov) < 1e-3) return;
    this.camera.fov = next;
    this.camera.updateProjectionMatrix();
  }

  /**
   * The top-down view. With `pull`, the camera does not stand inside a
   * building: it pulls back along its view until it is over the roof under it.
   * It climbs fast and comes down slowly, so a row of roofs does not make it
   * bob. With `turn`, it turns round the player, pitch held, to a heading from
   * which they are seen.
   */
  private followOver(dt: number, target: CameraTarget, look: CameraLook): void {
    const lead = Math.abs(target.speed) * LEAD_PER_SPEED;
    const wanted = new Vector3(
      target.x + Math.cos(target.heading) * lead,
      target.height,
      target.y + Math.sin(target.heading) * lead,
    );
    const climb = Math.max(0, look.altitude ?? 0) * DISTANCE_PER_ALTITUDE;
    const zoom = target.driving === false ? 0 : Math.abs(target.speed) * DISTANCE_PER_SPEED + climb;
    this.pitch = CAMERA_PITCH;
    const scratch = new Vector3();
    const goal = (distance: number): number =>
      look.turn === undefined ? CAMERA_HEADING : clearYaw(target, this.turnGoal, this.pitch, distance, look.turn, scratch);
    if (!this.initialised) {
      this.focus.copy(wanted);
      this.zoom = zoom;
      this.turnGoal = goal(this.baseDistance + this.zoom);
      this.yaw = this.turnGoal;
      const back = backOf(this.yaw, this.pitch, this.back);
      this.pull = look.pull === undefined ? 0 : pullOver(this.focus, back, this.baseDistance + this.zoom, look.pull);
      this.initialised = true;
    } else {
      // Exponential smoothing, not a linear factor on `dt`. A frame's length
      // varies by a millisecond or two, and a linear factor turns that into
      // camera movement: the same jitter the interpolation of `smooth.ts`
      // takes out of the player would come back through the view.
      this.focus.lerp(wanted, 1 - Math.exp(-FOLLOW_RATE * dt));
      this.zoom += (zoom - this.zoom) * (1 - Math.exp(-ZOOM_RATE * dt));
      const distance = this.baseDistance + this.zoom;
      this.turnGoal = goal(distance + this.pull);
      this.yaw = turnToward(this.yaw, this.turnGoal, 1 - Math.exp(-TURN_RATE * dt));
      const back = backOf(this.yaw, this.pitch, this.back);
      const pull = look.pull === undefined ? 0 : pullOver(this.focus, back, distance, look.pull);
      const rate = pull > this.pull ? CLIMB_RATE : SETTLE_RATE;
      this.pull += (pull - this.pull) * (1 - Math.exp(-rate * dt));
    }
    this.camera.position.copy(this.focus).addScaledVector(this.back, this.baseDistance + this.zoom + this.pull);
  }

  /**
   * The chase views. Third person stands behind and over the player and turns
   * after them; first person stands at their eyes and turns with them. The
   * heading is the one the player faces, or the car.
   *
   * With `mouse`, the mouse turns the view. On foot it steers it alone, and
   * the walking keys follow it, as `docs/camera.md` says. At the wheel it looks
   * aside from the car, and the view goes back behind the car once the mouse
   * is still.
   */
  private followBehind(dt: number, target: CameraTarget, first: boolean, mouse: boolean): void {
    const driving = target.driving !== false;
    const goal = yawBehind(target.heading);
    const steered = mouse && !driving;
    const frame = behindFrame(first, driving);
    const base = frame.pitch;
    this.turnLook(dt, mouse, steered, base, frame.pitchMin - base);
    this.pitch = base + this.lookPitch;
    const wanted = new Vector3(
      target.x + Math.cos(target.heading) * frame.ahead,
      target.height + frame.up,
      target.y + Math.sin(target.heading) * frame.ahead,
    );
    const zoom = first ? 0 : Math.abs(target.speed) * THIRD_DISTANCE_PER_SPEED;
    if (!this.initialised) {
      this.yaw = goal;
      this.zoom = zoom;
      this.pull = 0;
      this.lookYaw = 0;
      this.lookPitch = 0;
      this.initialised = true;
    } else {
      if (!steered) this.yaw = turnToward(this.yaw, goal, 1 - Math.exp(-frame.turnRate * dt));
      this.zoom += (zoom - this.zoom) * (1 - Math.exp(-ZOOM_RATE * dt));
    }
    // The focus is the player and not a lag behind them: the view turns
    // smoothly, and a lag on top of that swings the player across the screen.
    this.focus.copy(wanted);
    const distance = first ? 0 : frame.distance + this.zoom;
    backOf(this.yaw + this.lookYaw, this.pitch, this.back);
    this.camera.position.copy(this.focus).addScaledVector(this.back, distance);
  }

  /**
   * Turn the look aside by the mouse's movement since the last frame, and let
   * it go back behind once the mouse is still. `low` is the lowest look pitch
   * over the view's own.
   */
  private turnLook(dt: number, mouse: boolean, steered: boolean, base: number, low: number): void {
    const moved = mouse && (this.lookX !== 0 || this.lookY !== 0);
    this.still = moved ? 0 : this.still + dt;
    if (mouse) {
      this.lookYaw -= this.lookX * LOOK_PER_PIXEL;
      this.lookPitch = Math.min(PITCH_MAX - base, Math.max(low, this.lookPitch + this.lookY * LOOK_PER_PIXEL));
    }
    this.lookX = 0;
    this.lookY = 0;
    if (steered) {
      // On foot the look is the heading itself, so none of it is left aside.
      this.yaw += this.lookYaw;
      this.lookYaw = 0;
    } else if (!mouse || this.still > LOOK_HOLD) {
      const back = 1 - Math.exp(-LOOK_RETURN * dt);
      this.lookYaw -= this.lookYaw * back;
      this.lookPitch -= this.lookPitch * back;
    }
  }
}

/** The numbers of one chase view: first or third person, at the wheel or on foot. */
interface BehindFrame {
  /** The pitch of the view and the lowest the look may take it. */
  pitch: number;
  pitchMin: number;
  /** Metres over the player and ahead of them the view looks from, or at. */
  up: number;
  ahead: number;
  /** How fast the view turns after the heading. */
  turnRate: number;
  /** Metres the view stands back, before the zoom; unused in first person. */
  distance: number;
}

function behindFrame(first: boolean, driving: boolean): BehindFrame {
  if (first && driving) {
    return {
      pitch: FIRST_PITCH,
      pitchMin: FIRST_PITCH_MIN,
      up: EYE_HEIGHT_DRIVING,
      ahead: EYE_AHEAD_DRIVING,
      turnRate: FIRST_TURN_RATE,
      distance: 0,
    };
  }
  if (first) {
    return {
      pitch: FIRST_PITCH_ON_FOOT,
      pitchMin: FIRST_PITCH_MIN,
      up: EYE_HEIGHT_ON_FOOT,
      ahead: EYE_AHEAD_ON_FOOT,
      turnRate: FIRST_TURN_RATE,
      distance: 0,
    };
  }
  if (driving) {
    return {
      pitch: THIRD_PITCH,
      pitchMin: THIRD_PITCH_MIN,
      up: LOOK_HEIGHT_DRIVING,
      ahead: 0,
      turnRate: THIRD_TURN_RATE,
      distance: THIRD_DISTANCE_DRIVING,
    };
  }
  return {
    pitch: THIRD_PITCH,
    pitchMin: THIRD_PITCH_MIN,
    up: LOOK_HEIGHT_ON_FOOT,
    ahead: 0,
    turnRate: THIRD_TURN_RATE,
    distance: THIRD_DISTANCE_ON_FOOT,
  };
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
