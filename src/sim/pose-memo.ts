/**
 * The last two poses worked out for each person or vehicle on a loop, by the
 * whole tick of the loop they stand at.
 *
 * A pose on a loop is a pure function of the id and the tick, and one tick
 * asks for the same pose many times: giving way reads each car and person
 * where they stand and where they will stand, and the physics then aims the
 * cars at the second of those. The next tick asks again for the pose it has
 * already worked out as the one ahead. Two slots hold both, so each pose is
 * sampled from the roads once. A value read back is the value stored, so the
 * answer is the same bit for bit as sampling again.
 */

/** The part of a pose that costs a walk along the roads to work out. */
export interface MemoPose {
  x: number;
  y: number;
  height: number;
  heading: number;
}

const SLOTS = 2;
const FIELDS = 4;

export class PoseMemo {
  /** The tick of the loop each slot holds, NaN for none. */
  private readonly keys: Float64Array;
  private readonly values: Float64Array;
  /** The slot of each id written last, which the next write keeps. */
  private readonly newest: Uint8Array;

  constructor(count: number) {
    this.keys = new Float64Array(count * SLOTS).fill(NaN);
    this.values = new Float64Array(count * SLOTS * FIELDS);
    this.newest = new Uint8Array(count);
  }

  /** Copy the pose of `id` at tick `at` of its loop into `out`, answering whether it was held. */
  read(id: number, at: number, out: MemoPose): boolean {
    const base = id * SLOTS;
    let slot = -1;
    if (this.keys[base] === at) slot = 0;
    else if (this.keys[base + 1] === at) slot = 1;
    if (slot < 0) return false;
    const v = (base + slot) * FIELDS;
    const values = this.values;
    out.x = values[v] as number;
    out.y = values[v + 1] as number;
    out.height = values[v + 2] as number;
    out.heading = values[v + 3] as number;
    return true;
  }

  /** Hold the pose of `id` at tick `at` of its loop, in place of the older of its two. */
  write(id: number, at: number, pose: MemoPose): void {
    const slot = 1 - (this.newest[id] as number);
    this.newest[id] = slot;
    const at2 = id * SLOTS + slot;
    this.keys[at2] = at;
    const v = at2 * FIELDS;
    const values = this.values;
    values[v] = pose.x;
    values[v + 1] = pose.y;
    values[v + 2] = pose.height;
    values[v + 3] = pose.heading;
  }
}
