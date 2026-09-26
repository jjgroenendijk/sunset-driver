/**
 * One remote player, drawn between the frames they sent (spec section 21.5).
 *
 * A frame crosses the network at whatever rate the sender and the link allow,
 * and arrives late, early or not at all. Drawing each one as it lands is what
 * teleporting looks like. So a replica is drawn {@link DELAY_TICKS} behind the
 * local clock: by the time a moment is drawn, the frames either side of it have
 * usually arrived, and the pose is the blend of them.
 *
 * Where the next frame has not arrived, the replica carries on from the last
 * one on its own velocity and inputs — dead reckoning. It does that for at most
 * {@link REACH_TICKS}; past that the player is not late but gone, and a pose
 * invented for a second and a half is worse than one that stands still.
 *
 * Nothing here is simulation state. A replica is drawn and never stepped, so
 * the record is untouched and the determinism of spec section 21.4 holds: what
 * every peer computes from `(seed, tick)` is the same city, and this is only
 * the people in it.
 */
import type { VehicleClass } from '../sim/vehicles/vehicle.ts';
import type { PlayerFrame } from './move.ts';

/**
 * How far behind its own clock a replica is drawn: a little over the six ticks
 * a nearby sender leaves between frames (`roster.ts`). Shorter, and the buffer
 * is usually empty ahead of the moment being drawn, which is dead reckoning on
 * every frame rather than on a lost one.
 */
export const DELAY_TICKS = 8;

/**
 * How far a pose is carried on past the last frame that arrived. Half a second
 * covers a lost frame and a stall; past it the replica holds still where it
 * last was.
 */
export const REACH_TICKS = 30;

/** Frames kept per player, which is several seconds of them at any send rate. */
const BUFFER = 24;

/** Seconds one tick is worth, for carrying a velocity forward. */
const TICK_SECONDS = 1 / 60;

/** A remote player as the frame draws them. */
export interface RemotePose {
  x: number;
  y: number;
  height: number;
  heading: number;
  speed: number;
  vy: number;
  grounded: boolean;
  driving: boolean;
  sprint: boolean;
  health: number;
  cls: VehicleClass;
  paint: number;
  carX: number;
  carY: number;
  carZ: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  carSpeed: number;
}

export class Replica {
  /** The frames that arrived, oldest first, by the sender's tick. */
  private readonly frames: PlayerFrame[] = [];

  /** The sender's tick of the newest frame held, or -1 before the first. */
  get newest(): number {
    const last = this.frames[this.frames.length - 1];
    return last === undefined ? -1 : last.tick;
  }

  /** How many frames are held, which is what a test reads. */
  get held(): number {
    return this.frames.length;
  }

  /**
   * Take a frame. A frame older than one already held is dropped rather than
   * sorted in: the network reorders, and a pose already drawn is not redrawn.
   */
  push(frame: PlayerFrame): void {
    if (frame.tick <= this.newest) return;
    this.frames.push(frame);
    if (this.frames.length > BUFFER) this.frames.shift();
  }

  /**
   * Ticks since the last frame, measured against the local clock. The room
   * reads it to tell a player who is quiet from one who has gone.
   */
  age(tick: number): number {
    return this.newest < 0 ? Number.POSITIVE_INFINITY : tick - this.newest;
  }

  /**
   * The pose to draw at the local tick, or null before the first frame has
   * arrived. The moment drawn is {@link DELAY_TICKS} behind that tick.
   */
  at(tick: number): RemotePose | null {
    const target = tick - DELAY_TICKS;
    const oldest = this.frames[0];
    if (oldest === undefined) return null;
    if (target <= oldest.tick) return poseOf(oldest);
    for (let i = this.frames.length - 1; i > 0; i--) {
      const after = this.frames[i] as PlayerFrame;
      const before = this.frames[i - 1] as PlayerFrame;
      if (after.tick < target) break;
      if (before.tick <= target) return blend(before, after, (target - before.tick) / (after.tick - before.tick));
    }
    return reckon(this.frames[this.frames.length - 1] as PlayerFrame, target);
  }
}

/** A frame as a pose, with nothing carried on and nothing blended. */
function poseOf(frame: PlayerFrame): RemotePose {
  return {
    x: frame.x,
    y: frame.y,
    height: frame.height,
    heading: frame.heading,
    speed: frame.speed,
    vy: frame.vy,
    grounded: frame.grounded,
    driving: frame.driving,
    sprint: frame.sprint,
    health: frame.health,
    cls: frame.cls,
    paint: frame.paint,
    carX: frame.carX,
    carY: frame.carY,
    carZ: frame.carZ,
    qx: frame.qx,
    qy: frame.qy,
    qz: frame.qz,
    qw: frame.qw,
    carSpeed: frame.carSpeed,
  };
}

/**
 * The pose between two frames. Everything that is a place or an angle is
 * blended; everything that is a fact about the player — which class they are
 * driving, whether they are in it — is the later frame's, because half of a
 * change of state is not a state.
 */
function blend(before: PlayerFrame, after: PlayerFrame, t: number): RemotePose {
  const pose = poseOf(after);
  pose.x = lerp(before.x, after.x, t);
  pose.y = lerp(before.y, after.y, t);
  pose.height = lerp(before.height, after.height, t);
  pose.heading = lerpAngle(before.heading, after.heading, t);
  pose.speed = lerp(before.speed, after.speed, t);
  pose.vy = lerp(before.vy, after.vy, t);
  pose.carX = lerp(before.carX, after.carX, t);
  pose.carY = lerp(before.carY, after.carY, t);
  pose.carZ = lerp(before.carZ, after.carZ, t);
  pose.carSpeed = lerp(before.carSpeed, after.carSpeed, t);
  turn(pose, before, after, t);
  return pose;
}

/**
 * Carry the last frame on to the moment being drawn. A driver keeps their
 * velocity; a player on foot keeps their pace along the way they face, and
 * holds it while they are sprinting rather than slowing to a stop.
 *
 * The orientation is held rather than turned on: a car's turn rate is not on
 * the wire, and half a second of a turn is a few degrees of error, while
 * guessing at it is a car that spins on the spot.
 */
function reckon(frame: PlayerFrame, target: number): RemotePose {
  const pose = poseOf(frame);
  const dt = Math.min(target - frame.tick, REACH_TICKS) * TICK_SECONDS;
  if (dt <= 0) return pose;
  if (frame.driving) {
    pose.carX += frame.velX * dt;
    pose.carY += frame.velY * dt;
    pose.carZ += frame.velZ * dt;
    pose.x += frame.velX * dt;
    pose.y += frame.velZ * dt;
  } else {
    pose.x += Math.cos(frame.heading) * frame.speed * dt;
    pose.y += Math.sin(frame.heading) * frame.speed * dt;
    pose.height += frame.vy * dt;
  }
  return pose;
}

/**
 * Blend two orientations. It is the straight blend of the four numbers, put
 * back on the unit sphere, with the shorter way round taken first: two frames a
 * tenth of a second apart are close enough that the arc and the chord between
 * them are the same line to look at.
 */
function turn(pose: RemotePose, before: PlayerFrame, after: PlayerFrame, t: number): void {
  const dot = before.qx * after.qx + before.qy * after.qy + before.qz * after.qz + before.qw * after.qw;
  const sign = dot < 0 ? -1 : 1;
  const x = lerp(before.qx, after.qx * sign, t);
  const y = lerp(before.qy, after.qy * sign, t);
  const z = lerp(before.qz, after.qz * sign, t);
  const w = lerp(before.qw, after.qw * sign, t);
  const length = Math.hypot(x, y, z, w);
  if (length === 0) return;
  pose.qx = x / length;
  pose.qy = y / length;
  pose.qz = z / length;
  pose.qw = w / length;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Blend two headings the short way round, so a turn past `PI` is not a whole turn back. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
