/**
 * A car of the traffic steering round what stands in its lane (spec sections
 * 13.1 and 20.2): the player's car left in the street, a wreck, a police car
 * at a stop, the player on foot, or a car that stands facing it.
 *
 * A car that has stood behind such a thing for {@link START} picks a side to
 * pass it on: the one that takes it least far off its lane and that the
 * carriageway has room for, which on a two-way road may be the oncoming half.
 * It keeps that side once chosen, so it never dithers. It sets off only when
 * the ground it passes over is clear, with every car near it run on
 * {@link PASS_TIME} at its speed, so a car coming the other way has room. It
 * then creeps out, slower than its tour, turned towards where it steers,
 * passes, and steers back into its lane once the lane beside it is clear.
 *
 * What the swerve moves is the car's side: metres right of its lane, stored in
 * its hold (`hold.ts`) and read by every reader of its pose through
 * `heldPose`. A car that finds no side with room stands and waits. It never
 * drives into what is in its way.
 */
import { cos, sin } from '../../core/libm.ts';
import { TICK_RATE } from '../clock.ts';
import { HEAD_ON, STANDING, sideOf, type Car, type Person } from './give-way-scene.ts';
import { within, type Other } from './give-way-geometry.ts';
import type { Swerve } from './hold.ts';
import { turnedTouch, type Footprint, type Kerbs } from './traffic.ts';

/** Metres ahead of its front bumper a car steers round something standing in its lane. */
const LOOK = 12;

/** Metres behind its rear bumper something it passes still counts as beside it. */
const PAST = 1.5;

/** Metres a car keeps from the side of what it passes, and from a kerb. */
const ROOM = 0.6;
const KERB = 0.3;

/** Ticks a car stands behind something before it will put two wheels on the pavement to pass it. */
const MOUNT_WAIT = 4 * TICK_RATE;

/** Metres off its lane a car steers at most: two lanes over. */
const SWERVE_MOST = 7;

/** Ticks a car stands behind something before it steers round it. */
const START = TICK_RATE;

/** Metres a car moves sideways in a tick while it creeps, and per metre it moves on. */
const CREEP = 1.2 / TICK_RATE;
const RATE = 0.35;

/** Radians a swerving car turns towards where it steers at most, per metre still to go, and per tick. */
const YAW_MOST = 0.3;
const YAW_GAIN = 0.2;
const YAW_PACE = 0.8 / TICK_RATE;

/** Seconds a pass takes at most: every car near is run on this far before a car sets off. */
const PASS_TIME = 4;

/** Seconds a car coming up is run on before a car steers back into its lane in front of it. */
const BACK_TIME = 2;

/** Metres behind its rear bumper a car looks for one coming up in the lane it steers into. */
const BEHIND = 8;

/** Metres more than a car's width either side of it the ground it passes over must be clear. */
const CLEAR = 0.3;

/** What steering reads of the tick giving way is deciding. */
export interface SwerveScene {
  readonly cars: readonly Car[];
  readonly people: readonly Person[];
  readonly others: readonly Other[];
  /** The indices of the cars filed within `r` of a point. */
  carsNear(x: number, y: number, r: number, out: number[]): number[];
  /** The indices of the people filed within `r` of a point. */
  peopleNear(x: number, y: number, r: number, out: number[]): number[];
  /** Where the kerbs of a car's carriageway stand, right of the middle of its lane. */
  kerbs(car: Car, out: Kerbs): Kerbs;
  /** True where a car stands short of a stop line whose light is not green: it queues, it does not pass. */
  queuedAtRed(car: Car): boolean;
}

/** A footprint's reach along a car's lane and across it, from the middle of the lane where the car stands. */
interface Span {
  a0: number;
  a1: number;
  c0: number;
  c1: number;
}

/** A stretch of a car's lane: from `a0` to `a1` metres along it, and from `lo` to `hi` metres right of its middle. */
interface Band {
  a0: number;
  a1: number;
  lo: number;
  hi: number;
}

/** What stands in a car's lane ahead of it, across the lane. Empty while `lo > hi`. */
interface Blocking {
  lo: number;
  hi: number;
  /** Metres along the lane its far end reaches. */
  end: number;
  /** True when a car facing this one is part of it. */
  headOn: boolean;
}

export class Steering {
  private readonly scene: SwerveScene;
  private readonly span: Span = { a0: 0, a1: 0, c0: 0, c1: 0 };
  private readonly blocking: Blocking = { lo: 0, hi: 0, end: 0, headOn: false };
  private readonly kerbs: Kerbs = { left: 0, right: 0, pavement: 0 };
  private readonly moved: Footprint = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };
  private readonly near: number[] = [];
  /** A person as a footprint: a small square about where they stand. */
  private readonly body: Footprint = { x: 0, y: 0, heading: 0, halfLength: 0.3, halfWidth: 0.3 };

  constructor(scene: SwerveScene) {
    this.scene = scene;
  }

  /**
   * Decide the swerve of car `i` for the next tick: which side it steers to,
   * how far it gets there, and whether it slows while it does. Called after
   * giving way has looked ahead of every car, so `stop` says whether the car
   * is held, and before a ring of waiting cars is broken.
   */
  steer(i: number): void {
    const car = this.scene.cars[i] as Car;
    const side = sideOf(car);
    const was = car.swerve;
    const blocking = this.blockingOf(i, side);
    const blocked = blocking.lo <= blocking.hi;
    let aim = side;
    let waited = blocked ? (was?.blocked ?? 0) + 1 : 0;
    if (blocked) {
      const chosen = this.aimPast(car, blocking, was?.aim ?? 0, waited >= MOUNT_WAIT);
      const committed = was !== undefined && was.aim !== 0 && Math.sign(was.aim) === Math.sign(chosen ?? 0);
      const ready = committed || (waited >= START && !this.scene.queuedAtRed(car));
      if (chosen !== undefined && ready && (committed || this.clear(i, chosen, -car.box.halfLength - BEHIND, blocking.end + car.box.halfLength + 2, PASS_TIME))) {
        aim = chosen;
        waited = 0;
      }
    } else if (side !== 0 && this.clear(i, 0, -car.box.halfLength - PAST, car.box.halfLength + 6, BACK_TIME)) {
      aim = 0;
    }
    this.move(i, side, aim, waited, blocked);
  }

  /** Move car `i` a tick sideways towards `aim`, where the step touches nothing, and turn it to face the way it steers. */
  private move(i: number, side: number, aim: number, waited: number, blocked: boolean): void {
    const car = this.scene.cars[i] as Car;
    const forward = car.stop ? 0 : car.nextSpeed / TICK_RATE;
    const most = Math.max(CREEP, RATE * forward);
    let next = side + Math.max(-most, Math.min(most, aim - side));
    if (Math.abs(aim - next) < 1e-3) next = aim;
    const yaw = car.swerve?.yaw ?? 0;
    const want = Math.max(-YAW_MOST, Math.min(YAW_MOST, (aim - next) * YAW_GAIN));
    let turned = yaw + Math.max(-YAW_PACE, Math.min(YAW_PACE, want - yaw));
    if (Math.abs(turned) < 1e-4) turned = 0;
    // A step sideways or a turn that would put a corner against something is not taken.
    if ((next !== side || turned !== yaw) && this.stepTouches(i, next - side, turned - yaw)) {
      next = side;
      turned = yaw;
    }
    const drift = next - side;
    // Its next footprint was read at the old side: carry it over.
    shift(car.next, car.laneCos, car.laneSin, drift, turned - yaw);
    car.nextCos = cos(car.next.heading);
    car.nextSin = sin(car.next.heading);
    // Out in the road beside what it passes, it goes at half its pace.
    if (blocked && aim !== next) car.slow = true;
    const still = next === 0 && aim === 0 && turned === 0 && waited === 0 && drift === 0;
    car.swerve = still ? undefined : ({ side: next, aim, drift, yaw: turned, blocked: waited } satisfies Swerve);
  }

  /** What stands still in car `i`'s lane, or in the ground it now stands on, within {@link LOOK} ahead of it. */
  private blockingOf(i: number, side: number): Blocking {
    const scene = this.scene;
    const car = scene.cars[i] as Car;
    const out = this.blocking;
    out.lo = Infinity;
    out.hi = -Infinity;
    out.end = -Infinity;
    out.headOn = false;
    for (const other of scene.others) {
      if (Math.abs(other.speed) < STANDING) this.take(car, side, other, other.cos, other.sin, false);
    }
    // Somebody standing in the road: at a kerb corner a turn cuts, or stopped on a crossing.
    const person = this.body;
    for (const k of scene.peopleNear(car.laneX, car.laneY, car.box.halfLength + LOOK, this.near)) {
      const standing = scene.people[k] as Person;
      if (standing.speed >= STANDING) continue;
      person.x = standing.x;
      person.y = standing.y;
      this.take(car, side, person, 1, 0, false);
    }
    const reach = car.box.halfLength + LOOK;
    const x = car.laneX + car.laneCos * (LOOK / 2);
    const y = car.laneY + car.laneSin * (LOOK / 2);
    for (const j of scene.carsNear(x, y, reach, this.near)) {
      if (j === i) continue;
      const other = scene.cars[j] as Car;
      // A car facing this one that stands in its lane: it waits there, and has to be passed.
      const facing = other.cos * car.laneCos + other.sin * car.laneSin < HEAD_ON;
      if (facing && other.stop && other.speed < STANDING) this.take(car, side, other.box, other.cos, other.sin, true);
    }
    return out;
  }

  /** Add one thing standing near a car to what blocks it, where it stands in the car's lane or path. */
  private take(car: Car, side: number, box: Footprint, c: number, s: number, headOn: boolean): void {
    const span = spanOf(car, box, c, s, this.span);
    const w = car.box.halfWidth + ROOM;
    const hl = car.box.halfLength;
    if (span.a1 < -hl - PAST || span.a0 > hl + LOOK) return;
    const inLane = span.c1 > -w && span.c0 < w;
    const inPath = span.c1 > side - w && span.c0 < side + w;
    if (!inLane && !inPath) return;
    const out = this.blocking;
    out.lo = Math.min(out.lo, span.c0);
    out.hi = Math.max(out.hi, span.c1);
    out.end = Math.max(out.end, span.a1);
    out.headOn ||= headOn;
  }

  /**
   * The side a car passes what blocks it at, or undefined where the
   * carriageway has no room either side. It keeps a side it already chose;
   * past a car facing it, it keeps right; else the nearer side wins.
   */
  private aimPast(car: Car, blocking: Blocking, chosen: number, mount: boolean): number | undefined {
    const kerbs = this.scene.kerbs(car, this.kerbs);
    const w = car.box.halfWidth;
    const right = Math.max(0, blocking.hi + w + ROOM);
    const left = Math.min(0, blocking.lo - w - ROOM);
    // Out of patience, a car puts its outer wheels up on the pavement: its middle may reach the kerb.
    const over = mount ? Math.min(kerbs.pavement, w) : 0;
    const canRight = right > 0 && right <= Math.min(SWERVE_MOST, kerbs.right + over - w - KERB);
    const canLeft = left < 0 && left >= Math.max(-SWERVE_MOST, kerbs.left - over + w + KERB);
    if (chosen > 0 && canRight) return right;
    if (chosen < 0 && canLeft) return left;
    if (blocking.headOn && canRight) return right;
    if (canRight && (!canLeft || right <= -left)) return right;
    return canLeft ? left : undefined;
  }

  /**
   * True when the ground car `i` would stand on at `side`, from `a0` to `a1`
   * metres along its lane, is clear: of every car near it where each stands
   * and where it will stand over `seconds` at its speed, of the people, and of
   * anything else moving. What stands still there is what it passes.
   */
  private clear(i: number, side: number, a0: number, a1: number, seconds: number): boolean {
    const car = this.scene.cars[i] as Car;
    const band: Band = { a0, a1, lo: side - car.box.halfWidth - CLEAR, hi: side + car.box.halfWidth + CLEAR };
    return this.carsClear(i, band, seconds) && this.othersClear(car, band) && this.peopleClear(car, band);
  }

  /** True when no car near car `i` stands in a band of its lane, now or over `seconds` at its speed. */
  private carsClear(i: number, band: Band, seconds: number): boolean {
    const scene = this.scene;
    const car = scene.cars[i] as Car;
    const moved = this.moved;
    const reach = Math.max(Math.abs(band.a0), Math.abs(band.a1)) + 20 * seconds;
    for (const j of scene.carsNear(car.laneX, car.laneY, reach, this.near)) {
      if (j === i) continue;
      const other = scene.cars[j] as Car;
      moved.heading = other.box.heading;
      moved.halfLength = other.box.halfLength;
      moved.halfWidth = other.box.halfWidth;
      const speed = other.stop ? 0 : other.speed;
      // One standing behind it the same way round queues behind it, and follows it out.
      const following = other.cos * car.laneCos + other.sin * car.laneSin > 0 && speed < STANDING;
      if (following && spanOf(car, other.box, other.cos, other.sin, this.span).a1 < -car.box.halfLength + 0.5) continue;
      for (let k = 0; k <= 3; k++) {
        const run = (speed * seconds * k) / 3;
        moved.x = other.box.x + other.cos * run;
        moved.y = other.box.y + other.sin * run;
        if (inBand(spanOf(car, moved, other.cos, other.sin, this.span), band)) return false;
      }
    }
    return true;
  }

  /** True when none of the player, their car, the wrecks and the units stands in a band of a car's lane. */
  private othersClear(car: Car, band: Band): boolean {
    for (const other of this.scene.others) {
      if (inBand(spanOf(car, other, other.cos, other.sin, this.span), band)) return false;
    }
    return true;
  }

  /** True when nobody of the crowd stands in a band of a car's lane. */
  private peopleClear(car: Car, band: Band): boolean {
    const scene = this.scene;
    for (const k of scene.peopleNear(car.laneX, car.laneY, Math.max(Math.abs(band.a0), Math.abs(band.a1)), this.near)) {
      const person = scene.people[k] as Person;
      const dx = person.x - car.laneX;
      const dy = person.y - car.laneY;
      const along = dx * car.laneCos + dy * car.laneSin;
      const across = -dx * car.laneSin + dy * car.laneCos;
      if (along > band.a0 && along < band.a1 && across > band.lo && across < band.hi) return false;
    }
    return true;
  }

  /** True when moving car `i` `drift` metres sideways where it stands puts it against a car, another or a person. */
  private stepTouches(i: number, drift: number, turn: number): boolean {
    const scene = this.scene;
    const car = scene.cars[i] as Car;
    if (this.touchesAny(i, car.box, car.cos, car.sin)) return false;
    const moved = this.moved;
    moved.x = car.box.x - car.laneSin * drift;
    moved.y = car.box.y + car.laneCos * drift;
    moved.heading = car.box.heading + turn;
    moved.halfLength = car.box.halfLength;
    moved.halfWidth = car.box.halfWidth;
    return this.touchesAny(i, moved, cos(moved.heading), sin(moved.heading));
  }

  private touchesAny(i: number, box: Footprint, c: number, s: number): boolean {
    const scene = this.scene;
    for (const j of scene.carsNear(box.x, box.y, box.halfLength + 8, this.near)) {
      if (j === i) continue;
      const other = scene.cars[j] as Car;
      if (turnedTouch(box, c, s, other.box, other.cos, other.sin, 0.1)) return true;
    }
    for (const other of scene.others) {
      if (turnedTouch(box, c, s, other, other.cos, other.sin, 0.25)) return true;
    }
    for (const k of scene.peopleNear(box.x, box.y, box.halfLength + 2, this.near)) {
      const person = scene.people[k] as Person;
      if (within(box, c, s, person.x, person.y, 0.4)) return true;
    }
    return false;
  }
}

/** A footprint's reach along a car's lane and across it, measured from the middle of the lane where the car stands. */
function spanOf(car: Car, box: Footprint, c: number, s: number, out: Span): Span {
  const dx = box.x - car.laneX;
  const dy = box.y - car.laneY;
  const along = dx * car.laneCos + dy * car.laneSin;
  const across = -dx * car.laneSin + dy * car.laneCos;
  const dot = Math.abs(c * car.laneCos + s * car.laneSin);
  const cross = Math.abs(-c * car.laneSin + s * car.laneCos);
  const reachAlong = dot * box.halfLength + cross * box.halfWidth;
  const reachAcross = cross * box.halfLength + dot * box.halfWidth;
  out.a0 = along - reachAlong;
  out.a1 = along + reachAlong;
  out.c0 = across - reachAcross;
  out.c1 = across + reachAcross;
  return out;
}

/** True when a span reaches into a band. */
function inBand(span: Span, band: Band): boolean {
  return span.a1 > band.a0 && span.a0 < band.a1 && span.c1 > band.lo && span.c0 < band.hi;
}

/** Move a footprint `drift` metres right of a lane heading along `(c, s)`, and turn it by `turn`. */
function shift(box: Footprint, c: number, s: number, drift: number, turn: number): void {
  box.x -= s * drift;
  box.y += c * drift;
  box.heading += turn;
}
