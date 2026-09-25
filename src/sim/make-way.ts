/**
 * The crowd making way for the player on foot (spec sections 11.2, 20.1).
 *
 * A person walking at the player, or standing in their path, steps to one side
 * as the player comes near — the side they already stand on of the player's
 * line, so the two pass — and steps back onto their lane once the player has
 * gone by. Anybody near turns their head to the player. A player sprinting
 * into a person makes them jump clear.
 *
 * The step is the one part of the crowd's walk that depends on the player, so
 * it is stored (`crowd-aside.ts`) and stepped here once a tick. Only people
 * within {@link MAKE_WAY_REACH} are held in the list; everybody else is on
 * their lane and looking ahead, and costs nothing.
 */
import { atan2, cos, hypot, sin } from '../core/libm.ts';
import { TICK_RATE } from './clock.ts';
import type { Aside } from './crowd-aside.ts';
import type { CrowdSource } from './melee.ts';
import { WALK_SPEED } from './on-foot.ts';
import { casualtyOf, emptyPose, startledOf, type PedestrianState } from './pedestrians.ts';
import { heldTime } from './hold.ts';
import type { SimState } from './simulation.ts';

/** Metres from the player within which people make way and look. */
const MAKE_WAY_REACH = 4.5;

/** Metres either side of the player's line a person has to be to let them by. */
const PASS_ROOM = 0.9;

/** Metres a person steps aside at most. */
export const MAKE_WAY_MOST = 0.85;

/** Metres per second a person steps aside and back at. */
const STEP_PACE = 1.1;

/** Radians per second a head turns at, and the most it turns from the body. */
const LOOK_PACE = 3;
const LOOK_MOST = 1.3;

/** Metres within which a player sprinting at a person makes them jump clear. */
const BARGE_REACH = 0.8;

/** Metres per second above which the player is running, not walking. */
const BARGE_SPEED = WALK_SPEED + 1;

/** What a person needs of the player this tick: how far aside they should stand, and where to look. */
interface Want {
  off: number;
  side: number;
  look: number;
}

/**
 * Step the people near the player on foot aside, or back, by one tick.
 * `ids` is a scratch list the lookup writes into.
 */
export function stepMakeWay(state: SimState, crowd: CrowdSource, ids: number[] = []): void {
  const peds = state.pedestrians;
  const p = state.player;
  const on = !p.driving;
  const next: Aside[] = [];
  const want: Want = { off: 0, side: 0, look: 0 };
  const pose = emptyPose();
  // Everybody already stepping aside moves towards what they want, and is kept while they still stand off.
  if (on) crowd.near(p.x - MAKE_WAY_REACH, p.y - MAKE_WAY_REACH, p.x + MAKE_WAY_REACH, p.y + MAKE_WAY_REACH, ids);
  else ids.length = 0;
  const found = on ? ids.slice().sort((a, b) => a - b) : [];
  let a = 0;
  let b = 0;
  const list = peds.aside;
  while (a < list.length || b < found.length) {
    const had = list[a];
    const id = b < found.length ? (found[b] as number) : Infinity;
    const at = had === undefined ? Infinity : had.id;
    const key = Math.min(at, id);
    if (at === key) a++;
    if (id === key) b++;
    const record: Aside = at === key ? { ...(had as Aside) } : { id: key, off: 0, side: 0, look: 0 };
    // Somebody who has chosen a side keeps to it, so nobody dithers in front of the player.
    want.side = record.side;
    if (!on || !free(peds, key) || !wanted(state, crowd, key, pose, want)) {
      want.off = 0;
      want.side = record.side;
      want.look = 0;
    }
    if (want.off !== 0) record.side = want.side;
    move(record, want);
    if (Math.abs(record.off) > 1e-3 || Math.abs(record.look) > 1e-3) next.push(record);
  }
  peds.aside = next;
  if (on && p.speed > BARGE_SPEED) {
    crowd.startle(peds, state.tick, p.x, p.y, BARGE_REACH, 'scatter', ids);
  }
}

/** True for somebody still on their loop: not startled, not hurt. */
function free(peds: PedestrianState, id: number): boolean {
  if (peds.startled.length > 0 && startledOf(peds, id) !== undefined) return false;
  return peds.casualties.length === 0 || casualtyOf(peds, id) === undefined;
}

/**
 * What one person wants of the player: to stand aside if they are in the
 * player's way, and to look at them if they are near. False for somebody out
 * of reach or out of sight indoors.
 */
function wanted(state: SimState, crowd: CrowdSource, id: number, pose: ReturnType<typeof emptyPose>, want: Want): boolean {
  const p = state.player;
  crowd.poseAt(id, heldTime(state.pedestrians.held, id, state.tick), pose);
  if (pose.hidden === true) return false;
  const dx = pose.x - p.x;
  const dy = pose.y - p.y;
  const gap = hypot(dx, dy);
  if (gap > MAKE_WAY_REACH) return false;
  // Where the person is against the player's line: ahead of them, and how far to the right.
  const ahead = dx * cos(p.heading) + dy * sin(p.heading);
  const right = -dx * sin(p.heading) + dy * cos(p.heading);
  // The player's way: the line they face while they move, or a small ring round them while they stand.
  const inWay = p.speed > 0.3 ? ahead > -0.3 && Math.abs(right) < PASS_ROOM : gap < PASS_ROOM * 0.7;
  if (inWay) {
    // Away from the player's line, on the side of it they already stand: +1 the player's right.
    const side = want.side !== 0 ? want.side : right >= 0 ? 1 : -1;
    want.side = side;
    // Far enough that the player's line is PASS_ROOM off, and no further than a step.
    const need = PASS_ROOM - side * right;
    // The player's right is their own right as far as the two face the same way.
    const theirs = side * (cos(p.heading - pose.heading) >= 0 ? 1 : -1);
    want.off = theirs * Math.min(MAKE_WAY_MOST, Math.max(0, need));
  } else {
    want.off = 0;
  }
  let look = atan2(-dy, -dx) - pose.heading;
  look -= 2 * Math.PI * Math.round(look / (2 * Math.PI));
  // A head turns to the player only where it can without turning the body.
  want.look = Math.abs(look) > LOOK_MOST + 0.4 ? 0 : Math.max(-LOOK_MOST, Math.min(LOOK_MOST, look));
  return true;
}

/** Move a record one tick towards what the person wants, at a walking step and a turn of the head. */
function move(record: Aside, want: Want): void {
  const step = STEP_PACE / TICK_RATE;
  record.off += Math.max(-step, Math.min(step, want.off - record.off));
  const turn = LOOK_PACE / TICK_RATE;
  record.look += Math.max(-turn, Math.min(turn, want.look - record.look));
  if (want.off === 0 && record.off === 0) record.side = 0;
}
