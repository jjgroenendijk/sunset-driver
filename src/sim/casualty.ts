/**
 * People in the crowd who are hurt and killed (spec sections 11.6, 13.1, 14,
 * 20.1, 20.3).
 *
 * A person of the crowd has no health until something hits them. The first
 * hit takes them off their loop and writes them into
 * `SimState.pedestrians.casualties`, with the health they have left and the
 * motion the hit started (`casualty-motion.ts`). A second hit takes more health
 * off and starts a new motion from wherever the first one had got them to.
 *
 * What a hit costs the player is here too: the crime the police weigh, the
 * fright it gives the people round it, the ambulance somebody calls, and the
 * cash the dead drop. {@link stepCasualties} runs what follows: the onlookers
 * who come to look, the cash a player picks up, and the bodies taken away.
 *
 * Nothing here touches Rapier. `gunfire.ts` finds who a round or a blow met,
 * `car-strike.ts` who a car met, and the physics hands in a {@link CasualtyGround}
 * that says how far a push can carry someone before a wall stops them.
 */
import { hashInts } from '../core/hash.ts';
import { hypot } from '../core/libm.ts';
import { rngFor, Subsystem } from '../core/rng.ts';
import { TICK_RATE } from './clock.ts';
import { RELEASE_FAR } from './crowd-reaction.ts';
import { callAmbulance } from './emergency.ts';
import type { CrowdSource } from './melee.ts';
import { commitCrime } from './police.ts';
import type { Crime } from './crime.ts';
import { casualtyOf, type PedestrianPose, type PedestrianState } from './pedestrians.ts';
import type { SimState } from './simulation.ts';
import {
  casualtyPose,
  emptyCasualtyPose,
  PERSON_HEALTH,
  type Casualty,
  type CasualtyCause,
} from './casualty-motion.ts';

export { PERSON_HEALTH, type Casualty, type CasualtyCause } from './casualty-motion.ts';
export { casualtyOf };

/** What a hit does to a person: how much health it takes, and how it moves them. */
export interface Blow {
  cause: CasualtyCause;
  damage: number;
  /** The way it pushes them. */
  dir: number;
  /** Metres per second along `dir`. */
  push: number;
  /** Metres per second up: above zero only for a fast car. */
  lift: number;
}

/**
 * What the physics tells a hit about the ground: how far a body pushed along
 * a line gets before something solid stops it, and how high the ground is.
 * A ground with no physics leaves it out, and nothing stops a body.
 */
export interface CasualtyGround {
  reach(x: number, h: number, y: number, dir: number, max: number): number;
  heightAt(x: number, y: number): number;
}

/** Damage at or above which a hit knocks a person off their feet rather than staggering them. */
export const KNOCKDOWN = 20;

/** Seconds the knocked-down wounded lie before they get up, least and most. */
export const DOWN_SECONDS: readonly [number, number] = [3, 8];

/** Metres a wounding and a killing send the crowd running over. */
export const WOUND_FLEE = 12;
export const DEATH_FLEE = 30;

/** Ticks after a death before the onlookers come, and how far they come from. */
export const GATHER_DELAY = 10 * TICK_RATE;
export const GATHER_REACH = 35;

/** Dollars a dead person carries, least and most. */
export const CASH: readonly [number, number] = [5, 60];

/** Metres from a body a player on foot takes the cash from. */
export const CASH_REACH = 1.1;

/** Bodies that lie at once. One more takes the oldest away. */
export const BODY_CAP = 24;

/** Ticks a body lies before it is taken away unseen, if no ambulance has come: five minutes. */
export const BODY_LIFE = 5 * 60 * TICK_RATE;

/** Metres from the player a body has to be before it can be taken away unseen. */
export const BODY_UNSEEN = 120;

/** Metres a body is measured along before a wall is looked for, beyond the longest throw. */
const REACH_MAX = 60;

/** The keys of the streams a hit draws from. */
const HIT_STREAM = 1;

/** The crime a first hit of each cause is. */
const CRIMES: Record<CasualtyCause, Crime> = {
  shot: 'assault',
  blast: 'assault',
  blow: 'brawl',
  car: 'reckless',
};

/** True for a record of somebody dead. */
export function dead(record: Casualty): boolean {
  return record.health <= 0;
}

/**
 * Hit one person of the crowd, standing at `pose`, and answer their record.
 * Undefined where there was nobody to hit: a body already taken away.
 *
 * A person already hit is hit again from where their motion has got them to,
 * with the health they have left. A body is hit too, and pushed, but nothing
 * more happens to it: the crime and the fright were the killing's.
 */
export function hurtPerson(
  state: SimState,
  crowd: CrowdSource,
  id: number,
  pose: Pick<PedestrianPose, 'x' | 'y' | 'height' | 'heading'>,
  blow: Blow,
  ground?: CasualtyGround,
): Casualty | undefined {
  const peds = state.pedestrians;
  const was = casualtyOf(peds, id);
  if (was?.gone === true) return undefined;
  const already = was !== undefined && dead(was);
  const health = Math.max(0, (was?.health ?? PERSON_HEALTH) - Math.max(0, blow.damage));
  const rng = rngFor(state.seed, state.tick, Subsystem.Casualties, hashInts(HIT_STREAM, id));
  const heavy = blow.damage >= KNOCKDOWN || blow.lift > 0 || blow.cause === 'car' || blow.cause === 'blast';
  let down = 0;
  if (health <= 0) down = -1;
  else if (heavy || (was !== undefined && was.down !== 0)) {
    down = Math.round(rng.range(DOWN_SECONDS[0], DOWN_SECONDS[1]) * TICK_RATE);
  }
  const side = rng.chance(0.5) ? 1 : -1;
  const h = pose.height;
  const reach = ground === undefined ? REACH_MAX : ground.reach(pose.x, h + 0.9, pose.y, blow.dir, REACH_MAX);
  const record: Casualty = {
    id,
    since: state.tick,
    first: was?.first ?? state.tick,
    cause: blow.cause,
    health,
    x: pose.x,
    y: pose.y,
    height: h,
    rest: h,
    heading: pose.heading,
    dir: blow.dir,
    push: Math.max(0, blow.push),
    lift: Math.max(0, blow.lift),
    reach: Math.max(0, reach),
    down,
    side,
    cash: was?.cash ?? 0,
    gone: false,
    bumped: was?.bumped ?? -1,
    // The bones as the ragdoll last left them, so a body hit again is thrown
    // from where it lies (`ragdoll.ts`), which drops them if it builds none.
    ragdoll: was?.ragdoll ?? null,
  };
  if (ground !== undefined) {
    const end = casualtyPose(record, state.tick + 3600, emptyCasualtyPose());
    record.rest = ground.heightAt(end.x, end.y);
  }
  if (health <= 0 && !already) record.cash = rng.int(CASH[0], CASH[1]);
  setCasualty(peds, record);
  if (already) return record;
  if (was === undefined) commitCrime(state, CRIMES[blow.cause]);
  const ids: number[] = [];
  if (health <= 0) {
    commitCrime(state, 'killing');
    crowd.startle(peds, state.tick, pose.x, pose.y, DEATH_FLEE, 'flee', ids);
    capBodies(state);
  } else {
    crowd.startle(peds, state.tick, pose.x, pose.y, WOUND_FLEE, 'flee', ids);
  }
  // Somebody calls it in, and an ambulance comes to whoever is down (spec
  // section 20.3). A stagger is not worth one.
  if (down !== 0) callAmbulance(state, pose.x, pose.y);
  return record;
}

/**
 * One tick of what follows the hits: onlookers come to a body a while after
 * the killing, a player on foot takes the cash off one they stand over, a body
 * left long enough is taken away where nobody sees it, and anyone the player
 * has gone far from is let go of, back onto their loop.
 */
export function stepCasualties(state: SimState, crowd: CrowdSource, ids?: number[]): void {
  const peds = state.pedestrians;
  if (peds.casualties.length === 0) return;
  const p = state.player;
  const px = p.driving ? state.vehicle.x : p.x;
  const py = p.driving ? state.vehicle.z : p.y;
  const pose = emptyCasualtyPose();
  const keep: Casualty[] = [];
  for (const record of peds.casualties) {
    casualtyPose(record, state.tick, pose);
    const away = hypot(pose.x - px, pose.y - py);
    if (away > RELEASE_FAR) continue;
    keep.push(record);
    if (record.gone || !dead(record)) continue;
    if (state.tick - record.first === GATHER_DELAY) {
      crowd.startle(peds, state.tick, pose.x, pose.y, GATHER_REACH, 'gather', ids);
    }
    if (record.cash > 0 && !p.driving && hypot(pose.x - p.x, pose.y - p.y) <= CASH_REACH) {
      state.money += record.cash;
      record.cash = 0;
    }
    if (state.tick - record.first >= BODY_LIFE && away > BODY_UNSEEN) record.gone = true;
  }
  peds.casualties = keep;
}

/**
 * Take the bodies within `radius` of a place away: an ambulance that has
 * worked a scene leaves with them (spec section 20.3). The wounded who are
 * still down go with it too.
 */
export function collectBodies(state: SimState, x: number, y: number, radius: number): number {
  const pose = emptyCasualtyPose();
  let count = 0;
  for (const record of state.pedestrians.casualties) {
    if (record.gone) continue;
    casualtyPose(record, state.tick, pose);
    if (!dead(record) && pose.phase !== 'lie' && pose.phase !== 'crawl') continue;
    if (hypot(pose.x - x, pose.y - y) > radius) continue;
    record.gone = true;
    count++;
  }
  return count;
}

/** Take the oldest bodies away while more than {@link BODY_CAP} lie. */
function capBodies(state: SimState): void {
  const bodies = state.pedestrians.casualties.filter((r) => !r.gone && dead(r));
  if (bodies.length <= BODY_CAP) return;
  bodies.sort((a, b) => a.first - b.first || a.id - b.id);
  for (let i = 0; i < bodies.length - BODY_CAP; i++) (bodies[i] as Casualty).gone = true;
}

/** Write a record in, in id order, replacing any the person already had, and take them out of the startled. */
function setCasualty(state: PedestrianState, record: Casualty): void {
  const startled = state.startled.findIndex((s) => s.id === record.id);
  if (startled >= 0) state.startled.splice(startled, 1);
  const list = state.casualties;
  let i = list.length;
  while (i > 0 && (list[i - 1] as Casualty).id > record.id) i--;
  if (i > 0 && (list[i - 1] as Casualty).id === record.id) list[i - 1] = record;
  else list.splice(i, 0, record);
}
