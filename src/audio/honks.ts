/**
 * The horns of the traffic (spec section 20.2): a driver who has stood behind
 * the player, their car, a wreck or somebody in the road honks at it.
 *
 * Nothing is stored for it. Giving way counts the ticks a car has stood for
 * one of these in its hold (`Hold.waited`), one a tick, so the honks are a
 * function of that count: the first comes after the driver's own patience,
 * and the rest follow at a pace of their own, fewer as they give up. A frame
 * asks about every tick it stepped, as the tram's bells do, so no honk is
 * heard twice or lost between two frames.
 */
import { hashInts } from '../core/hash.ts';
import { TICK_RATE } from '../sim/clock.ts';
import type { SimState } from '../sim/simulation.ts';
import type { Personality } from '../sim/traffic/driver.ts';
import { heldPose, type Hold } from '../sim/traffic/hold.ts';
import type { AmbientPose } from '../sim/traffic/traffic.ts';
import { cueAt as cueOf, type Cue } from './cue.ts';

/** What the honks read of the traffic: who drives each car, and where a car stands. */
export interface HonkSource {
  readonly vehicles: readonly { readonly driver: { readonly personality: Personality } }[];
  poseAt(id: number, time: number, out: AmbientPose): AmbientPose;
}

/** Seconds a driver of each kind stands before the first honk. */
const PATIENCE: Readonly<Record<Personality, number>> = Object.freeze({
  hesitant: 7,
  careful: 5,
  steady: 3.5,
  brisk: 2,
  tailgater: 1,
});

/** Seconds between two honks at the least, and how many a driver gives before they give up. */
const AGAIN = 2.5;
const MOST = 6;

/** Metres from the listener a honk is heard within. */
const HONK_REACH = 70;

/** How loud a honk is at the listener, and how many one frame may fire. */
const HONK_STRENGTH = 0.55;
const HONKS_PER_FRAME = 2;

/** The pitch of the second note of a horn over the first: a minor third. */
const THIRD = 1.19;

/** The key of the stream a driver's pace between honks is drawn from. */
const HONK_STREAM = 0x40a7;

/**
 * The honks of the ticks after `was` up to the record's own, near the
 * listener at `(x, y)`, pushed onto `cues`.
 */
export function hearHonks(state: SimState, was: number, traffic: HonkSource, x: number, y: number, cues: Cue[]): void {
  const holds = state.traffic.held;
  const ticks = state.tick - was;
  let fired = 0;
  const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  for (const hold of holds.list) {
    if (fired >= HONKS_PER_FRAME) return;
    if (hold.waited <= 0 || !honked(traffic, hold, ticks)) continue;
    heldPose(traffic, holds, hold.id, state.tick, pose);
    if (Math.abs(pose.x - x) > HONK_REACH || Math.abs(pose.y - y) > HONK_REACH) continue;
    const low = cueOf(state.seed, state.tick, 'honk', pose.x, pose.y, HONK_STRENGTH, hashInts(HONK_STREAM, hold.id));
    cues.push(low, { ...low, pitch: low.pitch * THIRD });
    fired++;
  }
}

/** True when car `hold.id` honked on any of the last `ticks` ticks of its wait. */
function honked(traffic: HonkSource, hold: Hold, ticks: number): boolean {
  const vehicle = traffic.vehicles[hold.id];
  if (vehicle === undefined) return false;
  const first = Math.round(PATIENCE[vehicle.driver.personality] * TICK_RATE);
  // Each driver keeps a pace of their own between honks, drawn from their id.
  const every = Math.round((AGAIN + (hashInts(HONK_STREAM, hold.id) % 100) / 40) * TICK_RATE);
  for (let back = 0; back < ticks; back++) {
    const waited = hold.waited - back;
    if (waited < first) return false;
    const since = waited - first;
    if (since % every === 0 && since / every < MOST) return true;
  }
  return false;
}
