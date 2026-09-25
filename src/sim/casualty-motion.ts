/**
 * Where a person who has been hit is, at any moment (spec sections 11.6, 13.1).
 *
 * `casualty.ts` holds the rules: who is hit, how hard, and what it costs the
 * player. This holds the record of one casualty and the motion that record
 * implies. The motion is a closed form of the record and the tick, like the
 * startled crowd's (`startledPose`), so a replay throws the same body the same
 * way and a save caught mid-throw carries on exactly.
 *
 * A hit starts a motion from where the person stood. A fast car lifts them:
 * they fly an arc over the hood and tumble, land, and slide to a stop. A round
 * or a blow knocks them down where they stood, and they slide a little way. A
 * light blow only staggers them. The dead lie where they stop. The wounded lie
 * for a while, then get up and limp or run off, and the badly wounded crawl.
 *
 * A wall stops a body: the physics measures how far the push could carry it
 * when the hit lands, and the motion never goes further than that.
 */
import { cos, sin } from '../core/libm.ts';
import { TICK_RATE } from './clock.ts';

/** What hit a person. */
export type CasualtyCause = 'shot' | 'blow' | 'blast' | 'car';

/** One person who has been hit, and the motion the last hit started. */
export interface Casualty {
  /** Their id in the crowd. */
  id: number;
  /** The tick of the hit that started the motion below. */
  since: number;
  /** The tick of their first hit, which the onlookers and the expiry count from. */
  first: number;
  cause: CasualtyCause;
  /** Health left, out of {@link PERSON_HEALTH}. Zero is dead. */
  health: number;
  /** Where the motion starts: the ground under their hips. `y` is the map's; `height` is up. */
  x: number;
  y: number;
  height: number;
  /** The height of the ground where the throw ends. */
  rest: number;
  /** The way they faced when hit. */
  heading: number;
  /** The way the hit pushed them. */
  dir: number;
  /** Metres per second along `dir` the hit gave them. */
  push: number;
  /** Metres per second up the hit gave them: above zero only for a fast car. */
  lift: number;
  /** Metres along `dir` before something solid stops them. */
  reach: number;
  /**
   * Ticks they lie before they get up: 0 for a stagger that never takes them
   * off their feet, and -1 for someone who stays down.
   */
  down: number;
  /** -1 or 1: which way a fall twists them and a throw spins them. */
  side: number;
  /** Dollars on the body, which a player walking over it takes. */
  cash: number;
  /** True once the body has been taken away: nothing draws it or hits it again. */
  gone: boolean;
  /** The tick a car last went over them, or -1. */
  bumped: number;
  /**
   * The world place and turn of each bone while the Rapier ragdoll of
   * `ragdoll.ts` holds them, and where it left them after, until they get up.
   * Null while the motion above says where they are.
   *
   * Seven numbers a bone, in the order of the rig's bones (`RAGDOLL_BONES`):
   * `x`, the height, the map's `y`, then the turn as a quaternion `qx, qy, qz,
   * qw`. A bone's frame is the rig's: its origin is its joint, where it stands
   * in the bind pose, and not the middle of its box, and a turn of identity is
   * the bind pose facing a heading of 0. So the rig's boxes go on unchanged.
   * The body is `STRIDE_HEIGHT` tall (`pedestrian-look.ts`), whatever the
   * person's own height.
   *
   * It is live, and the ragdoll still moving, while `push` or `lift` is above
   * zero; freezing zeroes both.
   */
  ragdoll: number[] | null;
}

/** A person's health when unhurt. */
export const PERSON_HEALTH = 100;

/** Metres per second squared a body falls at. */
const FALL_GRAVITY = 9.81;

/** Metres per second squared a body sliding over the road slows at. */
const SLIDE_DECEL = 7;

/** The share of their speed a thrown body keeps when it lands. */
const LANDING_KEEP = 0.5;

/** Ticks a knocked-down person takes to go from standing to lying. */
export const FALL_TICKS = Math.round(0.6 * TICK_RATE);

/** Ticks a stagger lasts before they run. */
const STAGGER_TICKS = Math.round(0.5 * TICK_RATE);

/** Ticks it takes to get up. */
export const RISE_TICKS = Math.round(1.2 * TICK_RATE);

/** Turns a second a thrown body spins through, per metre a second of the throw. */
export const TUMBLE_RATE = 0.06;

/** How fast, and for how long, the wounded move off once they are up again. */
const AFTER: Record<'limp' | 'run' | 'crawl', { speed: number; ticks: number }> = {
  limp: { speed: 1.1, ticks: 12 * TICK_RATE },
  run: { speed: 4, ticks: 8 * TICK_RATE },
  crawl: { speed: 0.3, ticks: 30 * TICK_RATE },
};

/** Metres clear of a wall a wounded person needs to move off the way they were pushed. */
const WALL_ROOM = 3;

/** Health below which the wounded limp rather than run, and below which they crawl. */
const LIMP_BELOW = 60;
const CRAWL_BELOW = 25;

/** What a casualty is doing. */
type CasualtyPhase =
  /** Knocked back a step, still on their feet. */
  | 'stagger'
  /** Going over, from standing to lying. */
  | 'fall'
  /** Thrown, in the air. */
  | 'air'
  /** On the ground: sliding, or still. */
  | 'lie'
  /** Getting back up. */
  | 'rise'
  | 'crawl'
  | 'limp'
  | 'run'
  /** Up again and standing, once the running is done. */
  | 'stand';

/** Where a casualty is at a moment, and what they are doing. */
export interface CasualtyPose {
  /** The ground under their hips, and its height. */
  x: number;
  y: number;
  height: number;
  /** Metres above the ground: above zero only in the air. */
  lift: number;
  /** The way they faced when hit. */
  heading: number;
  /** The way they were pushed, and the way they move off. */
  dir: number;
  phase: CasualtyPhase;
  /** How far through a `fall` or a `rise`, 0 to 1. */
  progress: number;
  /** Radians a thrown body has spun through. */
  tumble: number;
  /** How far through the walk cycle of a `crawl`, `limp` or `run`, 0 to 1. */
  cycle: number;
  /** Metres per second they move at. */
  speed: number;
}

export function emptyCasualtyPose(): CasualtyPose {
  return { x: 0, y: 0, height: 0, lift: 0, heading: 0, dir: 0, phase: 'lie', progress: 0, tumble: 0, cycle: 0, speed: 0 };
}

/** The way a wounded person moves off, from the health they have left. */
function afterOf(record: Casualty): 'limp' | 'run' | 'crawl' {
  if (record.health < CRAWL_BELOW) return 'crawl';
  return record.health < LIMP_BELOW ? 'limp' : 'run';
}

/** Seconds a throw takes, in the air and sliding, and the metres it carries over each. */
export function throwOf(record: Casualty): { air: number; slide: number; airDistance: number; slideDistance: number } {
  const air = record.lift > 0 ? (2 * record.lift) / FALL_GRAVITY : 0;
  const landing = record.lift > 0 ? record.push * LANDING_KEEP : record.push;
  const slide = landing / SLIDE_DECEL;
  return { air, slide, airDistance: record.push * air, slideDistance: (landing * landing) / (2 * SLIDE_DECEL) };
}

/** Ticks from the hit until the body comes to rest. */
export function restTicks(record: Casualty): number {
  const t = throwOf(record);
  const settle = record.down === 0 ? STAGGER_TICKS : FALL_TICKS;
  return Math.max(settle, Math.ceil((t.air + t.slide) * TICK_RATE));
}

/** Where the body comes to rest, along `dir` from where it was hit. */
export function restDistance(record: Casualty): number {
  const t = throwOf(record);
  return Math.min(record.reach, t.airDistance + t.slideDistance);
}

/**
 * Where a casualty is at a moment, which may fall between two ticks: the
 * renderer draws them between the last two.
 */
export function casualtyPose(record: Casualty, time: number, out: CasualtyPose): CasualtyPose {
  const t = Math.max(0, time - record.since) / TICK_RATE;
  const flight = throwOf(record);
  const rest = restDistance(record);
  const settled = restTicks(record) / TICK_RATE;
  out.heading = record.heading;
  out.dir = record.dir;
  out.lift = 0;
  out.tumble = 0;
  out.cycle = 0;
  out.progress = 0;
  out.speed = 0;
  let along: number;
  if (t < flight.air) {
    along = record.push * t;
    out.lift = record.lift * t - (FALL_GRAVITY * t * t) / 2;
    out.tumble = record.side * 2 * Math.PI * TUMBLE_RATE * record.push * t;
    out.phase = 'air';
    out.speed = record.push;
  } else {
    const s = Math.min(t - flight.air, flight.slide);
    const landing = flight.slide * SLIDE_DECEL;
    along = flight.airDistance + landing * s - (SLIDE_DECEL * s * s) / 2;
    out.tumble = record.side * 2 * Math.PI * TUMBLE_RATE * record.push * flight.air;
    out.speed = Math.max(0, landing - SLIDE_DECEL * s);
    const settle = (record.down === 0 ? STAGGER_TICKS : FALL_TICKS) / TICK_RATE;
    if (record.lift <= 0 && t < settle) {
      out.phase = record.down === 0 ? 'stagger' : 'fall';
      out.progress = t / settle;
    } else {
      out.phase = record.down === 0 ? 'stand' : 'lie';
    }
  }
  along = Math.min(along, rest);
  const share = rest > 0 ? along / rest : 1;
  out.x = record.x + cos(record.dir) * along;
  out.y = record.y + sin(record.dir) * along;
  out.height = record.height + (record.rest - record.height) * share;
  if (t < settled || record.down < 0) return out;
  // At rest. The dead stay there; the rest get up, or crawl, and move off.
  const lying = record.down / TICK_RATE;
  const up = t - settled - lying;
  if (up < 0) {
    out.phase = 'lie';
    return out;
  }
  const after = afterOf(record);
  let moving = up;
  if (after !== 'crawl' && record.down > 0) {
    if (up < RISE_TICKS / TICK_RATE) {
      out.phase = 'rise';
      out.progress = up / (RISE_TICKS / TICK_RATE);
      return out;
    }
    moving = up - RISE_TICKS / TICK_RATE;
  }
  const spec = AFTER[after];
  const still = moving >= spec.ticks / TICK_RATE;
  let distance = Math.min(moving, spec.ticks / TICK_RATE) * spec.speed;
  // They move off the way they were pushed, unless a wall is close that way:
  // then along it, to the side they fell towards.
  const room = record.reach - rest;
  const away = room >= WALL_ROOM ? record.dir : record.dir + record.side * (Math.PI / 2);
  if (room >= WALL_ROOM) distance = Math.min(distance, room);
  out.x += cos(away) * distance;
  out.y += sin(away) * distance;
  out.height = record.rest;
  out.heading = away;
  out.dir = away;
  out.speed = still ? 0 : spec.speed;
  const stride = after === 'crawl' ? 0.5 : after === 'run' ? 2.2 : 0.9;
  const cycles = distance / stride;
  out.cycle = cycles - Math.floor(cycles);
  out.phase = still ? (after === 'crawl' ? 'lie' : 'stand') : after;
  return out;
}

/** True where a pose stands on its feet, so a round meets a standing body rather than one lying down. */
export function upright(pose: CasualtyPose): boolean {
  switch (pose.phase) {
    case 'stagger':
    case 'limp':
    case 'run':
    case 'stand':
      return true;
    case 'rise':
    case 'fall':
      return pose.progress < 0.5 === (pose.phase === 'fall');
    default:
      return false;
  }
}
