/**
 * Giving way (spec sections 13.1, 20.2): the cars of the traffic and the people
 * of the crowd near the player keep out of each other.
 *
 * Every car and every person follows a loop that is a function of the tick,
 * and no loop reads another. So two cars of one lane can stand on the same
 * ground, and a person can walk through a car. Near the player that is
 * stepped away, one tick at a time, by holding a car or a person back on
 * their loop (`hold.ts`):
 *
 * - A car stops for what stands in the lane ahead of it: another car, a
 *   person, the player, the player's car or a wreck. It slows to half its
 *   pace when the thing is further ahead. Two cars that each stop for the
 *   other would stand forever, so the one with the lower id goes.
 * - A car that is behind its tour may meet a light its tour was timed to pass
 *   on green. It stops at the line when the light is not green. It makes up
 *   the lag at the next place its tour stands still, which it leaves on time.
 * - A person does not step into a car or into the road just ahead of a moving
 *   one. A person a car has stopped for, who would walk into it, steps aside.
 * - A moving car that meets a person all the same hits them. That is the
 *   city's doing and no crime of the player's.
 *
 * Out of the box round the player nothing is held, and a car or a person that
 * leaves the box goes back to their loop's time. The box is wider than the
 * view, so nobody sees that jump.
 */
import { hashInts } from '../core/hash.ts';
import { cos, sin } from '../core/libm.ts';
import { rngFor, Subsystem } from '../core/rng.ts';
import { carDamage, KILL_SPEED, LIFT_MAX, LIFT_SHARE, LIFT_SPEED, SHOVE_SPEED, THROW_SHARE } from './car-strike.ts';
import { hurtPerson, PERSON_HEALTH, type CasualtyGround } from './casualty.ts';
import { TICK_RATE } from './clock.ts';
import { heldTime, holdOf, type Hold } from './hold.ts';
import type { CrowdSource } from './melee.ts';
import { casualtyOf, crowdPoseOf, startledOf, stepAside, type PedestrianPose } from './pedestrians.ts';
import type { SimState } from './simulation.ts';
import { footprintsTouch, promotedOf, type AmbientPose, type AmbientTraffic, type Footprint, type TrafficCursor } from './traffic.ts';
import { headingOf, specOf } from './vehicle.ts';

/** Metres each way of the player that cars give way in. Wider than the traffic's view. */
export const GIVE_WAY_REACH = 200;

/** Metres each way of the player that people give way in. Wider than the crowd's view. */
export const CROWD_REACH = 130;

/** Metres a car leaves in front of it when it stops, bumper to whatever it stopped for. */
export const STOP_GAP = 1.5;

/** Seconds of its speed a car adds to the room it stops in, and to the room it slows over. */
const STOP_TIME = 0.3;
const SLOW_TIME = 1.2;

/** The share of its own width a car looks ahead over, so a car in the next lane is not in the way. */
const LANE_SHARE = 0.8;

/** A car does not stop for one it meets head on: that one is in the other lane. */
const HEAD_ON = -0.5;

/** Ticks a car stands for the player or a wreck before it drives on regardless. */
export const PATIENCE = 12 * TICK_RATE;

/** Ticks a car stands for a person on their loop before they go back the way they came. */
export const BACK_OFF = Math.round(0.5 * TICK_RATE);

/** Ticks a car stands for a person off their loop before they step aside for it. */
export const NUDGE = 3 * TICK_RATE;

/** Metres a person keeps from a car, and seconds of a moving car's speed they keep out of in front of it. */
const PERSON_ROOM = 0.4;
const CROSS_TIME = 0.8;

/** Metres a person counts as round, for a car that looks ahead and for a car that hits them. */
const PERSON_RADIUS = 0.3;

/** Metres more than a person's radius a car keeps from them, so a step of theirs does not meet it. */
const STEP_ROOM = 0.2;

/** Metres per second a car has to be moving at to hit anybody. */
const STRIKE_SPEED = 1;

/** Metres of one bucket of the grid the obstacles are filed in. */
const CELL = 12;

/** Metres a car keeps from the side of another it would drive into. */
const SIDE_ROOM = 0.2;

/** Ticks at a time a car that came in on another is moved back, and how many times at most. */
const BACK_STEP = 20;
const BACK_TRIES = 90;

/** Hops followed along who stops for whom, looking for a ring of cars that each wait for the next. */
const RING_HOPS = 16;

/** The key of the stream a car of the traffic hitting a person draws from. */
const STRIKE_STREAM = 3;

/** What a car stopped for. */
const FREE = -1;
const OTHER = -2;
const PERSON = -3;
const LIGHT = -4;

/**
 * The crowd as giving way reads it. The edge a person walks is optional: with
 * it, the people whose loops pass the box but who are far from it are skipped
 * before their pose is read.
 */
export type Crowd = CrowdSource & {
  edgeAt?(id: number, time: number): number;
  edgeMeets?(edge: number, minX: number, minY: number, maxX: number, maxY: number): boolean;
};

/** Metres the box of candidates is grown by, and snapped to, so it is looked up again only now and then. */
const NEAR_SNAP = 40;

type Near = (minX: number, minY: number, maxX: number, maxY: number, out: number[]) => number[];

/**
 * Whose loop passes near a box, asked of an index only when the box has moved
 * to another snap of the map. The answer is a function of the snap alone, so
 * it is the same in a replay.
 */
class NearCache {
  private key = '';
  private readonly ids: number[] = [];

  of(x: number, y: number, reach: number, near: Near): readonly number[] {
    const sx = Math.floor(x / NEAR_SNAP);
    const sy = Math.floor(y / NEAR_SNAP);
    const key = `${sx},${sy},${reach}`;
    if (key !== this.key) {
      this.key = key;
      const r = reach + NEAR_SNAP;
      near(sx * NEAR_SNAP - r, sy * NEAR_SNAP - r, (sx + 1) * NEAR_SNAP + r, (sy + 1) * NEAR_SNAP + r, this.ids);
    }
    return this.ids;
  }
}

/** One car of the traffic in the box, for one tick. */
interface Car {
  id: number;
  lag: number;
  waited: number;
  box: Footprint;
  speed: number;
  /** What it stops for: the index of a car, or one of the kinds above. */
  blocker: number;
  /** The index of the person it stops for, or -1. */
  person: number;
  stop: boolean;
  slow: boolean;
  /** True when the player, their car or a wreck stands in the lane ahead. */
  facing: boolean;
  next: Footprint;
  nextSpeed: number;
}

/** One person of the crowd in the box, for one tick. */
interface Person {
  id: number;
  /** False for someone off their loop: frightened, they go where the fright takes them. */
  walking: boolean;
  lag: number;
  waited: number;
  x: number;
  y: number;
  height: number;
  nextX: number;
  nextY: number;
  held: boolean;
}

export class GiveWay {
  private readonly traffic: AmbientTraffic;
  private readonly crowd: Crowd | undefined;
  private readonly trafficNear = new NearCache();
  private readonly crowdNear = new NearCache();
  private readonly ids: number[] = [];
  private readonly spare: number[] = [];
  private readonly cursor: TrafficCursor = { id: 0, step: 0, into: 0 };
  private readonly ahead: TrafficCursor = { id: 0, step: 0, into: 0 };
  private readonly pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  private readonly walk: PedestrianPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' };
  private readonly probe: Footprint = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };
  private readonly reach: Footprint = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };
  private cars: Car[] = [];
  /** By index of a person, the car standing for them that has stood longest. */
  private waiting: (Car | undefined)[] = [];
  private people: Person[] = [];
  /** The player, their car and the wrecks: what a car stops for that is not a car of the traffic. */
  private others: Footprint[] = [];
  private carGrid: number[][] = [];
  /** The cars in the order they were placed, while the ones that have just come in are cleared. */
  private filed: number[][] = [];
  /** The cars where they will stand on the next tick, filed by where they stand now. */
  private nextGrid: number[][] = [];
  private readonly near: number[] = [];
  /** Metres the next step of a car or a person reaches at most, which is what the next grid is read round. */
  private nextReach = 0;
  private personGrid: number[][] = [];
  private minX = 0;
  private minY = 0;
  private cols = 0;

  constructor(traffic: AmbientTraffic, crowd?: Crowd) {
    this.traffic = traffic;
    this.crowd = crowd;
  }

  /**
   * Decide the next tick of every car and person in the box round `(x, y)`:
   * who is held and who goes, written into the holds of the record, and who
   * a car of the traffic hits on the way. Called before the physics aims the
   * traffic at the next tick.
   */
  step(state: SimState, x: number, y: number, ground?: CasualtyGround): void {
    this.frame(x, y);
    this.gatherPeople(state);
    this.gatherCars(state);
    this.gatherOthers(state);
    for (const car of this.cars) this.readAhead(state, car);
    for (let i = 0; i < this.cars.length; i++) this.look(state, i);
    this.breakRings();
    this.moveCars(state);
    this.movePeople(state);
    this.strike(state, ground);
  }

  private frame(x: number, y: number): void {
    this.minX = x - GIVE_WAY_REACH;
    this.minY = y - GIVE_WAY_REACH;
    this.cols = Math.ceil((2 * GIVE_WAY_REACH) / CELL) + 1;
    const cells = this.cols * this.cols;
    for (const grid of [this.carGrid, this.personGrid, this.filed, this.nextGrid]) {
      for (let i = 0; i < cells; i++) {
        const cell = grid[i];
        if (cell === undefined) grid[i] = [];
        else cell.length = 0;
      }
    }
  }

  private inBox(x: number, y: number): boolean {
    const max = 2 * GIVE_WAY_REACH;
    return x >= this.minX && x < this.minX + max && y >= this.minY && y < this.minY + max;
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.minX) / CELL)));
    const cy = Math.max(0, Math.min(this.cols - 1, Math.floor((y - this.minY) / CELL)));
    return cy * this.cols + cx;
  }

  /** Every entry of a grid filed within `pad` of a footprint's reach, once each. */
  private around(grid: number[][], box: Footprint, pad: number, out: number[]): number[] {
    out.length = 0;
    const r = box.halfLength + box.halfWidth + pad;
    const cx0 = Math.max(0, Math.floor((box.x - r - this.minX) / CELL));
    const cx1 = Math.min(this.cols - 1, Math.floor((box.x + r - this.minX) / CELL));
    const cy0 = Math.max(0, Math.floor((box.y - r - this.minY) / CELL));
    const cy1 = Math.min(this.cols - 1, Math.floor((box.y + r - this.minY) / CELL));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (const entry of grid[cy * this.cols + cx] as number[]) out.push(entry);
      }
    }
    return out;
  }

  /** Every entry of a grid filed within the next reach of a point. */
  private aroundPoint(grid: number[][], x: number, y: number, out: number[]): number[] {
    out.length = 0;
    const r = this.nextReach;
    const cx0 = Math.max(0, Math.floor((x - r - this.minX) / CELL));
    const cx1 = Math.min(this.cols - 1, Math.floor((x + r - this.minX) / CELL));
    const cy0 = Math.max(0, Math.floor((y - r - this.minY) / CELL));
    const cy1 = Math.min(this.cols - 1, Math.floor((y + r - this.minY) / CELL));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (const entry of grid[cy * this.cols + cx] as number[]) out.push(entry);
      }
    }
    return out;
  }

  /** The people in the box where they stand now. A casualty is not in the way: a car goes over a body. */
  private gatherPeople(state: SimState): void {
    this.people = [];
    const crowd = this.crowd;
    if (crowd === undefined) return;
    const peds = state.pedestrians;
    const x = this.minX + GIVE_WAY_REACH;
    const y = this.minY + GIVE_WAY_REACH;
    const r = CROWD_REACH;
    for (const id of this.crowdNear.of(x, y, r, (a, b, c, d, out) => crowd.near(a, b, c, d, out))) {
      if (peds.casualties.length > 0 && casualtyOf(peds, id) !== undefined) continue;
      if (crowd.edgeAt !== undefined && crowd.edgeMeets !== undefined) {
        const time = heldTime(peds.held, id, state.tick);
        if (!crowd.edgeMeets(crowd.edgeAt(id, time), x - r, y - r, x + r, y + r)) continue;
      }
      const walking = peds.startled.length === 0 || startledOf(peds, id) === undefined;
      if (crowdPoseOf(crowd, peds, id, state.tick, this.walk) === undefined) continue;
      if (Math.abs(this.walk.x - x) > CROWD_REACH || Math.abs(this.walk.y - y) > CROWD_REACH) continue;
      const hold = walking ? holdOf(peds.held, id) : undefined;
      const index = this.people.length;
      this.people.push({
        id,
        walking,
        lag: hold?.lag ?? 0,
        waited: hold?.waited ?? 0,
        x: this.walk.x,
        y: this.walk.y,
        height: this.walk.height,
        nextX: this.walk.x,
        nextY: this.walk.y,
        held: false,
      });
      (this.personGrid[this.cellOf(this.walk.x, this.walk.y)] as number[]).push(index);
    }
  }

  /**
   * The cars of the traffic in the box, where they stand now. A car that has
   * just come into the box may stand on another one: two tours can put two
   * cars on the same ground. It is moved back along its tour until it stands
   * clear, which nobody sees, since it came in at the edge of the box.
   */
  private gatherCars(state: SimState): void {
    this.cars = [];
    const traffic = this.traffic;
    const held = state.traffic.held;
    const max = 2 * GIVE_WAY_REACH;
    const fresh = held.tick !== state.tick;
    const entering: Car[] = [];
    const x = this.minX + GIVE_WAY_REACH;
    const y = this.minY + GIVE_WAY_REACH;
    for (const id of this.trafficNear.of(x, y, GIVE_WAY_REACH, (a, b, c, d, out) => traffic.near(a, b, c, d, out))) {
      if (state.traffic.promoted.length > 0 && promotedOf(state.traffic, id) !== undefined) continue;
      const hold = holdOf(held, id);
      const lag = hold?.lag ?? 0;
      traffic.cursorAt(id, state.tick - lag, this.cursor);
      if (!traffic.edgeMeets(traffic.edgeOf(this.cursor), this.minX, this.minY, this.minX + max, this.minY + max)) continue;
      const pose = traffic.pose(this.cursor, this.pose);
      if (!this.inBox(pose.x, pose.y)) continue;
      const spec = specOf((traffic.vehicles[id] as AmbientTraffic['vehicles'][number]).cls);
      const car: Car = {
        id,
        lag,
        waited: hold?.waited ?? 0,
        box: { x: pose.x, y: pose.y, heading: pose.heading, halfLength: spec.halfLength, halfWidth: spec.halfWidth },
        speed: pose.speed,
        blocker: FREE,
        person: -1,
        stop: false,
        slow: false,
        facing: false,
        next: { x: 0, y: 0, heading: 0, halfLength: spec.halfLength, halfWidth: spec.halfWidth },
        nextSpeed: 0,
      };
      const inside = Math.abs(pose.x - held.x) < GIVE_WAY_REACH && Math.abs(pose.y - held.y) < GIVE_WAY_REACH;
      if (fresh || !inside) entering.push(car);
      else this.file(car);
    }
    for (const car of entering) {
      this.clear(state, car);
      this.file(car);
    }
    // Filed in id order, so a ring of waiting cars is broken the same way in a replay.
    this.cars.sort((a, b) => a.id - b.id);
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i] as Car;
      (this.carGrid[this.cellOf(car.box.x, car.box.y)] as number[]).push(i);
    }
  }

  private file(car: Car): void {
    this.cars.push(car);
    (this.filed[this.cellOf(car.box.x, car.box.y)] as number[]).push(this.cars.length - 1);
  }

  /** Move a car that has come into the box back along its tour until it stands on no other car. */
  private clear(state: SimState, car: Car): void {
    const traffic = this.traffic;
    for (let tries = 0; tries <= BACK_TRIES && this.onAnother(car); tries++) {
      // A car standing at a light has stood there since its wait began, so it goes back to before it.
      traffic.cursorAt(car.id, state.tick - car.lag, this.cursor);
      const wait = waitInto(traffic, this.cursor);
      car.lag += Math.max(BACK_STEP, wait + 1);
      traffic.cursorAt(car.id, state.tick - car.lag, this.cursor);
      const pose = traffic.pose(this.cursor, this.pose);
      car.box.x = pose.x;
      car.box.y = pose.y;
      car.box.heading = pose.heading;
      car.speed = pose.speed;
    }
  }

  private onAnother(car: Car): boolean {
    for (const j of this.around(this.filed, car.box, 8, this.spare)) {
      if (footprintsTouch(car.box, (this.cars[j] as Car).box, STOP_GAP)) return true;
    }
    return false;
  }

  /** The player, the car they drive or left, and the wrecks of the traffic. */
  private gatherOthers(state: SimState): void {
    this.others = [];
    const v = state.vehicle;
    const spec = specOf(v.cls);
    this.others.push({ x: v.x, y: v.z, heading: headingOf(v), halfLength: spec.halfLength, halfWidth: spec.halfWidth });
    if (!state.player.driving) this.others.push({ x: state.player.x, y: state.player.y, heading: 0, halfLength: 0.4, halfWidth: 0.4 });
    for (const record of state.traffic.promoted) {
      const w = record.vehicle;
      if (!this.inBox(w.x, w.z)) continue;
      const s = specOf(w.cls);
      this.others.push({ x: w.x, y: w.z, heading: headingOf(w), halfLength: s.halfLength, halfWidth: s.halfWidth });
    }
  }

  /** Where a car's tour puts it on the next tick if nothing holds it. */
  private readAhead(state: SimState, car: Car): void {
    this.traffic.cursorAt(car.id, state.tick + 1 - car.lag, this.cursor);
    const ahead = this.traffic.pose(this.cursor, this.pose);
    car.next.x = ahead.x;
    car.next.y = ahead.y;
    car.next.heading = ahead.heading;
    car.nextSpeed = ahead.speed;
  }

  /** What stands in the lane ahead of car `i`, and whether it has to stop or slow for it. */
  private look(state: SimState, i: number): void {
    const car = this.cars[i] as Car;
    const box = car.box;
    const stopRoom = STOP_GAP + car.speed * STOP_TIME;
    const slowRoom = stopRoom + car.speed * SLOW_TIME;
    setAhead(this.probe, box, stopRoom);
    setAhead(this.reach, box, slowRoom);
    const fx = cos(box.heading);
    const fy = sin(box.heading);
    const patient = car.waited < PATIENCE;
    // A car coming in from the side, at a junction, is not in the lane ahead:
    // it is the next step that would drive into it, where it stands or where it goes.
    for (const j of this.around(this.carGrid, car.next, 4, this.spare)) {
      if (j === i) continue;
      const other = this.cars[j] as Car;
      if (!close(car.next, other.box, SIDE_ROOM)) continue;
      const into = footprintsTouch(car.next, other.box, SIDE_ROOM) || footprintsTouch(car.next, other.next, SIDE_ROOM);
      if (!into) continue;
      // Two cars already touching may only move apart.
      if (!footprintsTouch(box, other.box, SIDE_ROOM) || apart(car.next, other.box) <= apart(box, other.box)) this.block(car, j);
    }
    for (const j of this.around(this.carGrid, this.reach, 8, this.spare)) {
      if (j === i) continue;
      const other = (this.cars[j] as Car).box;
      if (!close(this.reach, other, 0)) continue;
      if (cos(other.heading) * fx + sin(other.heading) * fy < HEAD_ON) continue;
      if (footprintsTouch(this.probe, other, 0)) this.block(car, j);
      else if (footprintsTouch(this.reach, other, 0)) car.slow = true;
    }
    for (const other of this.others) {
      if (!close(this.reach, other, 0) || !footprintsTouch(this.reach, other, 0)) continue;
      car.facing = true;
      if (!patient) continue;
      if (footprintsTouch(this.probe, other, 0)) this.block(car, OTHER);
      else car.slow = true;
    }
    for (const k of this.around(this.personGrid, this.reach, 1, this.spare)) {
      const person = this.people[k] as Person;
      // In the lane ahead, or where the next step puts the car, which on a corner is not the same.
      const stepped = inside(car.next, person.x, person.y, PERSON_RADIUS + STEP_ROOM);
      if (!stepped && !within(this.reach, fx, fy, person.x, person.y, PERSON_RADIUS)) continue;
      if (stepped || within(this.probe, fx, fy, person.x, person.y, PERSON_RADIUS)) {
        this.block(car, PERSON);
        if (car.person < 0) car.person = k;
      } else car.slow = true;
    }
    if (car.lag > 0 && this.redAhead(state, car)) this.block(car, LIGHT);
  }

  private block(car: Car, by: number): void {
    // A car of the traffic comes first: it is the one a ring of waiting cars is looked for along.
    if (!car.stop || (car.blocker < 0 && by >= 0)) car.blocker = by;
    car.stop = true;
  }

  /** True when a car behind its tour is about to cross a stop line on a light that is not green. */
  private redAhead(state: SimState, car: Car): boolean {
    const signals = this.traffic.signals;
    if (signals === undefined) return false;
    const traffic = this.traffic;
    const time = state.tick - car.lag;
    traffic.cursorAt(car.id, time, this.cursor);
    traffic.cursorAt(car.id, time + 1, this.ahead);
    const edge = traffic.edgeOf(this.cursor);
    const approach = signals.approachOf(edge);
    if (approach === undefined) return false;
    const here = traffic.metresOf(this.cursor);
    const there = traffic.edgeOf(this.ahead) === edge ? traffic.metresOf(this.ahead) : Infinity;
    if (here > approach.stop + 1e-6 || there <= approach.stop + 1e-6) return false;
    return signals.light(approach, state.tick + 1) !== 'green';
  }

  /**
   * Two cars that each stop for the other, or a ring of them, stand forever.
   * In each ring the car with the lowest id goes.
   */
  private breakRings(): void {
    const cars = this.cars;
    const release: number[] = [];
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i] as Car;
      if (!car.stop || car.blocker < 0) continue;
      let lowest = car.id;
      let at = car.blocker;
      let ring = false;
      for (let hop = 0; hop < RING_HOPS && at >= 0; hop++) {
        if (at === i) {
          ring = true;
          break;
        }
        const next = cars[at] as Car;
        if (!next.stop) break;
        lowest = Math.min(lowest, next.id);
        at = next.blocker;
      }
      if (ring && lowest === car.id) release.push(i);
    }
    for (const i of release) {
      const car = cars[i] as Car;
      car.stop = false;
      car.blocker = FREE;
    }
  }

  /** Write the cars' holds for the next tick, and where each will stand on it. */
  private moveCars(state: SimState): void {
    const traffic = this.traffic;
    this.waiting = new Array<Car | undefined>(this.people.length);
    const next = state.tick + 1;
    const list: Hold[] = [];
    for (const car of this.cars) {
      const held = car.stop || (car.slow && next % 2 === 0);
      let lag = car.lag;
      let step = 0;
      if (held) {
        lag += 1;
        step = 1;
      } else if (lag > 0) {
        // Where its tour stands still, it makes up the lag without moving.
        traffic.cursorAt(car.id, next - lag, this.cursor);
        const made = Math.min(lag, traffic.waitLeft(this.cursor));
        lag -= made;
        step = -made;
      }
      // A car out of patience stays out of it while the thing it stood for is still ahead of it.
      const impatient = car.waited >= PATIENCE && car.facing;
      const waited = car.stop && (car.blocker === OTHER || car.blocker === PERSON) ? car.waited + 1 : impatient ? car.waited : 0;
      car.waited = waited;
      if (car.stop && car.blocker === PERSON && car.person >= 0) {
        const was = this.waiting[car.person];
        if (was === undefined || was.waited < waited) this.waiting[car.person] = car;
      }
      if (lag > 0 || step !== 0 || waited > 0) list.push({ id: car.id, lag, step, waited });
      // Moving, it stands where `look` read it ahead; making up lag, it stands still there too.
      if (held) {
        car.next.x = car.box.x;
        car.next.y = car.box.y;
        car.next.heading = car.box.heading;
        car.nextSpeed = 0;
      }
    }
    this.nextReach = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i] as Car;
      (this.nextGrid[this.cellOf(car.next.x, car.next.y)] as number[]).push(i);
      const reach = car.next.halfLength + car.next.halfWidth + PERSON_ROOM + car.nextSpeed * CROSS_TIME;
      this.nextReach = Math.max(this.nextReach, reach);
    }
    state.traffic.held = { tick: next, x: this.minX + GIVE_WAY_REACH, y: this.minY + GIVE_WAY_REACH, list };
  }

  /** Write the people's holds for the next tick: nobody steps into a car. */
  private movePeople(state: SimState): void {
    const crowd = this.crowd;
    const peds = state.pedestrians;
    const next = state.tick + 1;
    if (crowd === undefined) {
      peds.held = { tick: next, x: this.minX + GIVE_WAY_REACH, y: this.minY + GIVE_WAY_REACH, list: [] };
      return;
    }
    const list: Hold[] = [];
    const aside: [Person, Car][] = [];
    for (let k = 0; k < this.people.length; k++) {
      const person = this.people[k] as Person;
      const waiting = this.waiting[k];
      if (!person.walking) {
        // Somebody off their loop standing in a car's way is moved out of it.
        if (waiting !== undefined && waiting.waited >= NUDGE) aside.push([person, waiting]);
        continue;
      }
      crowd.poseAt(person.id, next - person.lag, this.walk);
      person.nextX = this.walk.x;
      person.nextY = this.walk.y;
      const car = this.inWay(person);
      let step = 0;
      if (waiting !== undefined && (waiting.waited >= BACK_OFF || car === waiting) && this.backOff(person, waiting, next)) {
        // A car stands for them: they go back the way they came, off its lane.
        step = 2;
      } else if (car !== undefined) {
        step = 1;
        person.nextX = person.x;
        person.nextY = person.y;
      }
      person.held = step > 0;
      person.lag += step;
      person.waited = step > 0 ? person.waited + 1 : 0;
      if (person.lag > 0) list.push({ id: person.id, lag: person.lag, step, waited: person.waited });
    }
    peds.held = { tick: next, x: this.minX + GIVE_WAY_REACH, y: this.minY + GIVE_WAY_REACH, list };
    for (const [person, car] of aside) {
      // Towards the car's right hand, which is the kerb its lane runs along.
      stepAside(peds, state.tick, person.id, person, car.box.heading + Math.PI / 2);
    }
  }

  /** Walk a person back one tick along their loop, unless that puts them against another car. Answers whether it did. */
  private backOff(person: Person, waiting: Car, next: number): boolean {
    const crowd = this.crowd as Crowd;
    crowd.poseAt(person.id, next - person.lag - 2, this.walk);
    for (const i of this.aroundPoint(this.nextGrid, this.walk.x, this.walk.y, this.near)) {
      const car = this.cars[i] as Car;
      if (car !== waiting && inside(car.next, this.walk.x, this.walk.y, PERSON_RADIUS)) return false;
    }
    person.nextX = this.walk.x;
    person.nextY = this.walk.y;
    return true;
  }

  /**
   * The car a person's next step takes them into, or into the road just
   * ahead of: undefined for none, null for the player's car or a wreck. A
   * person already standing against a car walks on out of it; one standing in
   * the road ahead of it waits there.
   */
  private inWay(person: Person): Car | null | undefined {
    for (const i of this.aroundPoint(this.nextGrid, person.nextX, person.nextY, this.near)) {
      const car = this.cars[i] as Car;
      const box = car.next;
      const dx = person.nextX - box.x;
      const dy = person.nextY - box.y;
      const r = box.halfLength + box.halfWidth + PERSON_ROOM + car.nextSpeed * CROSS_TIME;
      if (dx * dx + dy * dy > r * r) continue;
      if (!this.meets(box, car.nextSpeed, person.nextX, person.nextY)) continue;
      // A car standing for this person waits for them, so they keep clear of its body only.
      if (car.person >= 0 && this.people[car.person] === person && !inside(box, person.nextX, person.nextY, PERSON_RADIUS)) continue;
      // Somebody already against a car walks on only when the step takes them away from it.
      if (!this.meets(box, 0, person.x, person.y) || !away(box, person)) return car;
    }
    if (person.waited >= PATIENCE) return undefined;
    for (const other of this.others) {
      if (!this.meets(other, 0, person.nextX, person.nextY)) continue;
      if (!this.meets(other, 0, person.x, person.y) || !away(other, person)) return null;
    }
    return undefined;
  }

  /** True when a point is within a person's room of a car, or of the road it is about to cover. */
  private meets(box: Footprint, speed: number, x: number, y: number): boolean {
    const fx = cos(box.heading);
    const fy = sin(box.heading);
    const rx = x - box.x;
    const ry = y - box.y;
    const along = rx * fx + ry * fy;
    const across = Math.abs(-rx * fy + ry * fx);
    if (across > box.halfWidth + PERSON_ROOM) return false;
    return along >= -box.halfLength - PERSON_ROOM && along <= box.halfLength + PERSON_ROOM + speed * CROSS_TIME;
  }

  /** A moving car of the traffic hits whoever stands in it on the next tick. */
  private strike(state: SimState, ground: CasualtyGround | undefined): void {
    const crowd = this.crowd;
    if (crowd === undefined) return;
    const peds = state.pedestrians;
    const next = state.tick + 1;
    for (const car of this.cars) {
      if (car.nextSpeed < STRIKE_SPEED) continue;
      const box = car.next;
      for (const k of this.around(this.personGrid, box, 2, this.ids)) {
        const person = this.people[k] as Person;
        // The holds were written for the next tick, so this is where each person will stand on it.
        const pose = crowdPoseOf(crowd, peds, person.id, next, this.walk);
        if (pose === undefined || !inside(box, pose.x, pose.y, PERSON_RADIUS)) continue;
        this.hit(state, crowd, car, person.id, pose, ground);
      }
    }
  }

  private hit(
    state: SimState,
    crowd: CrowdSource,
    car: Car,
    id: number,
    pose: PedestrianPose,
    ground: CasualtyGround | undefined,
  ): void {
    const { x, y, height, heading } = pose;
    const speed = car.nextSpeed;
    const travel = car.next.heading;
    if (speed < SHOVE_SPEED) {
      // At a crawl a car only pushes somebody aside.
      crowd.startle(state.pedestrians, state.tick, x - cos(travel) * 0.05, y - sin(travel) * 0.05, 0.1, 'scatter', this.spare);
      return;
    }
    const rng = rngFor(state.seed, state.tick, Subsystem.Casualties, hashInts(STRIKE_STREAM, id));
    const damage = speed >= KILL_SPEED ? PERSON_HEALTH : carDamage(speed) * rng.range(0.8, 1.2);
    const fast = speed >= LIFT_SPEED;
    const push = speed * (fast ? THROW_SHARE : 0.9);
    const lift = fast ? Math.min(LIFT_MAX, speed * LIFT_SHARE) : 0;
    const dir = travel + rng.range(-0.3, 0.3);
    hurtPerson(state, crowd, id, { x, y, height, heading }, { cause: 'car', damage, dir, push, lift, city: true }, ground);
  }
}

/** Ticks a cursor has stood still for in the wait it is in, or 0 where its step is a drive. */
function waitInto(traffic: AmbientTraffic, cursor: TrafficCursor): number {
  return traffic.isWait(cursor) ? cursor.into : 0;
}

/** The lane ahead of a car's front bumper, `room` metres long. */
function setAhead(out: Footprint, box: Footprint, room: number): void {
  const reach = box.halfLength + room / 2;
  out.x = box.x + cos(box.heading) * reach;
  out.y = box.y + sin(box.heading) * reach;
  out.heading = box.heading;
  out.halfLength = room / 2;
  out.halfWidth = box.halfWidth * LANE_SHARE;
}

/** True when a person's next step takes them further from the middle of a footprint. */
function away(box: Footprint, person: Person): boolean {
  const was = (person.x - box.x) ** 2 + (person.y - box.y) ** 2;
  return (person.nextX - box.x) ** 2 + (person.nextY - box.y) ** 2 > was;
}

/** The square of the distance between the middles of two footprints. */
function apart(a: Footprint, b: Footprint): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/** True when two footprints stand near enough that their boxes may touch. */
function close(a: Footprint, b: Footprint, pad: number): boolean {
  const r = a.halfLength + a.halfWidth + b.halfLength + b.halfWidth + pad;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= r * r;
}

/** True when a point stands within `pad` of a footprint whose heading is `(fx, fy)`. */
function within(box: Footprint, fx: number, fy: number, x: number, y: number, pad: number): boolean {
  const rx = x - box.x;
  const ry = y - box.y;
  return Math.abs(rx * fx + ry * fy) <= box.halfLength + pad && Math.abs(-rx * fy + ry * fx) <= box.halfWidth + pad;
}

/** True when a point stands within `pad` of a footprint. */
function inside(box: Footprint, x: number, y: number, pad: number): boolean {
  const fx = cos(box.heading);
  const fy = sin(box.heading);
  const rx = x - box.x;
  const ry = y - box.y;
  return Math.abs(rx * fx + ry * fy) <= box.halfLength + pad && Math.abs(-rx * fy + ry * fx) <= box.halfWidth + pad;
}
