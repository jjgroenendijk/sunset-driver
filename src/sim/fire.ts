/**
 * The fires the record is carrying (spec sections 11.3, 20.3): which vehicles
 * are alight, what a wreck leaves burning behind it, how a fire reaches what
 * stands beside it, and what a hose puts out.
 *
 * `damage.ts` holds the rules of one vehicle's fire and of the spread between
 * two of them. This is the other half: the list those rules are run over, and
 * the blazes that outlast the vehicles that started them.
 *
 * A vehicle is in the record only once it has left its trajectory — the car
 * the player is in, and the traffic and the parked cars they have touched
 * (spec section 5.3) — so the list is short and everything on it is near the
 * player. A vehicle burns for {@link FUSE_TICKS} and then goes up, which is
 * seven seconds: nothing can be driven across a city in seven seconds, so a
 * fire engine never saves the car that started it. What it fights is the
 * {@link Blaze} the wreck leaves — the fuel, the scenery and the ground
 * around it, which burn for the best part of a minute and light the next
 * vehicle along. That is the fire that spreads, and the one a hose puts out.
 *
 * Pure in the record and the tick: the same save stepped again lights the same
 * cars in the same order.
 */
import { rngFor, Subsystem } from '../core/rng.ts';
import { TICK_RATE } from './clock.ts';
import {
  blastDamageAt,
  extinguish,
  ignite,
  isFlammable,
  spreadFire,
  SPREAD_CHANCE,
  SPREAD_PERIOD,
  SPREAD_RADIUS,
  tickFire,
  type Burnable,
  type DamageState,
} from './damage.ts';
import { hurt } from './on-foot.ts';
import type { SimState } from './simulation.ts';
import type { PromotedVehicle } from './traffic.ts';

/**
 * The id the player's own vehicle burns under. Every other id is a vehicle of
 * the traffic or a parked car, and those start at 0, so nothing shares it.
 */
export const PLAYER_FIRE = -1;

/** The shortest and longest a blaze burns, in seconds, before it burns itself out. */
export const BLAZE_SECONDS: readonly [number, number] = [35, 70];

/** What a wreck leaves burning where it stood (spec section 20.3). */
export interface Blaze {
  id: number;
  /** Where it burns, in metres. `y` is the map's. */
  x: number;
  y: number;
  /** The tick it caught. */
  lit: number;
  /** The tick it burns itself out on, unless a hose reaches it first. */
  out: number;
}

/** The fires of a session, as the record carries them. */
export interface FireState {
  blazes: Blaze[];
  /** The id the next blaze is given, so no two of a session share one. */
  nextBlaze: number;
}

export function createFireState(): FireState {
  return { blazes: [], nextBlaze: 0 };
}

/** Every vehicle of the record, as the fire rules need to see it. */
export function burnablesOf(state: SimState): Burnable[] {
  const v = state.vehicle;
  const list: Burnable[] = [{ id: PLAYER_FIRE, x: v.x, y: v.z, damage: v.damage }];
  for (const promoted of state.traffic.promoted as readonly PromotedVehicle[]) {
    const car = promoted.vehicle;
    list.push({ id: promoted.id, x: car.x, y: car.z, damage: car.damage });
  }
  return list;
}

/**
 * Run the fires of one tick: the spread from everything that is alight to the
 * vehicles around it, the fuse of every vehicle but the player's, and the
 * blazes the wrecks have left.
 *
 * The player's own vehicle is burned by `physics.ts`, which has the body to
 * throw up when it goes; this is called after that, so a car that went up this
 * tick leaves its blaze on this tick too. Everything else is walked in the
 * order the record holds it, so a replay explodes the same shells on the same
 * ticks.
 */
export function stepFires(state: SimState): void {
  const burnables = burnablesOf(state);
  spreadFire(burnables, state.seed, state.tick);
  spreadFromBlazes(state, burnables);
  const p = state.player;
  // A player at the wheel is wherever their own car is; the record only keeps
  // them walking about while they are on foot.
  const atX = p.driving ? state.vehicle.x : p.x;
  const atY = p.driving ? state.vehicle.z : p.y;
  for (const promoted of state.traffic.promoted as readonly PromotedVehicle[]) {
    const car = promoted.vehicle;
    if (!tickFire(car.damage, state.tick)) continue;
    hurt(p, blastDamageAt(Math.hypot(atX - car.x, atY - car.z)));
    light(state, car.x, car.z);
  }
  const v = state.vehicle;
  if (v.damage.blownTick === state.tick) light(state, v.x, v.z);
  burnOut(state);
}

/**
 * Light a blaze where a wreck stands. How long it burns is drawn from its own
 * stream, so one wreck smoulders and the next one is still going when the
 * engine arrives.
 */
export function light(state: SimState, x: number, y: number): Blaze {
  const fires = state.fires;
  const id = fires.nextBlaze;
  fires.nextBlaze = id + 1;
  // `Subsystem.Emergency`, not `Damage`: the spread rolls of `spreadFire` are
  // keyed on a vehicle id at the same tick, and two decisions must never be
  // drawn from one stream.
  const rng = rngFor(state.seed, state.tick, Subsystem.Emergency, id);
  const seconds = rng.range(BLAZE_SECONDS[0], BLAZE_SECONDS[1]);
  const blaze: Blaze = { id, x, y, lit: state.tick, out: state.tick + Math.round(seconds * TICK_RATE) };
  fires.blazes.push(blaze);
  return blaze;
}

/**
 * Put out every fire within `reach` metres of a place, which is what the hose
 * of a fire engine does (spec section 20.3). Answers how many it put out, so a
 * caller can tell a scene that is still alight from one that is out.
 */
export function douseFires(state: SimState, x: number, y: number, reach: number): number {
  let out = 0;
  for (const burnable of burnablesOf(state)) {
    if (Math.hypot(burnable.x - x, burnable.y - y) > reach) continue;
    if (extinguish(burnable.damage)) out += 1;
  }
  const blazes = state.fires.blazes;
  for (let i = blazes.length - 1; i >= 0; i--) {
    const blaze = blazes[i] as Blaze;
    if (Math.hypot(blaze.x - x, blaze.y - y) > reach) continue;
    blazes.splice(i, 1);
    out += 1;
  }
  return out;
}

/**
 * Where everything that is alight stands, in the order the record holds it:
 * the vehicles first, then the blazes. This is what calls a fire engine out.
 */
export function firesOf(state: SimState): { x: number; y: number }[] {
  const places: { x: number; y: number }[] = [];
  for (const burnable of burnablesOf(state)) {
    if (alight(burnable.damage)) places.push({ x: burnable.x, y: burnable.y });
  }
  for (const blaze of state.fires.blazes) places.push({ x: blaze.x, y: blaze.y });
  return places;
}

/** True while a vehicle is still burning, which is what a fire engine is called to. */
export function alight(damage: DamageState): boolean {
  return damage.stage === 'burning';
}

/**
 * The fire a blaze sets to the vehicles around it. It runs on the timer
 * `spreadFire` runs on and rolls the same chance from the same stream, keyed
 * on the vehicle and the tick. That is on purpose: a car reached by a burning
 * vehicle and by a blaze on the same tick draws the same number twice, so it
 * takes one roll however many fires reach it, which is the rule `spreadFire`
 * states and the reason the answer does not depend on the order of the list.
 */
function spreadFromBlazes(state: SimState, burnables: readonly Burnable[]): void {
  if (state.tick % SPREAD_PERIOD !== 0) return;
  for (const target of burnables) {
    if (!isFlammable(target.damage)) continue;
    let reached = false;
    for (const blaze of state.fires.blazes) {
      if (Math.hypot(blaze.x - target.x, blaze.y - target.y) > SPREAD_RADIUS) continue;
      reached = true;
      break;
    }
    if (!reached) continue;
    if (!rngFor(state.seed, state.tick, Subsystem.Damage, target.id).chance(SPREAD_CHANCE)) continue;
    ignite(target.damage, state.tick);
  }
}

/** Drop the blazes that have burned themselves out. */
function burnOut(state: SimState): void {
  const blazes = state.fires.blazes;
  for (let i = blazes.length - 1; i >= 0; i--) {
    if ((blazes[i] as Blaze).out <= state.tick) blazes.splice(i, 1);
  }
}
