/**
 * The people's half of giving way (`give-way.ts`): the people of the crowd
 * near the player, who does not step into a car, who walks back out of one's
 * way, who steps off their loop round one (`detour.ts`), and whom a car hits
 * all the same.
 *
 * The cars' half decides first. This half reads where each car stands on the
 * next tick, filed in its own grid, and which car stands for which person.
 */
import type { CasualtyGround } from '../crowd/casualty.ts';
import type { Aside } from '../crowd/crowd-aside.ts';
import { asideOf } from '../crowd/crowd-aside.ts';
import { casualtyOf, crowdPoseOf, startledOf, stepAside, type PedestrianPose } from '../crowd/pedestrians.ts';
import { TICK_RATE } from '../clock.ts';
import type { SimState } from '../simulation.ts';
import type { CrowdSource } from '../weapons/melee.ts';
import { cityHit } from './city-strike.ts';
import { Detours, type DetourScene } from './detour.ts';
import { away, CROSS_TIME, meets, othersBlock, PERSON_ROOM, within, type Other } from './give-way-geometry.ts';
import { Grid, NearCache, type BoxFrame } from './give-way-grid.ts';
import { FREE, OTHER, type Car, type Person } from './give-way-scene.ts';
import { heldTime, holdOf, type Hold } from './hold.ts';

/** Metres each way of the player that people give way in. Wider than the crowd's view. */
const CROWD_REACH = 130;

/** Ticks a person stands for the player or a wreck before they walk on regardless. */
const PATIENCE = 12 * TICK_RATE;

/** Ticks a car stands for a person on their loop before they go back the way they came. */
const BACK_OFF = Math.round(0.5 * TICK_RATE);

/** Ticks a car stands for a person off their loop before they step aside for it. */
const NUDGE = 3 * TICK_RATE;

/** Metres a person counts as round, for a car that looks ahead and for a car that hits them. */
export const PERSON_RADIUS = 0.3;

/** Metres per second a car has to be moving at to hit anybody. */
const STRIKE_SPEED = 1;

/**
 * The crowd as giving way reads it. The edge a person walks is optional: with
 * it, the people whose loops pass the box but who are far from it are skipped
 * before their pose is read.
 */
export type Crowd = CrowdSource & {
  edgeAt?(id: number, time: number): number;
  edgeMeets?(edge: number, minX: number, minY: number, maxX: number, maxY: number): boolean;
};

export class CrowdWay {
  private readonly crowd: Crowd | undefined;
  private readonly frame: BoxFrame;
  private readonly crowdNear = new NearCache();
  private readonly detours: Detours;
  private readonly walk: PedestrianPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' };
  private readonly near: number[] = [];
  private readonly ids: number[] = [];
  private readonly spare: number[] = [];
  /** The people in the box, for this tick. */
  people: Person[] = [];
  /** The people filed where they stand now. */
  readonly grid = new Grid();
  /** The cars where they will stand on the next tick, filed by where they stand now. */
  private readonly nextGrid = new Grid();
  /** Metres the next step of a car reaches at most, which is what the next grid is read round. */
  private nextReach = 0;
  private cars: readonly Car[] = [];
  /** By index of a person, the car standing for them that has stood longest. */
  private waiting: (Car | undefined)[] = [];

  constructor(crowd: Crowd | undefined, frame: BoxFrame, scene: DetourScene) {
    this.crowd = crowd;
    this.frame = frame;
    this.detours = new Detours(scene);
  }

  /** Empty the grids for a box of `cells` buckets. */
  reset(cells: number): void {
    this.grid.reset(cells);
    this.nextGrid.reset(cells);
  }

  /** The people in the box where they stand now. A casualty is not in the way: a car goes over a body. */
  gather(state: SimState): void {
    this.people = [];
    const crowd = this.crowd;
    if (crowd === undefined) return;
    const peds = state.pedestrians;
    const x = this.frame.midX;
    const y = this.frame.midY;
    const r = CROWD_REACH;
    for (const id of this.crowdNear.of(x, y, r, (a, b, c, d, out) => crowd.near(a, b, c, d, out))) {
      if (skipsBox(crowd, state, id, x, y, r)) continue;
      const walking = peds.startled.length === 0 || startledOf(peds, id) === undefined;
      if (crowdPoseOf(crowd, peds, id, state.tick, this.walk) === undefined) continue;
      if (Math.abs(this.walk.x - x) > CROWD_REACH || Math.abs(this.walk.y - y) > CROWD_REACH) continue;
      const hold = walking ? holdOf(peds.held, id) : undefined;
      const aside = walking && peds.aside.length > 0 ? asideOf(peds.aside, id) : undefined;
      const index = this.people.length;
      this.people.push({
        id,
        walking,
        lag: hold?.lag ?? 0,
        waited: hold?.waited ?? 0,
        x: this.walk.x,
        y: this.walk.y,
        height: this.walk.height,
        heading: this.walk.heading,
        dodgeX: aside?.dodgeX ?? 0,
        dodgeY: aside?.dodgeY ?? 0,
        nextX: this.walk.x,
        nextY: this.walk.y,
        held: false,
        by: FREE,
      });
      this.grid.add(this.frame.cellOf(this.walk.x, this.walk.y), index);
    }
  }

  /** Start reading the cars' decisions of this tick: nobody stands for anybody yet. */
  begin(cars: readonly Car[]): void {
    this.cars = cars;
    this.waiting = new Array<Car | undefined>(this.people.length);
  }

  /** File a car standing for a person as the one standing for them, where it has stood longest. */
  noteWaiting(car: Car): void {
    const was = this.waiting[car.person];
    if (was === undefined || was.waited < car.waited) this.waiting[car.person] = car;
  }

  /** File every car where it will stand on the next tick, once the cars have been decided. */
  fileNext(): void {
    this.nextReach = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i] as Car;
      this.nextGrid.add(this.frame.cellOf(car.next.x, car.next.y), i);
      const reach = car.next.halfLength + car.next.halfWidth + PERSON_ROOM + car.nextSpeed * CROSS_TIME;
      this.nextReach = Math.max(this.nextReach, reach);
    }
  }

  /** Write the people's holds for the next tick: nobody steps into a car. `others` are what else a person keeps out of. */
  move(state: SimState, others: readonly Other[]): void {
    const crowd = this.crowd;
    const peds = state.pedestrians;
    const next = state.tick + 1;
    const frame = this.frame;
    if (crowd === undefined) {
      peds.held = { tick: next, x: frame.midX, y: frame.midY, list: [] };
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
      person.nextX = this.walk.x + person.dodgeX;
      person.nextY = this.walk.y + person.dodgeY;
      const step = this.stepOf(person, waiting, next, peds.aside, others);
      person.held = step > 0;
      person.lag += step;
      person.waited = step > 0 ? person.waited + 1 : 0;
      if (person.lag > 0) list.push({ id: person.id, lag: person.lag, step, waited: person.waited });
    }
    peds.held = { tick: next, x: frame.midX, y: frame.midY, list };
    for (const [person, car] of aside) {
      // Towards the car's right hand, which is the kerb its lane runs along.
      stepAside(peds, state.tick, person.id, person, car.box.heading + Math.PI / 2);
    }
  }

  /**
   * How many ticks a person on their loop falls back on the next tick: 2 when
   * a car stands for them and they go back the way they came, off its lane; 1
   * when their next step takes them into a car and they stand; else 0.
   */
  private stepOf(person: Person, waiting: Car | undefined, next: number, aside: Aside[], others: readonly Other[]): number {
    const car = this.inWay(person, others);
    person.by = this.blockerOf(car);
    // Stepping off their loop, out of a car's path or round what stands in their way, they need not walk back.
    const off = this.detours.plan(aside, person, waiting);
    if (off && car === undefined) return 0;
    if (!off && waiting !== undefined && (waiting.waited >= BACK_OFF || car === waiting) && this.backOff(person, waiting, next)) return 2;
    if (car === undefined) return 0;
    person.nextX = person.x;
    person.nextY = person.y;
    return 1;
  }

  /** What a person stands for, as {@link Person.by} names it, from what {@link inWay} answered. */
  private blockerOf(car: Car | null | undefined): number {
    if (car === undefined) return FREE;
    if (car === null) return OTHER;
    return this.cars.indexOf(car);
  }

  /** Walk a person back one tick along their loop, unless that puts them against another car. Answers whether it did. */
  private backOff(person: Person, waiting: Car, next: number): boolean {
    const crowd = this.crowd as Crowd;
    crowd.poseAt(person.id, next - person.lag - 2, this.walk);
    const x = this.walk.x + person.dodgeX;
    const y = this.walk.y + person.dodgeY;
    for (const i of this.frame.around(this.nextGrid, x, y, this.nextReach, this.near)) {
      const car = this.cars[i] as Car;
      if (car !== waiting && within(car.next, car.nextCos, car.nextSin, x, y, PERSON_RADIUS)) return false;
    }
    person.nextX = x;
    person.nextY = y;
    return true;
  }

  /**
   * The car a person's next step takes them into, or into the road just
   * ahead of: undefined for none, null for the player's car or a wreck. A
   * person already standing against a car walks on out of it; one standing in
   * the road ahead of it waits there.
   */
  private inWay(person: Person, others: readonly Other[]): Car | null | undefined {
    for (const i of this.frame.around(this.nextGrid, person.nextX, person.nextY, this.nextReach, this.near)) {
      const car = this.cars[i] as Car;
      const box = car.next;
      const dx = person.nextX - box.x;
      const dy = person.nextY - box.y;
      const r = box.halfLength + box.halfWidth + PERSON_ROOM + car.nextSpeed * CROSS_TIME;
      if (dx * dx + dy * dy > r * r) continue;
      const fx = car.nextCos;
      const fy = car.nextSin;
      if (!meets(box, fx, fy, car.nextSpeed, person.nextX, person.nextY)) continue;
      // A car standing for this person waits for them, so they keep clear of its body only.
      if (car.person >= 0 && this.people[car.person] === person && !within(box, fx, fy, person.nextX, person.nextY, PERSON_RADIUS)) continue;
      // Somebody already against a car walks on only when the step takes them away from it.
      if (!meets(box, fx, fy, 0, person.x, person.y) || !away(box, person)) return car;
    }
    if (person.waited >= PATIENCE) return undefined;
    return othersBlock(others, person) ? null : undefined;
  }

  /** A moving car of the traffic hits whoever stands in it on the next tick. */
  strike(state: SimState, ground: CasualtyGround | undefined): void {
    const crowd = this.crowd;
    if (crowd === undefined) return;
    const peds = state.pedestrians;
    const next = state.tick + 1;
    for (const car of this.cars) {
      if (car.nextSpeed < STRIKE_SPEED) continue;
      const box = car.next;
      for (const k of this.frame.around(this.grid, box.x, box.y, box.halfLength + box.halfWidth + 2, this.ids)) {
        const person = this.people[k] as Person;
        // The holds were written for the next tick, so this is where each person will stand on it.
        const pose = crowdPoseOf(crowd, peds, person.id, next, this.walk);
        if (pose === undefined || !within(box, car.nextCos, car.nextSin, pose.x, pose.y, PERSON_RADIUS)) continue;
        cityHit(state, crowd, car.nextSpeed, car.next.heading, person.id, pose, ground, this.spare);
      }
    }
  }
}

/**
 * True for a person giving way leaves out before their pose is read: a
 * casualty, or somebody whose walk is on an edge far from the box of reach `r`
 * round `(x, y)`.
 */
function skipsBox(crowd: Crowd, state: SimState, id: number, x: number, y: number, r: number): boolean {
  const peds = state.pedestrians;
  if (peds.casualties.length > 0 && casualtyOf(peds, id) !== undefined) return true;
  if (crowd.edgeAt === undefined || crowd.edgeMeets === undefined) return false;
  const time = heldTime(peds.held, id, state.tick);
  return !crowd.edgeMeets(crowd.edgeAt(id, time), x - r, y - r, x + r, y + r);
}
