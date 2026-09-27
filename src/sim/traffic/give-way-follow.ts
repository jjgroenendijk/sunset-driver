/**
 * Following a car through a junction without lights (spec section 13.1,
 * issue #748).
 *
 * Two cars that come into a junction on the same road are not taken to meet
 * (`give-way-junction.ts`), and a car looks for the one ahead of it along a
 * straight lane (`give-way.ts`). A car ahead that turns leaves that lane, and
 * one that turns from the next lane crosses it. The car behind then drove on
 * into the ground the turning car was about to cover, and the two stood on
 * each other at an angle.
 *
 * So a car stops while its next step meets the ground that a car from its own
 * road, further through the junction, covers over the next {@link AHEAD}
 * ticks of its tour.
 */
import { cos, sin } from '../../core/libm.ts';
import type { Car } from './give-way-scene.ts';
import { turnedTouch, type AmbientPose, type AmbientTraffic, type Footprint, type TrafficCursor } from './traffic.ts';

/** Ticks of its tour ahead that a leader's path is read over, and the ticks between two readings of it. */
const AHEAD = 120;
const EVERY = 10;
const SAMPLES = AHEAD / EVERY;

/** Metres a follower keeps from the ground a leader is about to cover. */
const ROOM = 0.3;

/** One reading of a leader's path, with the cosine and sine of its heading. */
interface Sample {
  box: Footprint;
  cos: number;
  sin: number;
}

export class FollowThrough {
  private readonly traffic: AmbientTraffic;
  private readonly cursor: TrafficCursor = { id: 0, step: 0, into: 0 };
  private readonly pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  /** By car index, the readings of its path this tick, or undefined until one is asked for. */
  private paths: (Sample[] | undefined)[] = [];
  private tick = 0;

  constructor(traffic: AmbientTraffic) {
    this.traffic = traffic;
  }

  /** Start a tick with `count` cars in the box. */
  reset(tick: number, count: number): void {
    this.tick = tick;
    this.paths = new Array<Sample[] | undefined>(count);
  }

  /** True when the next step of `car` meets the ground car `j` covers over its next ticks. */
  meets(car: Car, cars: readonly Car[], j: number): boolean {
    const path = this.pathOf(cars, j);
    for (const sample of path) {
      if (turnedTouch(car.next, car.nextCos, car.nextSin, sample.box, sample.cos, sample.sin, ROOM)) return true;
    }
    return false;
  }

  /** The readings of car `j`'s path, read once a tick. */
  private pathOf(cars: readonly Car[], j: number): Sample[] {
    const known = this.paths[j];
    if (known !== undefined) return known;
    const car = cars[j] as Car;
    const path: Sample[] = [];
    for (let k = 1; k <= SAMPLES; k++) {
      this.traffic.cursorAt(car.id, this.tick - car.lag + k * EVERY, this.cursor);
      const pose = this.traffic.pose(this.cursor, this.pose, false);
      const box = { x: pose.x, y: pose.y, heading: pose.heading, halfLength: car.box.halfLength, halfWidth: car.box.halfWidth };
      path.push({ box, cos: cos(pose.heading), sin: sin(pose.heading) });
    }
    this.paths[j] = path;
    return path;
  }
}
