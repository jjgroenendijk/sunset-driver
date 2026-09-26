/**
 * Keeping a junction clear (spec section 13.1): a car does not drive over the
 * stop line of a signalled junction while the road past the junction has no
 * room for it. A queue that has backed up to the junction would otherwise
 * leave the car standing in the middle of it, across the way of the cars
 * that have their green next.
 *
 * Where the car will stand is read off its own tour: its cursor is run on
 * until it has left the approach and driven its own length into the road
 * after it. The car waits at the line while a car of the traffic stands
 * there. Only the cars are looked at: they move on, where a wreck standing in
 * the exit would hold the car at the line for ever. What stands still in its
 * lane past the line is what `swerve.ts` steers round.
 */
import { turnedTouch, type AmbientTraffic, type Footprint, type TrafficCursor } from './traffic.ts';
import { STANDING, type Car } from './give-way-scene.ts';
import { cos, sin } from '../../core/libm.ts';

/** Ticks at a time a car's tour is run on, looking for where it stands past the junction, and how many times. */
const RUN_STEP = 10;
const RUN_TRIES = 60;

/** Metres into the road past the junction the car needs, more than its own length. */
const EXIT_ROOM = 2;

/** Metres a car standing past the junction may be off the place without being in the way. */
const EXIT_MARGIN = 0.3;

/** What the rule reads of giving way's tick. */
export interface ExitScene {
  readonly cars: readonly Car[];
  /** The indices of the cars filed within `r` of a point. */
  carsNear(x: number, y: number, r: number, out: number[]): number[];
}

export class JunctionClear {
  private readonly traffic: AmbientTraffic;
  private readonly scene: ExitScene;
  private readonly cursor: TrafficCursor = { id: 0, step: 0, into: 0 };
  private readonly spot: Footprint = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };
  private readonly pose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  private readonly near: number[] = [];

  constructor(traffic: AmbientTraffic, scene: ExitScene) {
    this.traffic = traffic;
    this.scene = scene;
  }

  /**
   * True when car `i`, which is about to cross the stop line of `edge` at its
   * tour's moment `time`, would find a car standing where it is to stand past
   * the junction.
   */
  blocked(i: number, edge: number, time: number): boolean {
    const car = this.scene.cars[i] as Car;
    if (!this.exitOf(car, edge, time)) return false;
    const spot = this.spot;
    const c = cos(spot.heading);
    const s = sin(spot.heading);
    for (const j of this.scene.carsNear(spot.x, spot.y, spot.halfLength + 8, this.near)) {
      if (j === i) continue;
      const other = this.scene.cars[j] as Car;
      const standing = other.stop || other.speed < STANDING;
      if (standing && turnedTouch(spot, c, s, other.box, other.cos, other.sin, EXIT_MARGIN)) return true;
    }
    return false;
  }

  /** Put where a car will stand once it is past the junction into the spot. False where its tour does not leave the edge soon. */
  private exitOf(car: Car, edge: number, time: number): boolean {
    const traffic = this.traffic;
    const need = 2 * car.box.halfLength + EXIT_ROOM;
    let left = false;
    for (let k = 1; k <= RUN_TRIES; k++) {
      traffic.cursorAt(car.id, time + k * RUN_STEP, this.cursor);
      const at = traffic.edgeOf(this.cursor);
      if (at === edge && !left) continue;
      if (at === edge) return false;
      left = true;
      if (traffic.metresOf(this.cursor) < need) continue;
      const pose = traffic.pose(this.cursor, this.pose);
      const spot = this.spot;
      spot.x = pose.x;
      spot.y = pose.y;
      spot.heading = pose.heading;
      spot.halfLength = car.box.halfLength;
      spot.halfWidth = car.box.halfWidth;
      return true;
    }
    return false;
  }
}
