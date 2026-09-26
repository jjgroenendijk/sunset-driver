/**
 * Ambient pedestrians (spec sections 5.3, 13.1): every person on the city's
 * pavements as a function of `(seed, tick)` and a stable id.
 *
 * The crowd is placed once for a world, the way the traffic is
 * (`pedestrian-place.ts`). Each person walks a loop of the road graph for
 * ever, in a lane of their own on the pavement, at their own pace, crossing
 * where the loop turns (`pedestrian-route.ts`). The loop is walked as a plan
 * of steps (`pedestrian-walk.ts`): they wait at the kerb for the lights, stop
 * for a call or a cigarette, look in a window or go in at a door. Company walk
 * abreast, keeping to the plan of the first of them. Their look and their gait
 * come from the district (`pedestrian-look.ts`). No person reads another one.
 *
 * Where a person is can be asked two ways, and they agree exactly:
 * {@link AmbientPedestrians.cursorAt} evaluates them at any tick, and
 * {@link AmbientPedestrians.advance} steps a cursor one tick. A loop takes a
 * whole number of ticks and a whole number of strides, so the walk cycle comes
 * round with the loop and never jumps.
 *
 * A person who reacts to something — a shot, a car on the pavement — leaves
 * the loop. {@link startle} writes them into {@link PedestrianState}, the only
 * part of the crowd the record holds with the people giving way and stepping
 * aside, and {@link startledPose} says where they are from then on. The living
 * city of spec section 20.1 is what calls it.
 *
 * A pose carries more than a place: the gait a person is leaving and how much
 * of it is left, so a change of gait blends over a few frames rather than
 * snapping; and where their head is turned.
 */
import { hashInts } from '../../core/hash.ts';
import { rngFor, Subsystem } from '../../core/rng.ts';
import { atan2, cos, hypot, sin } from '../../core/libm.ts';
import { districtAt, layoutZones } from '../../world/terrain/districts.ts';
import type { District, WorldDescription } from '../../world/types.ts';
import { TICK_RATE } from '../clock.ts';
import { asideOf, type Aside } from './crowd-aside.ts';
import { EdgeIndex } from '../traffic/edge-index.ts';
import { strideOf, type Gait } from './pedestrian-look.ts';
import { placeOnEdge, planPointAt, walkable, type AmbientPedestrian } from './pedestrian-place.ts';
import { Pavements, pavementOffset, type WalkPoint } from './pedestrian-route.ts';
import { HURRY, IDLES, INSIDE, KERB, LINGER, PAUSE, STEP_IN, STEP_OUT, walks, type PlanPoint } from './pedestrian-walk.ts';
import { PoseMemo, type MemoPose } from '../traffic/pose-memo.ts';
import { legNear } from '../traffic/traffic-tour.ts';
import type { Casualty } from './casualty-motion.ts';
import { createHolds, heldStep, heldTime, type Holds } from '../traffic/hold.ts';
import type { TrafficSignals } from '../traffic/signals.ts';
import type { TrafficRoads } from '../traffic/traffic.ts';

export { type AmbientPedestrian } from './pedestrian-place.ts';

/** Metres each way of one bucket of the index that says which people can be near a place. */
const PEDESTRIAN_CELL = 100;

/** Metres behind and ahead of a person their pose is read at, so they turn a corner rather than snap round. */
const HALF_STEP = 0.3;

/** Ticks a change of gait is blended over. */
const BLEND_TICKS = 18;

/** Ticks a turn of a startled person takes. */
const TURN_TICKS = 12;

/** Ticks one loop of a standing gait takes: a drag on a cigarette, a gesture. */
export const IDLE_TICKS = 4 * TICK_RATE;

/** Ticks a person who dodged a car stands shouting after it. */
const SHOUT_TICKS = Math.round(2.5 * TICK_RATE);

/** Ticks one glance of company at each other takes, and the most the head turns in one. */
const GLANCE_TICKS = 7 * TICK_RATE;
const GLANCE = 0.55;

/** The key of the stream a reaction draws from. */
const REACTION_STREAM = 3;
/** The key of the stream what a person does after a fright is drawn from. */
const AFTER_STREAM = 4;

/** The district at a place, as far as the crowd needs it. */
export type DistrictAt = (x: number, y: number) => Pick<District, 'zone' | 'density'>;

/** The districts of a generated world, as the crowd reads them. */
export function crowdDistrictsOf(world: WorldDescription): DistrictAt {
  const zones = layoutZones(world.size, world.core, world.water);
  return (x, y) => districtAt(world.districts, zones, x, y);
}

/** Where on the loop a person is: the whole ticks into it. */
export interface PedestrianCursor {
  id: number;
  at: number;
}

/** A person placed on the map. `y` is the map's; `height` is up. */
export interface PedestrianPose {
  x: number;
  y: number;
  /** The ground under their feet. */
  height: number;
  heading: number;
  /** Metres per second along the heading. */
  speed: number;
  /** How far through the walk cycle they are, 0 to 1. */
  cycle: number;
  gait: Gait;
  /** The gait they are leaving, and how far through its cycle they left it. */
  from?: Gait;
  fromCycle?: number;
  /** How much of {@link from} is still in the pose: 1 at the change, 0 once it is done. */
  blend?: number;
  /** Radians the head is turned from the body, in the sense the heading turns. */
  look?: number;
  /** True for somebody who has gone in at a door, and is not drawn or met. */
  hidden?: boolean;
}

/** A pose at the origin, standing, for a caller to write into. */
export function emptyPose(): PedestrianPose {
  return { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand', from: 'stand', fromCycle: 0, blend: 0, look: 0, hidden: false };
}

/** What makes a person leave their loop. */
export type Reaction = 'flee' | 'scatter' | 'gather' | 'dodge';

/** How a reaction moves a person: their pace, how long for, and the gait they move in. */
export interface ReactionSpec {
  speed: number;
  ticks: number;
  gait: Gait;
  /** True for a reaction that walks a person to the place rather than off it. */
  toward: boolean;
}

/** How far and how fast each reaction moves a person, and the gait they move in. */
export const REACTIONS: Record<Reaction, ReactionSpec> = {
  // Away from gunfire, at a run, for a good distance.
  flee: { speed: 4, ticks: 8 * TICK_RATE, gait: 'run', toward: false },
  // Out of the way of a car: a few quick steps to the side.
  scatter: { speed: 3.2, ticks: Math.round(1.2 * TICK_RATE), gait: 'run', toward: false },
  // Towards a crash, for a few steps, and then they stand and watch it.
  gather: { speed: 1.5, ticks: 2 * TICK_RATE, gait: 'brisk', toward: true },
  // Out of the way of a car driven at them, and then they turn and shout after it.
  dodge: { speed: 3.2, ticks: Math.round(1.2 * TICK_RATE), gait: 'run', toward: false },
};

/** A person who has left their loop, and the record the simulation keeps of them. */
export interface StartledPedestrian {
  id: number;
  reaction: Reaction;
  /** The tick they reacted on. */
  since: number;
  /** Where they stood then, and the way they move off. */
  x: number;
  y: number;
  height: number;
  heading: number;
  /** The way they faced and the gait they walked in before, which the turn and the gait blend from. */
  was?: number;
  from?: Gait;
}

/** What the simulation record holds of the crowd: only the people it has touched. */
export interface PedestrianState {
  /** Ascending by id. */
  startled: StartledPedestrian[];
  /**
   * The people something has hit (`casualty.ts`), ascending by id. Nobody is
   * in both lists: a hit takes a person out of the startled.
   */
  casualties: Casualty[];
  /** The people near the player who have waited for a car and fallen behind their loops (`give-way.ts`). */
  held: Holds;
  /** The people near the player on foot stepping out of their way, ascending by id (`make-way.ts`). */
  aside: Aside[];
}

export function createPedestrianState(): PedestrianState {
  return { startled: [], casualties: [], held: createHolds(), aside: [] };
}

/** The record of a person who has been hit, or undefined for somebody nothing has hit. */
export function casualtyOf(state: PedestrianState, id: number): Casualty | undefined {
  return byId(state.casualties, id);
}

/** The crowd as the poses below read it. */
interface PoseSource {
  poseAt(id: number, time: number, out: PedestrianPose): PedestrianPose;
}

/**
 * Where a person of the crowd stands at a moment, from their loop or from
 * their fright, or undefined for somebody who has been hit — a casualty is
 * posed by `casualty-motion.ts`, and lying down is not a walk — and for
 * somebody who has gone in at a door.
 */
export function crowdPoseOf(crowd: PoseSource, state: PedestrianState, id: number, time: number, out: PedestrianPose): PedestrianPose | undefined {
  if (state.casualties.length > 0 && casualtyOf(state, id) !== undefined) return undefined;
  const startled = state.startled.length > 0 ? startledOf(state, id) : undefined;
  if (startled !== undefined) return startledPose(startled, time, out);
  const pose = walkingPose(crowd, state, id, time, out);
  return pose.hidden === true ? undefined : pose;
}

/**
 * Where a person stands on their loop at a moment, held back as far as they
 * have waited for the traffic, stepped as far aside as the player has made
 * them, and as far off it as they keep out of a car's way.
 */
export function walkingPose(crowd: PoseSource, state: PedestrianState, id: number, time: number, out: PedestrianPose): PedestrianPose {
  crowd.poseAt(id, heldTime(state.held, id, time), out);
  const step = heldStep(state.held, id);
  if (step === 1) {
    out.speed = 0;
    out.gait = 'stand';
  } else if (step === 2) {
    // Walking back the way they came, they face it.
    out.heading += Math.PI;
  }
  const aside = state.aside.length > 0 ? asideOf(state.aside, id) : undefined;
  if (aside !== undefined) {
    out.x -= sin(out.heading) * aside.off - aside.dodgeX;
    out.y += cos(out.heading) * aside.off + aside.dodgeY;
    out.look = aside.look;
  }
  return out;
}

/** The record of a startled person, or undefined while they still walk their loop. */
export function startledOf(state: PedestrianState, id: number): StartledPedestrian | undefined {
  return byId(state.startled, id);
}

export class AmbientPedestrians {
  readonly people: readonly AmbientPedestrian[];
  readonly pavements: Pavements;
  private readonly seed: number;
  private readonly index: EdgeIndex;
  private readonly behind: WalkPoint = { x: 0, y: 0, height: 0 };
  private readonly ahead: WalkPoint = { x: 0, y: 0, height: 0 };
  private readonly memo: PoseMemo;
  /** The leg of their loop each person was last found on, where the next search starts. */
  private readonly legs: Int32Array;
  private readonly point: PlanPoint = { step: 0, into: 0, distance: 0 };
  private readonly mid: MemoPose = { x: 0, y: 0, height: 0, heading: 0 };

  /** `signals` are the traffic's lights, which the crowd waits at; without them nobody waits. */
  constructor(seed: number, roads: TrafficRoads, districtAt?: DistrictAt, signals?: TrafficSignals) {
    this.seed = seed;
    const graph = roads.graph;
    this.pavements = new Pavements(roads.roads, graph, roads.heightAt);
    // A corner can stand a few pavement widths off the node it turns at.
    this.index = new EdgeIndex(roads.roads, graph, 4 * pavementOffset({ tier: 'arterial' }), PEDESTRIAN_CELL);
    const people: AmbientPedestrian[] = [];
    const ctx = { seed, graph, pavements: this.pavements, signals, file: (id: number, e: number) => this.index.file(id, e) };
    for (const edge of graph.edges) {
      if (!walkable(edge)) continue;
      const points = (roads.roads[edge.curve] as { points: readonly { x: number; y: number }[] }).points;
      const mid = points[(edge.start + edge.end) >> 1] as { x: number; y: number };
      placeOnEdge(ctx, edge, districtAt?.(mid.x, mid.y) ?? { zone: 'core', density: 1 }, people);
    }
    this.people = people;
    this.memo = new PoseMemo(people.length);
    this.legs = new Int32Array(people.length);
  }

  /** Where a person is on their loop at a tick, evaluated without stepping them there. */
  cursorAt(id: number, tick: number, out: PedestrianCursor = { id, at: 0 }): PedestrianCursor {
    const person = this.people[id] as AmbientPedestrian;
    out.id = id;
    out.at = mod(tick + person.phase, person.period);
    return out;
  }

  /** Step a cursor one tick along the loop. */
  advance(cursor: PedestrianCursor): void {
    const person = this.people[cursor.id] as AmbientPedestrian;
    cursor.at = cursor.at + 1 === person.period ? 0 : cursor.at + 1;
  }

  /** The pose a cursor stands at. */
  pose(cursor: PedestrianCursor, out: PedestrianPose): PedestrianPose {
    return this.poseOn(cursor.id, cursor.at, out);
  }

  /**
   * The pose of a person at a moment, which may fall between two ticks: the
   * renderer draws the crowd between the last two. At a whole tick it is
   * exactly the pose of the cursor there.
   */
  poseAt(id: number, time: number, out: PedestrianPose): PedestrianPose {
    const person = this.people[id] as AmbientPedestrian;
    return this.poseOn(id, mod(time + person.phase, person.period), out);
  }

  /**
   * The edge a person walks at a moment, which is what a caller skips a far
   * person by before it reads the pose.
   */
  edgeAt(id: number, time: number): number {
    const person = this.people[id] as AmbientPedestrian;
    const route = person.route;
    const distance = planPointAt(person.plan, time + person.phase, this.point).distance % route.length;
    const leg = legNear(route.start, distance, this.legs[id] as number);
    this.legs[id] = leg;
    return route.edges[leg] as number;
  }

  /** True when an edge, grown by the reach of its pavements and corners, overlaps a box. */
  edgeMeets(edge: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
    return this.index.meets(edge, minX, minY, maxX, maxY);
  }

  /** The ids of every person whose loop passes through a box, ascending. */
  near(minX: number, minY: number, maxX: number, maxY: number, out: number[]): number[] {
    return this.index.near(minX, minY, maxX, maxY, out);
  }

  /** True for somebody who jaywalks, and misjudges the gap in front of a car doing it (`give-way.ts`). */
  bold(id: number): boolean {
    return (this.people[id] as AmbientPedestrian).bold;
  }

  /**
   * Take everyone within `radius` of a place off their loops at a tick, as the
   * reaction asks. A person already startled keeps the reaction they have.
   * `flee` runs straight away from the place; `scatter` and `dodge` jump
   * aside, to whichever side of the threat's line they already stand on;
   * `gather` walks a few steps to the place and stands facing it. Answers how
   * many reacted.
   */
  startle(state: PedestrianState, tick: number, x: number, y: number, radius: number, reaction: Reaction, ids: number[] = []): number {
    const pose = emptyPose();
    let count = 0;
    for (const id of this.near(x - radius, y - radius, x + radius, y + radius, ids)) {
      if (startledOf(state, id) !== undefined) continue;
      if (state.casualties.length > 0 && casualtyOf(state, id) !== undefined) continue;
      walkingPose(this, state, id, tick, pose);
      if (pose.hidden === true) continue;
      const dx = pose.x - x;
      const dy = pose.y - y;
      if (dx * dx + dy * dy > radius * radius) continue;
      const heading = this.reactionHeading(tick, id, pose, dx, dy, reaction);
      addStartled(state, { id, reaction, since: tick, x: pose.x, y: pose.y, height: pose.height, heading, was: pose.heading, from: pose.gait });
      count++;
    }
    return count;
  }

  /**
   * The way a person startled at `pose` heads off, (`dx`, `dy`) from the
   * threat: away from it, a quarter turn off its line, or towards it.
   */
  private reactionHeading(tick: number, id: number, pose: PedestrianPose, dx: number, dy: number, reaction: Reaction): number {
    const heading = dx === 0 && dy === 0 ? pose.heading + Math.PI : atan2(dy, dx);
    if (reaction === 'scatter' || reaction === 'dodge') {
      // A quarter turn off the line from the threat, and a little more or less.
      const across = dx * sin(pose.heading) - dy * cos(pose.heading) >= 0 ? -1 : 1;
      const rng = rngFor(this.seed, tick, Subsystem.Pedestrians, hashInts(REACTION_STREAM, id));
      return pose.heading + across * (Math.PI / 2 + rng.range(-0.4, 0.4));
    }
    if (REACTIONS[reaction].toward) return heading + Math.PI;
    return heading;
  }

  private poseOn(id: number, at: number, out: PedestrianPose): PedestrianPose {
    const person = this.people[id] as AmbientPedestrian;
    const lead = this.people[person.lead] as AmbientPedestrian;
    const plan = lead.plan;
    const point = planPointAt(plan, at, this.point);
    const k = point.step;
    const kind = plan.kind[k] as number;
    const f = Math.min(1, point.into / (plan.ticks[k] as number));
    // A whole tick is asked for many times over; the renderer's moments between ticks are not.
    const mid = this.mid;
    const whole = Number.isInteger(at);
    if (!whole || !this.memo.read(id, at, mid)) {
      this.pavements.sample(lead.route, point.distance - HALF_STEP, this.behind);
      this.pavements.sample(lead.route, point.distance + HALF_STEP, this.ahead);
      mid.x = (this.behind.x + this.ahead.x) / 2;
      mid.y = (this.behind.y + this.ahead.y) / 2;
      mid.height = (this.behind.height + this.ahead.height) / 2;
      mid.heading = atan2(this.ahead.y - this.behind.y, this.ahead.x - this.behind.x);
      if (whole) this.memo.write(id, at, mid);
    }
    const travel = mid.heading;
    // A window or a door is off to one side of the lane: right is a quarter turn up from the heading.
    const aside = plan.aside[k] as number;
    const toward = travel + (aside >= 0 ? Math.PI / 2 : -Math.PI / 2);
    // Company stops beside the lead, on the side away from the window or the door.
    const stop = aside - Math.sign(aside) * Math.abs(person.beside);
    let lateral = person.beside;
    let heading = travel;
    if (kind === STEP_IN) {
      lateral += (stop - person.beside) * ease(f);
      heading = turn(travel, toward, Math.min(1, f * 2.5));
    } else if (kind === LINGER || kind === INSIDE) {
      lateral = stop;
      heading = toward;
    } else if (kind === STEP_OUT) {
      lateral += (stop - person.beside) * (1 - ease(f));
      heading = turn(toward + Math.PI, travel, Math.min(1, f * 1.6));
    }
    out.x = mid.x - sin(travel) * lateral;
    out.y = mid.y + cos(travel) * lateral;
    out.height = mid.height;
    out.heading = heading;
    out.hidden = kind === INSIDE;
    this.motion(person, lead, k, point.into, point.distance, out);
    out.look = person.company > 1 ? glance(person, at) : 0;
    return out;
  }

  /** The gait, the cycle and the speed of a person on step `k` of their plan, and the blend in from the step before. */
  private motion(person: AmbientPedestrian, lead: AmbientPedestrian, k: number, into: number, distance: number, out: PedestrianPose): void {
    const plan = lead.plan;
    out.gait = this.gaitOn(person, lead, k);
    out.cycle = this.cycleOn(person, lead, k, into, distance);
    const kind = plan.kind[k] as number;
    const ticks = plan.ticks[k] as number;
    out.speed = walks(kind) ? (((plan.to[k] as number) - (plan.from[k] as number)) / ticks) * TICK_RATE : 0;
    if (kind === STEP_IN || kind === STEP_OUT) out.speed = (Math.abs(plan.aside[k] as number) / ticks) * TICK_RATE;
    const before = k === 0 ? plan.kind.length - 1 : k - 1;
    const was = this.gaitOn(person, lead, before);
    if (into >= BLEND_TICKS || was === out.gait) {
      out.from = out.gait;
      out.fromCycle = out.cycle;
      out.blend = 0;
      return;
    }
    out.from = was;
    out.fromCycle = this.cycleOn(person, lead, before, plan.ticks[before] as number, plan.to[before] as number);
    out.blend = 1 - into / BLEND_TICKS;
  }

  private gaitOn(person: AmbientPedestrian, lead: AmbientPedestrian, k: number): Gait {
    const plan = lead.plan;
    const kind = plan.kind[k] as number;
    if (kind === HURRY) return 'jog';
    if (walks(kind)) return lead.look.gait;
    if (kind === STEP_IN || kind === STEP_OUT) return 'stroll';
    if (kind === KERB || kind === INSIDE) return 'stand';
    // Company stands and talks rather than each making a call of their own.
    if (kind === PAUSE && person.company > 1) return 'talk';
    return IDLES[plan.idle[k] as number] ?? 'stand';
  }

  private cycleOn(person: AmbientPedestrian, lead: AmbientPedestrian, k: number, into: number, distance: number): number {
    const plan = lead.plan;
    const kind = plan.kind[k] as number;
    // Company walks out of step with one another.
    const offset = person.id === lead.id ? 0 : 0.37 * (person.id - lead.id);
    let cycles: number;
    if (walks(kind)) cycles = distance / plan.stride + offset;
    else if (kind === STEP_IN || kind === STEP_OUT) cycles = into / (plan.ticks[k] as number);
    else cycles = into / IDLE_TICKS + offset;
    return cycles - Math.floor(cycles);
  }
}

/**
 * Where a startled person is at a tick: moving off the way they reacted to for
 * as long as the reaction lasts, then standing where it left them, doing what
 * the fright left them doing. The turn and the change of gait blend in.
 */
export function startledPose(record: StartledPedestrian, time: number, out: PedestrianPose): PedestrianPose {
  const reaction = REACTIONS[record.reaction];
  const since = Math.max(0, time - record.since);
  const elapsed = Math.min(since, reaction.ticks);
  const moving = since < reaction.ticks;
  const distance = (elapsed / TICK_RATE) * reaction.speed;
  out.x = record.x + cos(record.heading) * distance;
  out.y = record.y + sin(record.heading) * distance;
  out.height = record.height;
  const turned = turn(record.was ?? record.heading, record.heading, Math.min(1, since / TURN_TICKS));
  out.speed = moving ? reaction.speed : 0;
  const cycles = distance / strideOf(reaction.gait, 1.75);
  const cycle = cycles - Math.floor(cycles);
  out.hidden = false;
  out.look = 0;
  if (moving) {
    out.heading = turned;
    out.gait = reaction.gait;
    out.cycle = cycle;
    out.from = record.from ?? 'stroll';
    out.fromCycle = 0;
    out.blend = Math.max(0, 1 - since / BLEND_TICKS);
    return out;
  }
  const after = since - reaction.ticks;
  const shouting = record.reaction === 'dodge' && after < SHOUT_TICKS;
  // A dodger turns back to face the road the car came down.
  out.heading = shouting ? record.heading + Math.PI : record.heading;
  out.gait = shouting ? 'shout' : afterFright(record);
  out.cycle = (after / IDLE_TICKS) % 1;
  out.from = reaction.gait;
  out.fromCycle = cycle;
  out.blend = Math.max(0, 1 - after / BLEND_TICKS);
  return out;
}

/**
 * What a person does once a fright has run its course: somebody who ran from
 * gunfire may be calling it in, and somebody watching a crash may be filming
 * it. Drawn from the person and the tick of the fright, so a replay agrees.
 */
function afterFright(record: StartledPedestrian): Gait {
  const roll = ((hashInts(AFTER_STREAM, record.id, record.since) >>> 0) % 1000) / 1000;
  if (record.reaction === 'gather') {
    if (roll < 0.45) return 'film';
    return roll < 0.65 ? 'fold' : 'stand';
  }
  if (record.reaction === 'flee') return roll < 0.4 ? 'phone' : 'stand';
  return 'stand';
}

/**
 * Let go of every startled person further than `distance` from a place at a
 * tick. They go back to their loops, which is seen only where nobody is
 * looking.
 */
export function releaseFar(state: PedestrianState, time: number, x: number, y: number, distance: number): void {
  const pose = emptyPose();
  state.startled = state.startled.filter((record) => {
    startledPose(record, time, pose);
    return hypot(pose.x - x, pose.y - y) <= distance;
  });
}

/**
 * Move a person out of the way of a car that stands for them: a few quick
 * steps along `heading`, from where they stand. Unlike a fright this also
 * moves someone already off their loop, who would otherwise stand in the road
 * until the player leaves.
 */
export function stepAside(state: PedestrianState, tick: number, id: number, pose: Pick<PedestrianPose, 'x' | 'y' | 'height'>, heading: number): void {
  if (state.casualties.length > 0 && casualtyOf(state, id) !== undefined) return;
  const i = state.startled.findIndex((record) => record.id === id);
  if (i >= 0) state.startled.splice(i, 1);
  addStartled(state, { id, reaction: 'scatter', since: tick, x: pose.x, y: pose.y, height: pose.height, heading });
}

/** Add a startled person, keeping the list in id order. */
function addStartled(state: PedestrianState, record: StartledPedestrian): void {
  let i = state.startled.length;
  while (i > 0 && (state.startled[i - 1] as StartledPedestrian).id > record.id) i--;
  state.startled.splice(i, 0, record);
}

/**
 * Where company glance at each other: now and then the head turns towards the
 * others, the first of them to their left, the rest to their right. A function
 * of the moment of the loop, so a replay agrees.
 */
function glance(person: AmbientPedestrian, at: number): number {
  const wave = sin((2 * Math.PI * at) / GLANCE_TICKS + person.lead * 1.7);
  const toward = person.beside < 0 ? 1 : -1;
  return toward * GLANCE * Math.max(0, wave) * (person.id === person.lead ? 1 : 0.8);
}

/** A turn from one heading to another, `t` of the way, the short way round. */
function turn(from: number, to: number, t: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return from + d * t;
}

/** Slow at both ends, for a step to one side. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

/** The entry of a list ascending by id, or undefined. */
function byId<T extends { id: number }>(list: readonly T[], id: number): T | undefined {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = (list[mid] as T).id;
    if (at === id) return list[mid];
    if (at < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}
