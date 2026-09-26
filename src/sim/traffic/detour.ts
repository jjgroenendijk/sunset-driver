/**
 * People of the crowd stepping off their loop to keep the street moving
 * (spec sections 13.1 and 20.1).
 *
 * A person's loop is a function of the tick, and it does not know the cars.
 * Giving way (`give-way.ts`) holds a person back while a car would hit them.
 * That leaves two ways to stand for ever: a car that waits for somebody
 * standing still in its path, who waits there in their own plan, and somebody
 * whose way a thing standing still blocks — the player's car left on a
 * crossing, a wreck, a car queued over the zebra. Both are answered here by a
 * step off the loop, in metres east and north, kept in the person's
 * `Aside` record (`crowd-aside.ts`):
 *
 * - Somebody a car waits for steps out of its path, to the side of it they
 *   already stand on, or to the other side where that is blocked.
 * - Somebody whose next step meets something standing still walks round it,
 *   on the side that takes them least far off their line.
 * - Somebody who has stepped off stays off while what they walked round is
 *   still beside them, and walks back once it is not.
 *
 * `make-way.ts` walks the step at a person's pace, so nobody jumps.
 */
import { cos, hypot, sin } from '../../core/libm.ts';
import { wantDodge, type Aside } from '../crowd/crowd-aside.ts';
import { FREE, OTHER, STANDING, type Car, type Person } from './give-way-scene.ts';
import { within, type Other } from './give-way-geometry.ts';
import type { Footprint } from './traffic.ts';

/** Metres more than a car's half width a person steps off its middle, out of its path. */
const CLEAR_OF_CAR = 0.9;

/** Metres a person keeps from the side of what they walk round. */
const ROUND_ROOM = 0.5;

/** Metres a person steps off their loop at most. */
const DODGE_MOST = 3;

/** Metres a person counts as round, when a place is checked for somebody to stand on. */
const BODY = 0.35;

/** What a detour reads of the tick giving way is deciding. */
export interface DetourScene {
  readonly cars: readonly Car[];
  readonly others: readonly Other[];
  /** The indices of the cars filed within `r` of a point. */
  carsNear(x: number, y: number, r: number, out: number[]): number[];
}

export class Detours {
  private readonly scene: DetourScene;
  private readonly near: number[] = [];

  constructor(scene: DetourScene) {
    this.scene = scene;
  }

  /**
   * Decide where person `person` wants to stand off their loop on the next
   * tick, and ask for it in `list`. `waiting` is the car that stands for them,
   * if any; `person.by` is what their own next step meets. Answers true when
   * they were asked to step off.
   */
  plan(list: Aside[], person: Person, waiting: Car | undefined): boolean {
    if (waiting !== undefined && this.outOfPath(list, person, waiting)) return true;
    if (person.by !== FREE && this.round(list, person)) return true;
    if ((person.dodgeX !== 0 || person.dodgeY !== 0) && this.stillBeside(person)) {
      wantDodge(list, person.id, person.dodgeX, person.dodgeY);
      return true;
    }
    return false;
  }

  /** Step a person out of the path of the car that waits for them. */
  private outOfPath(list: Aside[], person: Person, car: Car): boolean {
    const rightX = -car.sin;
    const rightY = car.cos;
    const across = (person.x - car.box.x) * rightX + (person.y - car.box.y) * rightY;
    const clear = car.box.halfWidth + CLEAR_OF_CAR;
    if (Math.abs(across) >= clear) return false;
    const first = across >= 0 ? 1 : -1;
    for (const side of [first, -first]) {
      const need = side * clear - across;
      const x = person.dodgeX + rightX * need;
      const y = person.dodgeY + rightY * need;
      if (hypot(x, y) > DODGE_MOST) continue;
      if (this.taken(person.x + rightX * need, person.y + rightY * need, car)) continue;
      wantDodge(list, person.id, x, y);
      return true;
    }
    return false;
  }

  /** Walk a person round the car or other thing standing still that their next step meets. */
  private round(list: Aside[], person: Person): boolean {
    const box = this.blockerOf(person);
    if (box === undefined) return false;
    const c = cos(person.heading);
    const s = sin(person.heading);
    // The blocker's reach across the person's line, from where they stand.
    const dx = box.x - person.x;
    const dy = box.y - person.y;
    const across = -dx * s + dy * c;
    const bc = cos(box.heading);
    const bs = sin(box.heading);
    const reach = Math.abs(-bc * s + bs * c) * box.halfLength + Math.abs(bc * c + bs * s) * box.halfWidth + ROUND_ROOM;
    const right = across + reach;
    const left = across - reach;
    const was = -person.dodgeX * s + person.dodgeY * c;
    for (const need of sidesOf(was, right, left)) {
      const x = person.dodgeX - s * need;
      const y = person.dodgeY + c * need;
      if (hypot(x, y) > DODGE_MOST) continue;
      if (this.taken(person.x - s * need, person.y + c * need, undefined)) continue;
      wantDodge(list, person.id, x, y);
      return true;
    }
    return false;
  }

  /** The footprint a person's next step meets when it stands still, or undefined for one that moves. */
  private blockerOf(person: Person): Footprint | undefined {
    if (person.by === OTHER) {
      for (const other of this.scene.others) {
        if (Math.abs(other.speed) < STANDING && within(other, other.cos, other.sin, person.nextX, person.nextY, 1)) return other;
      }
      return undefined;
    }
    const car = this.scene.cars[person.by];
    return car !== undefined && car.nextSpeed < STANDING ? car.box : undefined;
  }

  /** True while something standing still is still beside the place a person stepped off from. */
  private stillBeside(person: Person): boolean {
    return this.taken(person.x - person.dodgeX, person.y - person.dodgeY, undefined);
  }

  /** True when a person could not stand at `(x, y)`: a car, the player, their car or a wreck is there. */
  private taken(x: number, y: number, skip: Car | undefined): boolean {
    const scene = this.scene;
    for (const i of scene.carsNear(x, y, 8, this.near)) {
      const car = scene.cars[i] as Car;
      if (car === skip) continue;
      if (within(car.box, car.cos, car.sin, x, y, BODY) || within(car.next, car.nextCos, car.nextSin, x, y, BODY)) return true;
    }
    for (const other of scene.others) {
      if (within(other, other.cos, other.sin, x, y, BODY)) return true;
    }
    return false;
  }
}

/**
 * The sides a person tries to walk round something on, in order, as metres
 * right of where they stand: the side they already stepped to, where they
 * stepped at all, else the nearer side first.
 */
function sidesOf(was: number, right: number, left: number): number[] {
  if (was > 0) return [right];
  if (was < 0) return [left];
  return Math.abs(right) <= Math.abs(left) ? [right, left] : [left, right];
}
