/**
 * The people who get off a bus at a stop (spec section 20.2).
 *
 * The queue at a stop boards at the front door (`bus-stops.ts`). A few people
 * step off at the back door once the bus has stood a moment, one after
 * another. Each steps up onto the pavement, walks off away from the queue, and
 * turns in at the building line, where they go out of sight.
 *
 * Like the queue, nobody is stepped: how many get off a bus, and who they are,
 * comes from the stop, the call and which lap of its tour the bus is on, and
 * where each of them is comes from the ticks since the bus arrived.
 */
import { hashInts } from '../../core/hash.ts';
import { atan2 } from '../../core/libm.ts';
import { TICK_RATE } from '../clock.ts';
import { strideOf, type PedestrianLook } from '../crowd/pedestrian-look.ts';
import { PAVEMENT_RISE } from '../crowd/pedestrian-route.ts';
import type { PedestrianPose } from '../crowd/pedestrians.ts';
import type { RouteLegs, RoutePoint, RouteSampler } from '../traffic/route-sample.ts';

/** Metres behind the call the back door stands. */
const BACK_DOOR = 3;

/** Ticks after the bus stops before the first person steps off, and between one and the next. */
export const DOORS_OPEN = Math.round(1.2 * TICK_RATE);
export const ALIGHT_GAP = Math.round(1.1 * TICK_RATE);

/** The most people who get off one bus. */
export const ALIGHT_MOST = 3;

/** Metres an alighting passenger walks along the pavement before they turn in. */
export const WALK_OFF = 16;

/** Metres per second they walk at, and ticks the step down off the bus takes. */
const PACE = 1.3;
const STEP_DOWN = Math.round(0.8 * TICK_RATE);

/** Metres they walk to reach the building line as they turn in. */
const TURN_IN = 1.5;

/** Ticks from stepping off the bus to out of sight. */
const ALIGHT_TICKS = STEP_DOWN + Math.ceil(((WALK_OFF + TURN_IN) / PACE) * TICK_RATE);

/** The ticks since a bus called that its last passenger is still in sight: how long a call is read for. */
export const ALIGHT_SPAN = DOORS_OPEN + (ALIGHT_MOST - 1) * ALIGHT_GAP + ALIGHT_TICKS;

/** The stream the number getting off each bus is drawn from. */
const COUNT_STREAM = 0x5d0a;

/** Where on a stop's kerb people get off: the leg and the call, and the lane, kerb and building line offsets. */
export interface AlightSite {
  leg: RouteLegs;
  call: number;
  /** Metres right of the road's centreline: the kerb, the lane walked, and the building line. */
  kerb: number;
  lane: number;
  wall: number;
}

/** How many get off the bus making call `call` of a stop, on lap `lap` of its tour. */
export function alighting(edge: number, call: number, lap: number, seed: number): number {
  return (hashInts(COUNT_STREAM, seed, edge, call, lap) >>> 0) % (ALIGHT_MOST + 1);
}

/**
 * Where a passenger who stepped off `t` ticks ago stands, written into `out`.
 * Returns false once they have turned in and gone.
 */
export function alightPose(sampler: RouteSampler, site: AlightSite, t: number, point: RoutePoint, out: PedestrianPose): boolean {
  if (t < 0 || t >= ALIGHT_TICKS) return false;
  const door = site.call - BACK_DOOR;
  let along = door;
  let across: number;
  let facing: 'out' | 'away' = 'away';
  let speed = PACE;
  if (t < STEP_DOWN) {
    // Down off the bus and across the kerb to the walk.
    const f = t / STEP_DOWN;
    across = site.kerb + (site.lane - site.kerb) * f;
    facing = 'out';
    speed = (site.lane - site.kerb) / (STEP_DOWN / TICK_RATE);
  } else {
    const walked = ((t - STEP_DOWN) / TICK_RATE) * PACE;
    if (walked < WALK_OFF) {
      along = door - walked;
      across = site.lane;
    } else {
      // Off the walk towards a door in the building line.
      const f = Math.min(1, (walked - WALK_OFF) / TURN_IN);
      along = door - WALK_OFF;
      across = site.lane + (site.wall - site.lane) * f;
      facing = 'out';
    }
  }
  const at = sampler.sample(site.leg, Math.max(0, along), point);
  out.x = at.x + at.rightX * across;
  out.y = at.y + at.rightY * across;
  out.height = at.height + PAVEMENT_RISE;
  // Out of the road is to the right of the travel; away from the queue is against it.
  out.heading = facing === 'out' ? atan2(at.rightY, at.rightX) : atan2(at.rightX, -at.rightY);
  out.speed = speed;
  const cycles = (t / TICK_RATE) * (PACE / strideOf('stroll', 1.75));
  out.cycle = cycles - Math.floor(cycles);
  out.gait = 'stroll';
  out.from = 'stroll';
  out.fromCycle = out.cycle;
  out.blend = 0;
  out.look = 0;
  out.hidden = false;
  return true;
}

/** Which of a stop's looks the `k`th passenger off a bus on lap `lap` wears. */
export function alighterLook(looks: readonly PedestrianLook[], lap: number, k: number): PedestrianLook {
  const n = looks.length;
  return looks[((((lap * ALIGHT_MOST + k) % n) + n) % n)] as PedestrianLook;
}
