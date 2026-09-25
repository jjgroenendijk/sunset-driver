/**
 * The body of a car of the traffic moving on its springs (spec section 13.1).
 *
 * A car that brakes dips its nose and one that pulls away sits back on its
 * tail. In a turn the body leans out of the turn. When the pull stops, the
 * body rocks back past level once and settles. Each of the two angles is a
 * damped spring driven by what the car is doing: the pitch by how hard it
 * speeds up or slows down, the roll by how hard it is turning. A bike leans
 * into a turn instead, as far as the turn needs to stay upright.
 *
 * This is drawing only. The tours stay a function of the tick, and only the
 * body is turned: the tyres stay on the road.
 */

/** Radians of pitch for each metre per second squared of speeding up. */
const PITCH_PER_ACCEL = 0.011;

/** Radians of roll out of a turn for each metre per second squared of pull across. */
const ROLL_PER_PULL = 0.013;

/** The most either angle leans a car's body, in radians. */
const MOST = 0.06;

/** How often a body rocks on its springs, in radians per second: a little over one rock a second. */
const STIFFNESS = 2 * Math.PI * 1.3;

/** The share of critical damping: under 1, so a body rocks back past level once. */
const DAMPING = 0.4;

/** Metres per second squared of gravity, which a bike leans against. */
const GRAVITY = 9.81;

/** Seconds between two frames past which a car is taken as seen afresh. */
const GAP = 0.25;

/** The pull a frame is allowed to read, in metres per second squared: a car held by giving way stops at once. */
const PULL_CAP = 8;

/** One car's springs and what the last frame saw of it. */
interface Spring {
  pitch: number;
  pitchRate: number;
  roll: number;
  rollRate: number;
  x: number;
  y: number;
  heading: number;
  /** Metres per second along the heading, as the frames measured it. */
  speed: number;
  /** The time of the frame, in ticks. */
  time: number;
  /** The frame the car was last drawn in, which is how the cars that left are dropped. */
  frame: number;
}

/** How a car's body is turned on its springs this frame. */
export interface Lean {
  /** Radians the nose is up. */
  pitch: number;
  /** Radians the body leans to its right. */
  roll: number;
}

export class Suspension {
  private readonly springs = new Map<number, Spring>();
  private frame = 0;

  /** Start a frame. Cars not drawn in it are forgotten when it ends. */
  begin(): void {
    this.frame++;
  }

  /** Forget the cars the frame did not draw. */
  end(): void {
    for (const [id, spring] of this.springs) if (spring.frame !== this.frame) this.springs.delete(id);
  }

  /**
   * The lean of car `id` standing at `(x, y)` facing `heading` at `time`, in
   * ticks, which may fall between two. `speed` is the speed its tour says it
   * drives at, read on the first frame the car is seen. A `bike` leans into a
   * turn and does not pitch.
   */
  lean(id: number, time: number, x: number, y: number, heading: number, speed: number, bike: boolean, out: Lean): Lean {
    let spring = this.springs.get(id);
    const dt = spring === undefined ? 0 : (time - spring.time) / 60;
    if (spring === undefined || dt > GAP || dt < 0) {
      spring = { pitch: 0, pitchRate: 0, roll: 0, rollRate: 0, x, y, heading, speed, time, frame: this.frame };
      this.springs.set(id, spring);
    } else if (dt > 0) {
      const fx = Math.cos(heading);
      const fy = Math.sin(heading);
      const moved = ((x - spring.x) * fx + (y - spring.y) * fy) / dt;
      const along = clamp((moved - spring.speed) / dt, PULL_CAP);
      const yaw = wrap(heading - spring.heading) / dt;
      // Positive when the car turns towards its right hand.
      const across = clamp(moved * yaw, PULL_CAP);
      const pitchTo = bike ? 0 : clamp(along * PITCH_PER_ACCEL, MOST);
      const rollTo = bike ? Math.atan(across / GRAVITY) : clamp(-across * ROLL_PER_PULL, MOST);
      // Steps short enough for the springs to stay stable at any frame rate.
      const steps = Math.ceil(dt / (1 / 120));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        spring.pitchRate += (STIFFNESS * STIFFNESS * (pitchTo - spring.pitch) - 2 * DAMPING * STIFFNESS * spring.pitchRate) * h;
        spring.pitch += spring.pitchRate * h;
        spring.rollRate += (STIFFNESS * STIFFNESS * (rollTo - spring.roll) - 2 * DAMPING * STIFFNESS * spring.rollRate) * h;
        spring.roll += spring.rollRate * h;
      }
      spring.x = x;
      spring.y = y;
      spring.heading = heading;
      spring.speed = moved;
      spring.time = time;
    }
    spring.frame = this.frame;
    out.pitch = spring.pitch;
    out.roll = spring.roll;
    return out;
  }
}

function clamp(value: number, most: number): number {
  return Math.max(-most, Math.min(most, value));
}

/** An angle in radians brought into -π to π. */
function wrap(angle: number): number {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
}
