/**
 * What a swing of a melee weapon leaves behind (spec section 11.6).
 *
 * `weapon.ts` decides that the weapon swung and `swingReaches` says what the
 * arc covers; this says how long the swing lasts, and it carries the record of
 * what the swing struck. Nothing here touches Rapier or the DOM: `gunfire.ts`
 * is the half that sweeps the arc through the world, and it writes its hits in
 * through {@link markHit}.
 *
 * A hit is part of the record rather than an event, because two readers need it
 * a frame later and neither of them is the simulation: `src/render/weapons/melee-fx.ts`
 * throws the burst and `src/audio/plan.ts` fires the cue. Both read every hit
 * newer than the tick they last read, so a frame that stepped six ticks hears
 * all six of them. A hit is forgotten {@link HIT_MEMORY} ticks after it lands,
 * which is longer than any frame a player would keep playing through.
 */
import { currentWeapon, shotInterval, type LoadoutState, type WeaponSpec } from './weapon.ts';
import type { PedestrianPose, PedestrianState, Reaction } from '../crowd/pedestrians.ts';

/**
 * What was struck, which is all a burst and a cue need to know: a person, a
 * body panel, or the hard world of walls, posts and pavement.
 */
export type HitSurface = 'person' | 'vehicle' | 'hard';

/** One blow that landed, as the record carries it. */
export interface MeleeHit {
  /** The tick it landed on, which is how a reader tells a new hit from a seen one. */
  tick: number;
  /** Where it landed, in map metres with `h` above sea level. */
  x: number;
  y: number;
  h: number;
  surface: HitSurface;
  /** How hard it was, 0 to 1: what the burst is sized from and the cue is played at. */
  strength: number;
}

/** Ticks a hit is remembered for. A frame slower than this was a stall, not a frame. */
export const HIT_MEMORY = 20;

/** Hits the record holds at once. A swing that lands on more than this is a swing in a crowd. */
export const HIT_CAP = 12;

/** Ticks the longest swing is drawn over. A weapon that cycles faster swings faster. */
const SWING_TICKS = 22;

/** Metres above the feet a blow lands, which is where the burst is thrown from. */
export const SWING_HEIGHT = 1.05;

/** The damage one blow is worth at full strength, so a heavier weapon hits harder. */
const FULL_BLOW = 45;

/** Ticks one swing of this weapon is drawn and swept over. */
export function swingTicks(spec: WeaponSpec): number {
  return Math.min(SWING_TICKS, shotInterval(spec));
}

/**
 * How far through its swing the weapon is, 0 at the moment it leaves the
 * shoulder and 1 as it comes to rest, or -1 where nothing is being swung.
 * `tick` may fall between two ticks, since the renderer draws between them.
 */
export function swingProgress(spec: WeaponSpec, firedTick: number, tick: number): number {
  if (spec.cls !== 'melee' || firedTick < 0) return -1;
  const age = tick - firedTick;
  if (age < 0) return -1;
  const ticks = swingTicks(spec);
  return age >= ticks ? -1 : age / ticks;
}

/**
 * How far through a swing the weapon in the player's hands is, which is what
 * the renderer draws the blow from. `tick` may fall between two ticks.
 */
export function swingOf(loadout: LoadoutState, tick: number): number {
  return swingProgress(currentWeapon(loadout), loadout.firedTick, tick);
}

/** How hard a blow of this weapon lands, 0 to 1. */
export function blowStrength(spec: WeaponSpec): number {
  return Math.min(1, spec.damage / FULL_BLOW);
}

/**
 * Write one hit into the record. The oldest is dropped where the list is full,
 * so a swing through a crowd costs a bounded amount of record.
 */
export function markHit(hits: MeleeHit[], hit: MeleeHit): void {
  hits.push(hit);
  if (hits.length > HIT_CAP) hits.splice(0, hits.length - HIT_CAP);
}

/** Forget the hits older than {@link HIT_MEMORY} ticks. Called once a tick. */
export function forgetHits(hits: MeleeHit[], tick: number): void {
  let keep = 0;
  while (keep < hits.length && tick - (hits[keep] as MeleeHit).tick >= HIT_MEMORY) keep++;
  if (keep > 0) hits.splice(0, keep);
}

/**
 * What a swing needs of the crowd: who is near, where they are, and a fright.
 * The reactions of spec section 20.1 read it for the same three things
 * (`crowd-reaction.ts`).
 */
export interface CrowdSource {
  near(minX: number, minY: number, maxX: number, maxY: number, out: number[]): number[];
  poseAt(id: number, time: number, out: PedestrianPose): PedestrianPose;
  startle(
    state: PedestrianState,
    tick: number,
    x: number,
    y: number,
    radius: number,
    reaction: Reaction,
    ids?: number[],
  ): number;
}
