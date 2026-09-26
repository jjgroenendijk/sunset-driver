/**
 * The pose the frame draws, between two simulation ticks.
 *
 * The simulation runs at a fixed 60 Hz and the display refreshes at its own
 * rate, so the two never line up. A frame takes 0, 1 or 2 steps, whatever the
 * display does: the accumulator of `src/sim/clock.ts` drifts against the
 * 16.667 ms step. Drawing the record as it stands after those steps puts the
 * player somewhere new on some frames and nowhere new on others, while the
 * camera slides on every frame. That is the judder.
 *
 * So the frame is drawn between the last two ticks rather than on the last
 * one. {@link RenderSmoother.capture} is called before every step and keeps
 * the pose the step started from; `alpha` from the clock says how far through
 * the step the frame stands. The drawn pose is one step behind the record,
 * which is 16.7 ms of lag and the price of a frame that holds still.
 *
 * Nothing here is simulation state: the record is never written, and the same
 * ticks replayed draw the same way whatever the frame rate.
 */
import type { SimState } from '../../sim/simulation.ts';
import type { VehicleState, WheelState } from '../../sim/vehicles/vehicle.ts';

/** Where the player is drawn: what the character model and the camera read. */
export interface DrawnPlayer {
  x: number;
  y: number;
  height: number;
  heading: number;
  speed: number;
  /** Whether the player is in a vehicle, which the follow camera pulls back for. */
  driving: boolean;
}

/** Blend two numbers. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Blend two headings the short way round. A heading that crosses `PI` is the
 * same turn as the one back through zero, and blending the raw numbers would
 * spin the model a whole turn on the frame it crosses.
 */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** One tick of the player, as much of it as is drawn. */
interface PlayerPose {
  x: number;
  y: number;
  height: number;
  heading: number;
  speed: number;
}

/** One tick of the vehicle, as much of it as is drawn. */
interface VehiclePose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  wheels: { rotation: number; steer: number; suspension: number }[];
}

/**
 * The two poses a frame is drawn between, and the scratch the blend is written
 * into. The scratch is made once and written over every frame: a pose is drawn
 * and thrown away, so nothing here allocates after the first vehicle.
 */
export class RenderSmoother {
  private readonly player: PlayerPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  private readonly vehicle: VehiclePose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, wheels: [] };
  private readonly drawnPlayer: DrawnPlayer = { x: 0, y: 0, height: 0, heading: 0, speed: 0, driving: false };
  private scratch: VehicleState | undefined;
  /** Whether a pose has been captured, so the first frame draws the record itself. */
  private held = false;

  /**
   * Keep the pose the step about to be taken starts from. Called once before
   * every `stepSim`, so after a frame's steps this holds the tick before last.
   */
  capture(state: SimState): void {
    const p = state.player;
    this.player.x = p.x;
    this.player.y = p.y;
    this.player.height = p.height;
    this.player.heading = p.heading;
    this.player.speed = p.speed;
    const v = state.vehicle;
    this.vehicle.x = v.x;
    this.vehicle.y = v.y;
    this.vehicle.z = v.z;
    this.vehicle.qx = v.qx;
    this.vehicle.qy = v.qy;
    this.vehicle.qz = v.qz;
    this.vehicle.qw = v.qw;
    this.fitWheels(v);
    for (let i = 0; i < v.wheels.length; i++) {
      const from = v.wheels[i] as WheelState;
      const into = this.vehicle.wheels[i] as VehiclePose['wheels'][number];
      into.rotation = from.rotation;
      into.steer = from.steer;
      into.suspension = from.suspension;
    }
    this.held = true;
  }

  /**
   * Forget the pose held: the player was put down somewhere else, or a session
   * started. The next frame draws the record rather than sliding to it.
   */
  reset(): void {
    this.held = false;
  }

  /** Where the player stands a fraction `alpha` through the step just taken. */
  playerAt(state: SimState, alpha: number): DrawnPlayer {
    const p = state.player;
    const out = this.drawnPlayer;
    if (!this.held) {
      out.x = p.x;
      out.y = p.y;
      out.height = p.height;
      out.heading = p.heading;
      out.speed = p.speed;
      out.driving = p.driving;
      return out;
    }
    const was = this.player;
    out.x = lerp(was.x, p.x, alpha);
    out.y = lerp(was.y, p.y, alpha);
    out.height = lerp(was.height, p.height, alpha);
    out.heading = lerpAngle(was.heading, p.heading, alpha);
    out.speed = lerp(was.speed, p.speed, alpha);
    out.driving = p.driving;
    return out;
  }

  /**
   * The vehicle a fraction `alpha` through the step just taken. The answer is
   * the record itself with the pose written over it, so the class, the damage
   * and everything else the model reads are the record's own.
   */
  vehicleAt(state: SimState, alpha: number): VehicleState {
    const v = state.vehicle;
    if (!this.held) return v;
    const was = this.vehicle;
    if (was.wheels.length !== v.wheels.length) return v;
    const out = this.scratchFor(v);
    out.x = lerp(was.x, v.x, alpha);
    out.y = lerp(was.y, v.y, alpha);
    out.z = lerp(was.z, v.z, alpha);
    // Nearest-neighbour blend of the two orientations, taking the short way
    // round the sphere. A tick turns a vehicle by a few degrees at most, and
    // over that the straight blend and the true slerp differ by less than the
    // frame can show.
    let dot = was.qx * v.qx + was.qy * v.qy + was.qz * v.qz + was.qw * v.qw;
    const sign = dot < 0 ? -1 : 1;
    let qx = lerp(was.qx * sign, v.qx, alpha);
    let qy = lerp(was.qy * sign, v.qy, alpha);
    let qz = lerp(was.qz * sign, v.qz, alpha);
    let qw = lerp(was.qw * sign, v.qw, alpha);
    const length = Math.hypot(qx, qy, qz, qw);
    if (length > 0) {
      qx /= length;
      qy /= length;
      qz /= length;
      qw /= length;
    } else {
      qx = v.qx;
      qy = v.qy;
      qz = v.qz;
      qw = v.qw;
    }
    out.qx = qx;
    out.qy = qy;
    out.qz = qz;
    out.qw = qw;
    for (let i = 0; i < v.wheels.length; i++) {
      const now = v.wheels[i] as WheelState;
      const before = was.wheels[i] as VehiclePose['wheels'][number];
      const into = out.wheels[i] as WheelState;
      into.rotation = lerpAngle(before.rotation, now.rotation, alpha);
      into.steer = lerp(before.steer, now.steer, alpha);
      into.suspension = lerp(before.suspension, now.suspension, alpha);
      into.contact = now.contact;
      into.skid = now.skid;
    }
    return out;
  }

  /** The scratch record, made to match the vehicle being drawn. */
  private scratchFor(v: VehicleState): VehicleState {
    let out = this.scratch;
    if (out === undefined || out.wheels.length !== v.wheels.length) {
      out = { ...v, wheels: v.wheels.map((w) => ({ ...w })) };
      this.scratch = out;
      return out;
    }
    // Everything but the pose is the record's own, the damage and the class
    // included, so the model rebuilds and dents exactly as it would have.
    out.cls = v.cls;
    out.vx = v.vx;
    out.vy = v.vy;
    out.vz = v.vz;
    out.ax = v.ax;
    out.ay = v.ay;
    out.az = v.az;
    out.speed = v.speed;
    out.afloat = v.afloat;
    out.damage = v.damage;
    out.hotwired = v.hotwired;
    return out;
  }

  /** Give the held pose one entry per wheel of the vehicle being driven. */
  private fitWheels(v: VehicleState): void {
    const wheels = this.vehicle.wheels;
    while (wheels.length > v.wheels.length) wheels.pop();
    while (wheels.length < v.wheels.length) wheels.push({ rotation: 0, steer: 0, suspension: 0 });
  }
}
