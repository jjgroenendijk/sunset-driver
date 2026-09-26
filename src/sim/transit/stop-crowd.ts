/**
 * The people waiting on a tram stop's island platform (spec section 13.2).
 *
 * They do not stand in a line. The first to come take the shelter, and the
 * rest spread out along the platform towards where the doors will be, each on
 * a spot of their own. Some face the track, some look up the line for the
 * tram, some are on their phones or have their arms folded, and a pair now
 * and then stands talking. Each walks in up the ramp at the nearer end of the
 * platform, and when a tram opens its doors each walks to the nearest one and
 * is gone once through it.
 *
 * Like the queues of `stop-queue.ts`, nothing here is stepped. The spots are
 * laid down once for a world from the seed, and where each person is on a tick
 * is read from the ticks since the last tram left and how far into its halt
 * the one standing there now is.
 */
import { atan2, cos, hypot, sin } from '../../core/libm.ts';
import type { Rng } from '../../core/rng.ts';
import { TICK_RATE } from '../clock.ts';
import type { Gait, PedestrianLook } from '../crowd/pedestrian-look.ts';
import { PAVEMENT_RISE } from '../crowd/pedestrian-route.ts';
import { emptyPose } from '../crowd/pedestrians.ts';
import { RouteSampler, type RouteLegs, type RoutePoint } from '../traffic/route-sample.ts';
import type { StopQueue, WaitingPassenger } from './stop-queue.ts';

/** Metres per second a person walks up to a spot or to a door. */
const WALK = 1.25;
/** Metres of one whole walk cycle: two steps. */
const STRIDE = 1.5;
/** Ticks of one sway of the weight from foot to foot, standing. */
const SWAY_TICKS = 5 * TICK_RATE;
/** Ticks between one person stepping through a door and the next through the same one. */
const DOOR_TURN = Math.round(1.2 * TICK_RATE);
/** Metres two people keep apart on the platform, except a pair who stand talking. */
const APART = 0.9;
/** Metres a pair talking stand from each other. */
const TALK_APART = 0.75;
/** Metres out from the tram's side a person stands to step through a door. */
const DOOR_STAND = 0.35;

/** The standing gaits a person waiting uses, by weight. */
const IDLE: readonly [Gait, number][] = [
  ['stand', 5],
  ['phone', 3],
  ['fold', 2],
  ['smoke', 0.6],
];

/** The fields of one person's spot in {@link StopCrowd.spots}. */
const FIELDS = 5;

/** Where the people of one platform wait, and where they come from. */
export interface StopCrowd extends StopQueue {
  /** For each person: `x`, `y`, `height`, `heading` and the ramp end they come in from, -1 or 1. */
  spots: Float64Array;
  /** What each person does standing there. */
  gaits: Gait[];
  /** Where each person's sway starts, 0 to 1, so nobody sways in step. */
  phases: Float64Array;
  /** Radians each person has their head turned. */
  glances: Float64Array;
  /** The two ramp ends of the platform: `x`, `y` of the far end, then the near. */
  ends: Float64Array;
  /** For each fleet the stop may be called at by, each person's door: `x`, `y` and metres to it. */
  doors: Float64Array[];
  /** How many people are ahead of each at their door, for each fleet. */
  turns: Int32Array[];
}

/** The platform a crowd waits on: its middle round the loop, how long it is, and how far across the track. */
export interface PlatformFrame {
  route: RouteLegs;
  middle: number;
  length: number;
  across: number;
  /** Metres either side of `across` a person may stand, inside the kerbs. */
  spread: number;
}

/**
 * Lay down one spot per look on a platform. The spots crowd round the middle,
 * where the shelter is, for the first to come and spread out for the later
 * ones. `point` is scratch the caller owns.
 */
export function layCrowd(sampler: RouteSampler, frame: PlatformFrame, looks: readonly PedestrianLook[], rng: Rng, point: RoutePoint): StopCrowd {
  const count = looks.length;
  const crowd: StopCrowd = {
    places: new Float64Array(0),
    looks,
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    spots: new Float64Array(count * FIELDS),
    gaits: [],
    phases: new Float64Array(count),
    glances: new Float64Array(count),
    ends: new Float64Array(4),
    doors: [],
    turns: [],
  };
  const reach = frame.length / 2 - 1.5;
  const placed: { along: number; across: number }[] = [];
  for (let i = 0; i < count; i++) placePerson(crowd, i, sampler, frame, rng, placed, reach, point);
  for (const side of [-1, 1]) {
    const at = sampler.sample(frame.route, frame.middle + side * (frame.length / 2 + 1.5), point);
    crowd.ends.set([at.x + at.rightX * frame.across, at.y + at.rightY * frame.across], side < 0 ? 0 : 2);
    grow(crowd, at.x + at.rightX * frame.across, at.y + at.rightY * frame.across);
  }
  return crowd;
}

/**
 * Give a crowd the doors of one fleet as it stands at the stop: `points` is
 * `x`, `y` of each doorway, where a person steps up into the tram. Each person
 * takes the nearest, and waits their turn behind whoever is nearer to it.
 */
export function setDoors(crowd: StopCrowd, points: readonly number[]): void {
  const count = crowd.looks.length;
  const doors = new Float64Array(count * 3);
  const which = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const x = crowd.spots[i * FIELDS] as number;
    const y = crowd.spots[i * FIELDS + 1] as number;
    let best = Infinity;
    for (let d = 0; d + 1 < points.length; d += 2) {
      const away = hypot((points[d] as number) - x, (points[d + 1] as number) - y);
      if (away >= best) continue;
      best = away;
      which[i] = d;
      doors.set([points[d] as number, points[d + 1] as number, away], i * 3);
    }
  }
  const turns = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      if (j !== i && which[j] === which[i] && ((doors[j * 3 + 2] as number) < (doors[i * 3 + 2] as number) || ((doors[j * 3 + 2] as number) === (doors[i * 3 + 2] as number) && j < i))) turns[i] = (turns[i] as number) + 1;
    }
  }
  crowd.doors.push(doors);
  crowd.turns.push(turns);
}

/** Where a platform's people are on a tick. */
export interface CrowdMoment {
  /** How many had come by the time the tram now standing there arrived, or have come since the last one left. */
  people: number;
  /** Ticks since the last tram left the stop. */
  since: number;
  /** Ticks into the halt of the tram standing there, or -1 while none is. */
  boarding: number;
  /** The fleet of the tram standing there, as an index into {@link StopCrowd.doors}. */
  fleet: number;
  /** Ticks a person takes after the tram comes to a stand before the doors are open. */
  opening: number;
  /** The tick, for the sway of the people standing. */
  time: number;
  /** Ticks between one person arriving and the next. */
  arrival: number;
}

/**
 * Write the people of a platform into `out` from `count` on, and give back
 * how many `out` now holds. Entries already in `out` are written over, so a
 * frame allocates nothing.
 */
export function writeCrowd(crowd: StopCrowd, moment: CrowdMoment, out: WaitingPassenger[], count: number): number {
  let at = count;
  for (let i = 0; i < moment.people; i++) {
    const entry = out[at] ?? { pose: emptyPose(), look: crowd.looks[i] as PedestrianLook };
    entry.look = crowd.looks[i] as PedestrianLook;
    const shown = moment.boarding < 0 ? arriving(crowd, i, moment, entry) : boarding(crowd, i, moment, entry);
    if (!shown) continue;
    out[at++] = entry;
  }
  return at;
}

/** A person between trams: walking in from the ramp, or waiting on their spot. False while not yet come. */
function arriving(crowd: StopCrowd, i: number, moment: CrowdMoment, entry: WaitingPassenger): boolean {
  const spot = i * FIELDS;
  const side = crowd.spots[spot + 4] as number;
  const fromX = crowd.ends[side < 0 ? 0 : 2] as number;
  const fromY = crowd.ends[side < 0 ? 1 : 3] as number;
  const toX = crowd.spots[spot] as number;
  const toY = crowd.spots[spot + 1] as number;
  const walk = hypot(toX - fromX, toY - fromY);
  // Person `i` comes up the ramp as the stop gathers its `i + 1`th, and walks to their spot.
  const walked = ((moment.since - (i + 1) * moment.arrival) / TICK_RATE) * WALK;
  if (walked >= walk || i + 1 < moment.people) {
    stand(crowd, i, moment.time, entry);
    return true;
  }
  if (walked < 0) return false;
  move(entry, fromX + ((toX - fromX) * walked) / walk, fromY + ((toY - fromY) * walked) / walk, crowd.spots[spot + 2] as number, atan2(toY - fromY, toX - fromX), walked);
  return true;
}

/**
 * A person while a tram stands at the stop: still on their spot until the
 * doors open, then walking to their door, waiting their turn there, and gone
 * once through it.
 */
function boarding(crowd: StopCrowd, i: number, moment: CrowdMoment, entry: WaitingPassenger): boolean {
  const doors = crowd.doors[moment.fleet];
  const turns = crowd.turns[moment.fleet];
  if (doors === undefined || turns === undefined) {
    stand(crowd, i, moment.time, entry);
    return true;
  }
  const spot = i * FIELDS;
  const x = crowd.spots[spot] as number;
  const y = crowd.spots[spot + 1] as number;
  const doorX = doors[i * 3] as number;
  const doorY = doors[i * 3 + 1] as number;
  const away = doors[i * 3 + 2] as number;
  const since = moment.boarding - moment.opening;
  if (since < 0) {
    stand(crowd, i, moment.time, entry);
    return true;
  }
  const walked = (since / TICK_RATE) * WALK;
  const reached = (away / WALK) * TICK_RATE;
  // Gone once through the door, after everyone ahead of them there.
  if (since >= reached + ((turns[i] as number) + 1) * DOOR_TURN) return false;
  if (walked >= away) {
    // At the door, waiting a turn: a step back for each person still ahead.
    const back = Math.max(0, (turns[i] as number) - Math.floor((since - reached) / DOOR_TURN)) * 0.5 + DOOR_STAND;
    const heading = atan2(doorY - y, doorX - x);
    entry.pose.x = doorX - cos(heading) * back;
    entry.pose.y = doorY - sin(heading) * back;
    entry.pose.height = crowd.spots[spot + 2] as number;
    entry.pose.heading = heading;
    still(entry, 'stand', 0);
    return true;
  }
  move(entry, x + ((doorX - x) * walked) / away, y + ((doorY - y) * walked) / away, crowd.spots[spot + 2] as number, atan2(doorY - y, doorX - x), walked);
  return true;
}

/** A person standing on their spot, doing what they do there. */
function stand(crowd: StopCrowd, i: number, time: number, entry: WaitingPassenger): void {
  const spot = i * FIELDS;
  entry.pose.x = crowd.spots[spot] as number;
  entry.pose.y = crowd.spots[spot + 1] as number;
  entry.pose.height = crowd.spots[spot + 2] as number;
  entry.pose.heading = crowd.spots[spot + 3] as number;
  still(entry, crowd.gaits[i] ?? 'stand', ((time / SWAY_TICKS + (crowd.phases[i] as number)) % 1 + 1) % 1);
  entry.pose.look = crowd.glances[i] as number;
}

function still(entry: WaitingPassenger, gait: Gait, cycle: number): void {
  const p = entry.pose;
  p.speed = 0;
  p.cycle = cycle;
  p.gait = gait;
  p.blend = 0;
  p.look = 0;
  p.hidden = false;
}

function move(entry: WaitingPassenger, x: number, y: number, height: number, heading: number, walked: number): void {
  const p = entry.pose;
  p.x = x;
  p.y = y;
  p.height = height;
  p.heading = heading;
  p.speed = WALK;
  p.cycle = (walked / STRIDE) % 1;
  p.gait = 'stroll';
  p.blend = 0;
  p.look = 0;
  p.hidden = false;
}

/** Lay down the spot of person `i`, clear of the `placed` before them, and what they do there. */
function placePerson(
  crowd: StopCrowd,
  i: number,
  sampler: RouteSampler,
  frame: PlatformFrame,
  rng: Rng,
  placed: { along: number; across: number }[],
  reach: number,
  point: RoutePoint,
): void {
  const talker = placed[i - 1];
  // Now and then two come together and stand talking face to face along the platform.
  const pair = i % 2 === 1 && talker !== undefined && rng.chance(0.35);
  const [along, across] = pair ? [talker.along + TALK_APART, talker.across] : freeSpot(rng, placed, reach, frame.spread, i);
  if (pair) {
    crowd.gaits[i - 1] = 'talk';
    crowd.glances[i - 1] = 0;
    crowd.spots[(i - 1) * FIELDS + 3] = travelOf(sampler.sample(frame.route, frame.middle + talker.along, point));
  }
  placed.push({ along, across });
  crowd.gaits[i] = pair ? 'talk' : pick(rng);
  crowd.phases[i] = rng.float();
  const at = sampler.sample(frame.route, frame.middle + along, point);
  const offset = frame.across + across;
  const x = at.x + at.rightX * offset;
  const y = at.y + at.rightY * offset;
  const heading = pair ? travelOf(at) + Math.PI : waitingHeading(rng, at);
  crowd.glances[i] = pair ? 0 : rng.range(-0.6, 0.6);
  crowd.spots.set([x, y, at.height + PAVEMENT_RISE, heading, along >= 0 ? 1 : -1], i * FIELDS);
  grow(crowd, x, y);
}

/**
 * A spot on the platform clear of everyone already there: `along` it and
 * `across` it from the middle. The first few crowd round the shelter, and the
 * later ones spread out towards the ends.
 */
function freeSpot(rng: Rng, placed: readonly { along: number; across: number }[], reach: number, spread: number, i: number): [number, number] {
  let along = 0;
  let across = 0;
  for (let tries = 0; tries < 12; tries++) {
    along = Math.max(-reach, Math.min(reach, rng.gaussian() * (2 + i * 1.6)));
    across = rng.range(-spread, spread);
    if (placed.every((p) => Math.abs(p.along - along) + Math.abs(p.across - across) >= APART)) break;
  }
  return [along, across];
}

/** The heading of travel at a point of the platform. The right hand points a quarter turn clockwise of it. */
function travelOf(at: RoutePoint): number {
  return atan2(at.rightX, -at.rightY);
}

/**
 * Which way somebody waiting faces: most face the track, which is left of
 * travel, the way the right hand points back; some turn to look up the line
 * for the tram.
 */
function waitingHeading(rng: Rng, at: RoutePoint): number {
  const toTrack = atan2(-at.rightY, -at.rightX);
  return toTrack + (rng.chance(0.3) ? -Math.PI / 2 + rng.range(-0.4, 0.4) : rng.range(-0.7, 0.7));
}

function pick(rng: Rng): Gait {
  let total = 0;
  for (const [, weight] of IDLE) total += weight;
  let roll = rng.float() * total;
  for (const [gait, weight] of IDLE) {
    roll -= weight;
    if (roll < 0) return gait;
  }
  return 'stand';
}

function grow(crowd: StopCrowd, x: number, y: number): void {
  crowd.minX = Math.min(crowd.minX, x - 1);
  crowd.minY = Math.min(crowd.minY, y - 1);
  crowd.maxX = Math.max(crowd.maxX, x + 1);
  crowd.maxY = Math.max(crowd.maxY, y + 1);
}
