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
 *   person, the player, the player's car, a wreck, or a police car, fire
 *   engine or ambulance. It slows to half its
 *   pace when the thing is further ahead. Two cars that each stop for the
 *   other would stand forever, so the one with the lower id goes.
 * - A car that is behind its tour may meet a light its tour was timed to pass
 *   on green. It stops at the line when the light is not green. It makes up
 *   the lag at the next place its tour stands still, which it leaves on time.
 * - At a junction without lights a car waits at the mouth while another
 *   car's path through it comes first (`give-way-junction.ts`).
 * - A person does not step into a car or into the road just ahead of a moving
 *   one. A person a car has stopped for, who would walk into it, steps aside.
 * - A moving car that meets a person all the same hits them. That is the
 *   city's doing and no crime of the player's.
 *
 * Out of the box round the player nothing is held, and a car or a person that
 * leaves the box goes back to their loop's time. The box is wider than the
 * view, so nobody sees that jump.
 */
import { cos, hypot, sin } from '../../core/libm.ts';
import type { CasualtyGround } from '../crowd/casualty.ts';
import { UNIT_BODY } from '../city/emergency.ts';
import { BoxFrame, Grid, NearCache } from './give-way-grid.ts';
import { apart, close, crossesStop, setAhead, within, type Other } from './give-way-geometry.ts';
import { CrowdWay, PERSON_RADIUS, type Crowd } from './give-way-people.ts';
import { holdOf, type Hold } from './hold.ts';
import { FREE, HEAD_ON, LIGHT, OTHER, PERSON, sideOf, STANDING, type Car, type Person } from './give-way-scene.ts';
import { Steering } from './swerve.ts';
import { JunctionClear } from './junction-clear.ts';
import { JunctionYield } from './give-way-junction.ts';
import { Rejoin } from './rejoin.ts';
import type { SimState } from '../simulation.ts';
import { footprintsTouch, promotedOf, turnedTouch, type AmbientPose, type AmbientTraffic, type Footprint, type Kerbs, type TrafficCursor } from './traffic.ts';
import { headingOf, specOf } from '../vehicles/vehicle.ts';

/** Metres each way of the player that cars give way in. Wider than the traffic's view. */
const GIVE_WAY_REACH = 200;

/** Metres a car leaves in front of it when it stops, bumper to whatever it stopped for. */
const STOP_GAP = 1.5;

/** Seconds of its speed a car adds to the room it stops in, and to the room it slows over. */
const STOP_TIME = 0.3;
const SLOW_TIME = 1.2;

/** Metres before a stop line on red within which a car queues rather than steering round the car in front. */
const QUEUE_REACH = 40;

/**
 * A car behind its tour makes up one tick in this many as it drives a free
 * road where it is drawn: a fifth over its pace, which does not show.
 */
const CATCH_EVERY = 5;

/**
 * Metres from the player each way past which the traffic is not drawn
 * (`TRAFFIC_VIEW` of the renderer, and a little), and the ticks a car makes up
 * in one there.
 */
export const UNSEEN = 185;
const UNSEEN_CATCH = 4;

/** Metres a car keeps between its body and the player, their car, a wreck or a unit. */
const OTHER_ROOM = 0.25;

/**
 * Metres a car steering round the player, their car, a wreck or a unit keeps
 * from it. `swerve.ts` passes at 0.3; the touch that promotes a car is 0.1
 * (`traffic-bodies.ts`).
 */
const PASS_ROOM = 0.15;

/** Metres more than a person's radius a car keeps from them, so a step of theirs does not meet it. */
const STEP_ROOM = 0.2;

/** Metres a car keeps from the side of another it would drive into. */
const SIDE_ROOM = 0.2;

/** Metres two cars already within {@link SIDE_ROOM} of each other may still pass at. */
const BRUSH = 0.05;

/** Ticks at a time a car that came in on another is moved back, and how many times at most. */
const BACK_STEP = 20;
const BACK_TRIES = 90;

/** Hops followed along who stops for whom, looking for a ring of cars that each wait for the next. */
const RING_HOPS = 16;

export class GiveWay {
  private readonly traffic: AmbientTraffic;
  private readonly trafficNear = new NearCache();
  private readonly frame = new BoxFrame();
  private readonly crowd: CrowdWay;
  private readonly spare: number[] = [];
  private readonly cursor: TrafficCursor = { id: 0, step: 0, into: 0 };
  private readonly ahead: TrafficCursor = { id: 0, step: 0, into: 0 };
  private readonly pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  private readonly probe: Footprint = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };
  private readonly reach: Footprint = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };
  private cars: Car[] = [];
  /** The player, their car and the wrecks: what a car stops for that is not a car of the traffic. */
  private others: Other[] = [];
  private readonly carGrid = new Grid();
  /** The cars in the order they were placed, while the ones that have just come in are cleared. */
  private readonly filed = new Grid();
  private readonly steering: Steering;
  private readonly rejoin: Rejoin;
  private readonly junctions: JunctionClear;
  private readonly yielding: JunctionYield;
  private readonly kerbCursor: TrafficCursor = { id: 0, step: 0, into: 0 };
  private tick = 0;

  constructor(traffic: AmbientTraffic, crowd?: Crowd) {
    this.traffic = traffic;
    const scene = this;
    const carsNear = (x: number, y: number, r: number, out: number[]): number[] => this.frame.around(this.carGrid, x, y, r, out);
    this.crowd = new CrowdWay(crowd, this.frame, {
      get cars() {
        return scene.cars;
      },
      get others() {
        return scene.others;
      },
      carsNear,
    });
    this.rejoin = new Rejoin(traffic);
    this.yielding = new JunctionYield(traffic.roads.graph, traffic.roads.junctions, traffic.signals);
    this.junctions = new JunctionClear(traffic, {
      get cars() {
        return scene.cars;
      },
      carsNear,
    });
    this.steering = new Steering({
      get cars() {
        return scene.cars;
      },
      get people() {
        return scene.crowd.people;
      },
      get others() {
        return scene.others;
      },
      carsNear,
      peopleNear: (x, y, r, out) => this.frame.around(this.crowd.grid, x, y, r, out),
      kerbs: (car, out) => this.kerbsOf(car, out),
      queuedAtRed: (car) => this.queuedAtRed(car),
    });
  }

  /**
   * Decide the next tick of every car and person in the box round `(x, y)`:
   * who is held and who goes, written into the holds of the record, and who
   * a car of the traffic hits on the way. Called before the physics aims the
   * traffic at the next tick.
   */
  step(state: SimState, x: number, y: number, ground?: CasualtyGround): void {
    // A bumped car that stands clear goes back to its tour before the cars are read.
    if (state.traffic.promoted.length > 0) this.rejoin.step(state, x, y, GIVE_WAY_REACH);
    const cells = this.frame.set(x, y, GIVE_WAY_REACH);
    this.carGrid.reset(cells);
    this.filed.reset(cells);
    this.crowd.reset(cells);
    this.tick = state.tick;
    this.crowd.gather(state);
    this.gatherCars(state);
    this.gatherOthers(state);
    for (const car of this.cars) this.readAhead(state, car);
    this.placeAtJunctions(state);
    for (let i = 0; i < this.cars.length; i++) this.look(state, i);
    for (let i = 0; i < this.cars.length; i++) this.steering.steer(i);
    this.breakRings();
    this.moveCars(state);
    this.crowd.move(state, this.others);
    this.crowd.strike(state, ground);
  }

  /** Every entry of a grid filed within `pad` of a footprint's reach, once each. */
  private around(grid: Grid, box: Footprint, pad: number, out: number[]): number[] {
    return this.frame.around(grid, box.x, box.y, box.halfLength + box.halfWidth + pad, out);
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
    const fresh = held.tick !== state.tick;
    const entering: Car[] = [];
    const x = this.frame.midX;
    const y = this.frame.midY;
    for (const id of this.trafficNear.of(x, y, GIVE_WAY_REACH, (a, b, c, d, out) => traffic.near(a, b, c, d, out))) {
      if (state.traffic.promoted.length > 0 && promotedOf(state.traffic, id) !== undefined) continue;
      const car = this.carOf(state, id);
      if (car === undefined) continue;
      const inside = Math.abs(car.box.x - held.x) < GIVE_WAY_REACH && Math.abs(car.box.y - held.y) < GIVE_WAY_REACH;
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
      this.carGrid.add(this.frame.cellOf(car.box.x, car.box.y), i);
    }
  }

  /** Car `id` where its hold stands it now, swerve and all, or undefined where it is out of the box. */
  private carOf(state: SimState, id: number): Car | undefined {
    const traffic = this.traffic;
    const max = 2 * GIVE_WAY_REACH;
    const hold = holdOf(state.traffic.held, id);
    const lag = hold?.lag ?? 0;
    traffic.cursorAt(id, state.tick - lag, this.cursor);
    if (!traffic.edgeMeets(traffic.edgeOf(this.cursor), this.frame.minX, this.frame.minY, this.frame.minX + max, this.frame.minY + max)) return undefined;
    const pose = traffic.pose(this.cursor, this.pose);
    if (!this.frame.inBox(pose.x, pose.y)) return undefined;
    const spec = specOf((traffic.vehicles[id] as AmbientTraffic['vehicles'][number]).cls);
    const laneX = pose.x;
    const laneY = pose.y;
    const laneCos = cos(pose.heading);
    const laneSin = sin(pose.heading);
    const swerve = hold?.swerve === undefined ? undefined : { ...hold.swerve };
    if (swerve !== undefined) {
      pose.x -= laneSin * swerve.side;
      pose.y += laneCos * swerve.side;
      pose.heading += swerve.yaw;
    }
    return {
      id,
      lag,
      waited: hold?.waited ?? 0,
      box: { x: pose.x, y: pose.y, heading: pose.heading, halfLength: spec.halfLength, halfWidth: spec.halfWidth },
      cos: cos(pose.heading),
      sin: sin(pose.heading),
      speed: pose.speed,
      laneX,
      laneY,
      laneCos,
      laneSin,
      waiting: traffic.isWait(this.cursor),
      swerve,
      blocker: FREE,
      person: -1,
      stop: false,
      slow: false,
      yields: false,
      facing: false,
      next: { x: 0, y: 0, heading: 0, halfLength: spec.halfLength, halfWidth: spec.halfWidth },
      nextCos: 1,
      nextSin: 0,
      nextSpeed: 0,
    };
  }

  private file(car: Car): void {
    this.cars.push(car);
    this.filed.add(this.frame.cellOf(car.box.x, car.box.y), this.cars.length - 1);
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
      car.cos = cos(pose.heading);
      car.sin = sin(pose.heading);
      car.speed = pose.speed;
      car.laneX = pose.x;
      car.laneY = pose.y;
      car.laneCos = car.cos;
      car.laneSin = car.sin;
      car.waiting = traffic.isWait(this.cursor);
      car.swerve = undefined;
    }
  }

  private onAnother(car: Car): boolean {
    for (const j of this.around(this.filed, car.box, 8, this.spare)) {
      if (footprintsTouch(car.box, (this.cars[j] as Car).box, STOP_GAP)) return true;
    }
    return false;
  }

  /**
   * The player, the car they drive or left, the wrecks of the traffic, and
   * the police cars, fire engines and ambulances (spec sections 14, 20.3): a
   * car queues behind an engine at a fire rather than driving through it.
   */
  private gatherOthers(state: SimState): void {
    this.others = [];
    const v = state.vehicle;
    const spec = specOf(v.cls);
    // What a vehicle moves at over the ground: its `speed` is the wheels', which spin on a car that stands.
    this.other(v.x, v.z, headingOf(v), spec, hypot(v.vx, v.vz));
    if (!state.player.driving) this.other(state.player.x, state.player.y, 0, { halfLength: 0.4, halfWidth: 0.4 }, state.player.speed);
    for (const record of state.traffic.promoted) {
      const w = record.vehicle;
      if (!this.frame.inBox(w.x, w.z)) continue;
      this.other(w.x, w.z, headingOf(w), specOf(w.cls), hypot(w.vx, w.vz));
    }
    const patrol = specOf('emergency');
    for (const unit of state.police.units) {
      if (unit.kind === 'helicopter' || !this.frame.inBox(unit.x, unit.y)) continue;
      this.other(unit.x, unit.y, unit.heading, patrol, unit.speed);
    }
    for (const unit of state.emergency.units) {
      if (!this.frame.inBox(unit.x, unit.y)) continue;
      this.other(unit.x, unit.y, unit.heading, UNIT_BODY[unit.kind], unit.speed);
    }
  }

  private other(x: number, y: number, heading: number, body: { halfLength: number; halfWidth: number }, speed: number): void {
    this.others.push({ x, y, heading, halfLength: body.halfLength, halfWidth: body.halfWidth, cos: cos(heading), sin: sin(heading), speed });
  }

  /** Where a car's tour puts it on the next tick if nothing holds it. */
  private readAhead(state: SimState, car: Car): void {
    this.traffic.cursorAt(car.id, state.tick + 1 - car.lag, this.cursor);
    const ahead = this.traffic.pose(this.cursor, this.pose);
    const side = sideOf(car);
    car.next.x = ahead.x - sin(ahead.heading) * side;
    car.next.y = ahead.y + cos(ahead.heading) * side;
    car.next.heading = ahead.heading + (car.swerve?.yaw ?? 0);
    car.nextCos = cos(ahead.heading);
    car.nextSin = sin(ahead.heading);
    car.nextSpeed = ahead.speed;
  }

  /** What stands in the lane ahead of car `i`, and whether it has to stop or slow for it. */
  private look(state: SimState, i: number): void {
    const car = this.cars[i] as Car;
    const box = car.box;
    const stopRoom = STOP_GAP + car.speed * STOP_TIME;
    const slowRoom = stopRoom + car.speed * SLOW_TIME;
    const fx = car.cos;
    const fy = car.sin;
    setAhead(this.probe, box, fx, fy, stopRoom);
    setAhead(this.reach, box, fx, fy, slowRoom);
    this.lookSide(car, i);
    this.lookJunction(i, slowRoom);
    this.lookAhead(car, i);
    this.lookOthers(car);
    this.lookPeople(car);
    if (!this.crossesLine(state, car)) return;
    const edge = this.traffic.edgeOf(this.cursor);
    // Behind its tour it may meet a red it was timed to pass on green; on time or not, it keeps the junction clear.
    const red = car.lag > 0 && this.redOn(edge, state.tick + 1);
    if (red || (!car.stop && this.junctions.blocked(i, edge, state.tick - car.lag))) this.block(car, LIGHT);
  }

  /**
   * A car coming in from the side, at a junction, is not in the lane ahead:
   * it is the next step of car `i` that would drive into it, where it stands
   * or where it goes.
   */
  private lookSide(car: Car, i: number): void {
    const box = car.box;
    const nc = car.nextCos;
    const ns = car.nextSin;
    for (const j of this.around(this.carGrid, car.next, 4, this.spare)) {
      if (j === i) continue;
      const other = this.cars[j] as Car;
      if (!close(car.next, other.box, SIDE_ROOM)) continue;
      const into =
        turnedTouch(car.next, nc, ns, other.box, other.cos, other.sin, SIDE_ROOM) ||
        turnedTouch(car.next, nc, ns, other.next, other.nextCos, other.nextSin, SIDE_ROOM);
      if (!into) continue;
      // Two cars already this close may move apart, or on past each other where the step really touches nothing.
      const touching = turnedTouch(box, car.cos, car.sin, other.box, other.cos, other.sin, SIDE_ROOM);
      if (!touching || (apart(car.next, other.box) <= apart(box, other.box) && this.brushes(car, other))) this.block(car, j);
    }
  }

  /**
   * True when car `car`'s next step comes within {@link BRUSH} of `other`,
   * where it stands or where it goes. Two cars squeezing past each other
   * round something that stands in the road pass this close.
   */
  private brushes(car: Car, other: Car): boolean {
    const nc = car.nextCos;
    const ns = car.nextSin;
    return turnedTouch(car.next, nc, ns, other.box, other.cos, other.sin, BRUSH) || turnedTouch(car.next, nc, ns, other.next, other.nextCos, other.nextSin, BRUSH);
  }

  /** The cars of the traffic in the lane ahead of car `i` that head the same way. */
  private lookAhead(car: Car, i: number): void {
    const fx = car.cos;
    const fy = car.sin;
    for (const j of this.around(this.carGrid, this.reach, 8, this.spare)) {
      if (j === i) continue;
      const ahead = this.cars[j] as Car;
      const other = ahead.box;
      if (!close(this.reach, other, 0)) continue;
      // One coming the other way is in its own lane, unless either of the two is out of theirs.
      if (ahead.cos * fx + ahead.sin * fy < HEAD_ON && sideOf(car) === 0 && sideOf(ahead) === 0) continue;
      if (turnedTouch(this.probe, fx, fy, other, ahead.cos, ahead.sin, 0)) this.block(car, j);
      else if (turnedTouch(this.reach, fx, fy, other, ahead.cos, ahead.sin, 0)) car.slow = true;
    }
  }

  /** The player, their car, the wrecks and the emergency units in the lane ahead of a car. */
  private lookOthers(car: Car): void {
    const box = car.box;
    const fx = car.cos;
    const fy = car.sin;
    for (const other of this.others) {
      if (!close(this.reach, other, 0) || !turnedTouch(this.reach, fx, fy, other, other.cos, other.sin, 0)) continue;
      // Something longer than the car that has come up on it from behind
      // reaches past its nose, and is not in its way: it drives on.
      if ((other.x - box.x) * fx + (other.y - box.y) * fy <= 0) continue;
      car.facing = true;
      if (turnedTouch(this.probe, fx, fy, other, other.cos, other.sin, 0)) this.block(car, OTHER);
      else car.slow = true;
    }
    // Its whole body, not only the lane ahead: a corner that would clip one of them stops it too.
    // A car steering round one squeezes by closer, still wider than the touch that promotes it.
    const room = sideOf(car) === 0 ? OTHER_ROOM : PASS_ROOM;
    for (const other of this.others) {
      if (!close(car.next, other, room)) continue;
      const into = turnedTouch(car.next, car.nextCos, car.nextSin, other, other.cos, other.sin, room);
      if (into && !turnedTouch(box, fx, fy, other, other.cos, other.sin, room)) this.block(car, OTHER);
    }
  }

  /** The people in the lane ahead of a car, or where its next step puts it, which on a corner is not the same. */
  private lookPeople(car: Car): void {
    const fx = car.cos;
    const fy = car.sin;
    for (const k of this.around(this.crowd.grid, this.reach, 1, this.spare)) {
      const person = this.crowd.people[k] as Person;
      const stepped = within(car.next, car.nextCos, car.nextSin, person.x, person.y, PERSON_RADIUS + STEP_ROOM);
      if (!stepped && !within(this.reach, fx, fy, person.x, person.y, PERSON_RADIUS)) continue;
      if (stepped || within(this.probe, fx, fy, person.x, person.y, PERSON_RADIUS)) {
        this.block(car, PERSON);
        if (car.person < 0) car.person = k;
      } else car.slow = true;
    }
  }

  private block(car: Car, by: number): void {
    // A car of the traffic comes first: it is the one a ring of waiting cars is looked for along.
    if (!car.stop || (car.blocker < 0 && by >= 0)) car.blocker = by;
    car.stop = true;
  }

  /** Where the kerbs of a car's carriageway stand, right of the middle of its lane. */
  private kerbsOf(car: Car, out: Kerbs): Kerbs {
    this.traffic.cursorAt(car.id, this.tick - car.lag, this.kerbCursor);
    return this.traffic.kerbsOf(this.kerbCursor, out);
  }

  /** True where a car stands within {@link QUEUE_REACH} of a stop line whose light is not green. */
  private queuedAtRed(car: Car): boolean {
    const signals = this.traffic.signals;
    if (car.waiting) return true;
    if (signals === undefined) return false;
    const cursor = this.traffic.cursorAt(car.id, this.tick - car.lag, this.kerbCursor);
    const approach = signals.approachOf(this.traffic.edgeOf(cursor));
    if (approach === undefined) return false;
    const metres = this.traffic.metresOf(cursor);
    return metres > approach.stop - QUEUE_REACH && metres <= approach.stop + 1 && signals.light(approach, this.tick) !== 'green';
  }

  /**
   * Ticks a car behind its tour makes up on the next tick as it drives: one
   * in {@link CATCH_EVERY} where it is drawn, {@link UNSEEN_CATCH} beyond the
   * traffic's view. Only on a free road, off its swerve and away from a stop
   * line, whose light its tour was not timed for.
   */
  private catchUp(state: SimState, car: Car): number {
    if (car.stop || car.slow || car.facing || car.swerve !== undefined || car.speed < STANDING) return 0;
    const unseen = Math.max(Math.abs(car.box.x - this.frame.midX), Math.abs(car.box.y - this.frame.midY)) > UNSEEN;
    if (!unseen && (state.tick + car.id) % CATCH_EVERY !== 0) return 0;
    const signals = this.traffic.signals;
    const approach = signals?.approachOf(this.traffic.edgeOf(this.cursor));
    if (approach !== undefined && this.traffic.metresOf(this.cursor) > approach.stop - QUEUE_REACH) return 0;
    return unseen ? UNSEEN_CATCH : 1;
  }

  /**
   * True when a car's next tick takes it over the stop line of a signalled
   * approach. The cursor is left where the car stands now.
   */
  private crossesLine(state: SimState, car: Car): boolean {
    const signals = this.traffic.signals;
    if (signals === undefined) return false;
    const traffic = this.traffic;
    const time = state.tick - car.lag;
    traffic.cursorAt(car.id, time, this.cursor);
    traffic.cursorAt(car.id, time + 1, this.ahead);
    const edge = traffic.edgeOf(this.cursor);
    const approach = signals.approachOf(edge);
    if (approach === undefined) return false;
    return crossesStop(traffic.metresOf(this.cursor), this.metresAhead(edge), approach.stop);
  }

  /** True when the light of the approach on `edge` is not green at `tick`. */
  private redOn(edge: number, tick: number): boolean {
    const signals = this.traffic.signals;
    const approach = signals?.approachOf(edge);
    return approach !== undefined && signals?.light(approach, tick) !== 'green';
  }

  /** Metres along `edge` the ahead cursor stands, or Infinity where it has left that edge. */
  private metresAhead(edge: number): number {
    const traffic = this.traffic;
    return traffic.edgeOf(this.ahead) === edge ? traffic.metresOf(this.ahead) : Infinity;
  }

  /** Where each car stands to the junctions without lights it is coming to or going through. */
  private placeAtJunctions(state: SimState): void {
    const traffic = this.traffic;
    this.yielding.reset(this.cars.length);
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i] as Car;
      traffic.cursorAt(car.id, state.tick - car.lag, this.cursor);
      traffic.cursorAt(car.id, state.tick + 1 - car.lag, this.ahead);
      this.yielding.place(traffic, i, this.cursor, this.ahead, car.box.halfLength, car.speed);
    }
  }

  /** A car at the mouth of a junction without lights waits for one whose path through it comes first. */
  private lookJunction(i: number, slowRoom: number): void {
    const car = this.cars[i] as Car;
    const wait = this.yielding.waitFor(i, (j) => (this.cars[j] as Car).id, slowRoom);
    if (wait === undefined) return;
    if (!wait.stop) car.slow = true;
    else {
      this.block(car, wait.car);
      car.yields = true;
    }
  }

  /**
   * Two cars that each stop for the other, or a ring of them, stand forever.
   * In each ring the car with the lowest id goes, of those that do not wait
   * at the mouth of a junction: a car inside one may stop for where a car
   * waiting for it would have driven, and it is the one that has to go.
   */
  private breakRings(): void {
    const cars = this.cars;
    const release: number[] = [];
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i] as Car;
      if (car.stop && car.blocker >= 0 && this.leadsRing(i)) release.push(i);
    }
    for (const i of release) {
      const car = cars[i] as Car;
      car.stop = false;
      car.blocker = FREE;
    }
  }

  /** True when car `i` stands in a ring of cars that each stop for the next, and is the one of it that goes. */
  private leadsRing(i: number): boolean {
    const cars = this.cars;
    const car = cars[i] as Car;
    let lowest = car.id;
    let free = car.yields ? Infinity : car.id;
    let at = car.blocker;
    for (let hop = 0; hop < RING_HOPS && at >= 0; hop++) {
      if (at === i) return (free < Infinity ? free : lowest) === car.id;
      const next = cars[at] as Car;
      if (!next.stop) return false;
      lowest = Math.min(lowest, next.id);
      if (!next.yields) free = Math.min(free, next.id);
      at = next.blocker;
    }
    return false;
  }

  /** Write the cars' holds for the next tick, and where each will stand on it. */
  private moveCars(state: SimState): void {
    const traffic = this.traffic;
    this.crowd.begin(this.cars);
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
        // Where its tour stands still, it makes up the lag without moving; on a free road, a little as it drives.
        traffic.cursorAt(car.id, next - lag, this.cursor);
        const made = Math.min(lag, traffic.waitLeft(this.cursor) || this.catchUp(state, car));
        lag -= made;
        step = -made;
      }
      const waited = waitedNext(car);
      car.waited = waited;
      if (car.stop && car.blocker === PERSON && car.person >= 0) this.crowd.noteWaiting(car);
      const swerve = car.swerve;
      if (swerve !== undefined) list.push({ id: car.id, lag, step, waited, swerve });
      else if (lag > 0 || step !== 0 || waited > 0) list.push({ id: car.id, lag, step, waited });
      // Moving, it stands where `look` read it ahead; making up lag, it stands still there too.
      if (held) standStill(car);
    }
    this.crowd.fileNext();
    state.traffic.held = { tick: next, x: this.frame.midX, y: this.frame.midY, list };
  }


}

/** The ticks a car will have stood for the player, a wreck or a person on the next tick. */
function waitedNext(car: Car): number {
  return car.stop && (car.blocker === OTHER || car.blocker === PERSON) ? car.waited + 1 : 0;
}

/** Stand a held car on the next tick where it stands now. */
function standStill(car: Car): void {
  car.next.x = car.box.x;
  car.next.y = car.box.y;
  car.next.heading = car.box.heading;
  car.nextCos = car.cos;
  car.nextSin = car.sin;
  car.nextSpeed = 0;
}

/** Ticks a cursor has stood still for in the wait it is in, or 0 where its step is a drive. */
function waitInto(traffic: AmbientTraffic, cursor: TrafficCursor): number {
  return traffic.isWait(cursor) ? cursor.into : 0;
}
