/**
 * The police on foot (spec sections 11.7, 14): the record of one officer, what
 * they carry, and what a round or a blast does to them.
 *
 * An officer rides in a car of `police.ts` until the car pulls up near the
 * player; then the crew gets out, and each of them is one of these. An officer
 * who walks a beat downtown has no car at all. `squad.ts` moves them, `duty.ts`
 * says what each is doing, `arrest.ts` is the cuffing, and this file is the
 * part both of those and `gunfire.ts` read.
 *
 * They are people rather than cars, so the crowd mesh draws them, in a uniform
 * (`src/ui/hud/officers.ts`). An officer who is put down is not taken off the map
 * at once: they fall where they stood, as a casualty of the crowd does, and the
 * gun they carried is left beside them.
 */
import { atan2, hypot } from '../../core/libm.ts';
import type { Casualty, CasualtyGround } from '../crowd/casualty.ts';
import { TICK_RATE } from '../clock.ts';
import { CRIME_HEAT, heatStars } from './crime.ts';
import { MAX_HEALTH } from '../player/on-foot.ts';
import { dropWeapon } from '../weapons/pickup.ts';
import { report, type PoliceKind } from './police.ts';
import type { SimState } from '../simulation.ts';
import { weaponOf, type WeaponId } from '../weapons/weapon.ts';

/** What an officer is: a patrol officer, or one of a SWAT team in armour. */
export type OfficerKind = 'patrol' | 'swat';

/** What an officer is doing. */
export type OfficerTask =
  /** Walking a beat, with no car and no chase. */
  | 'beat'
  /** Going after the player on foot. */
  | 'pursue'
  /** Standing behind their car at a roadblock, gun over the roof. */
  | 'cover'
  /** Walking back to their car, to drive after a player who has got away. */
  | 'board'
  /** Walking off with no car and nothing to do, to be taken off the map out of sight. */
  | 'leave'
  /** Standing over the player, putting the cuffs on. */
  | 'cuff';

/** One officer on foot, as the record carries one. */
export interface Officer {
  id: number;
  kind: OfficerKind;
  /** The car they came in, which is a {@link PoliceUnit} id, or -1 for one on foot with no car. */
  unit: number;
  task: OfficerTask;
  x: number;
  y: number;
  /** The ground height under them. */
  height: number;
  heading: number;
  /** Metres per second they covered over the last tick. */
  speed: number;
  /** How far through their stride they are, so the crowd mesh draws a walk. */
  cycle: number;
  /** What is left of them, out of {@link OFFICER_HEALTH} of their kind. At zero they fall. */
  health: number;
  /** The tick they last fired on. */
  fired: number;
  /** True while their gun is out and pointed at the player: the body is drawn aiming. */
  aiming: boolean;
  /** The tick up to which they are knocked back and do nothing, after a player broke free. */
  stunned: number;
  /** -1 or 1: the way they go round a wall that stands between them and where they go. */
  detour: number;
  /** Metres from the goal where they met the wall they follow (`wall-follow.ts`), or -1 on the straight line. */
  wallGap: number;
  /** The heading they last walked along that wall. */
  wallDir: number;
  /** Ticks they have followed it. */
  wallTicks: number;
  /** The edges of the beat they walk, in order. Empty while they are off the roads. */
  edges: number[];
  /** Metres covered along the beat. */
  distance: number;
  /** The tick the beat was planned at. */
  planned: number;
  goalX: number;
  goalY: number;
}

/** An officer who has been put down: the body on the ground, and the uniform it wears. */
export interface FallenOfficer {
  kind: OfficerKind;
  body: Casualty;
}

/** What an officer on the radio or in the street says (spec section 15). */
export type BarkKind = 'spotted' | 'lost' | 'fire' | 'freeze' | 'cuff' | 'down';

/** One thing said, where it was said and when, for the audio to play. */
export interface Bark {
  tick: number;
  kind: BarkKind;
  x: number;
  y: number;
}

/** What a player being cuffed is going through (spec section 11.7). */
export interface Cuffs {
  /** The officer putting them on. */
  officer: number;
  /** The tick it started. */
  start: number;
  /** Presses of the break-free key so far, and how many it takes. */
  presses: number;
  need: number;
  /** Whether the key was down last tick, so only a fresh press is counted. */
  held: boolean;
  /** True where the player gave themselves up: there is no breaking free of that. */
  yielded: boolean;
}

/** What each kind can take before they fall, on the player's own scale. SWAT wear armour. */
export const OFFICER_HEALTH: Record<OfficerKind, number> = { patrol: MAX_HEALTH, swat: MAX_HEALTH * 2.2 };

/** Metres per second each kind runs at. A sprinting player (5.6) can outrun them; a walking one cannot. */
export const OFFICER_RUN: Record<OfficerKind, number> = { patrol: 5, swat: 4.4 };

/** Metres per second an officer walks a beat at. */
export const BEAT_SPEED = 1.45;

/** Metres of one stride of a run and of a walk, so the legs keep up with the ground. */
export const RUN_STRIDE = 2.6;
export const WALK_STRIDE = 1.5;

/** Officers each kind of car carries. The helicopter lands nobody. */
export const CREW: Record<PoliceKind, number> = { patrol: 2, interceptor: 2, swat: 4, helicopter: 0 };

/** Metres an officer on foot sees the player over, where no wall is in the way. */
export const OFFICER_SIGHT = 45;

/** Metres over the ground an officer's eyes and a shot's muzzle are. */
export const EYE_HEIGHT = 1.6;
export const OFFICER_MUZZLE = 1.35;

/** Ticks a bark is kept for the audio, and the most kept at once. */
const BARK_MEMORY = TICK_RATE;
const BARK_CAP = 8;

/** Ticks a fallen officer lies before the body is taken away. */
const FALLEN_TICKS = 90 * TICK_RATE;

/** Fallen officers kept at once. The oldest is taken away first. */
const FALLEN_CAP = 12;

/** Metres per second a round pushes an officer over at, and how far it can carry them. */
const FALL_PUSH = 1.6;
const FALL_REACH = 1.4;

/**
 * The gun an officer of a kind draws at a heat: the team a rifle, and the
 * patrol a pistol until the third star, then a shotgun (spec section 14).
 */
export function officerWeapon(kind: OfficerKind, stars: number): WeaponId {
  if (kind === 'swat') return 'm4a1';
  return stars >= 3 ? 'remington-870' : 'glock-17';
}

/** Stars at which the police start shooting. Below it they only arrest. */
const FIRE_STARS = 2;

/** True while the heat is high enough for officers to shoot. */
export function mayFire(state: SimState): boolean {
  return heatStars(state.heat) >= FIRE_STARS;
}

/** A fresh officer standing at a place, facing a way. */
export function createOfficer(id: number, kind: OfficerKind, unit: number, task: OfficerTask, x: number, y: number, height: number, heading: number): Officer {
  return {
    id,
    kind,
    unit,
    task,
    x,
    y,
    height,
    heading,
    speed: 0,
    cycle: 0,
    health: OFFICER_HEALTH[kind],
    fired: -1_000_000,
    aiming: false,
    stunned: -1,
    detour: id % 2 === 0 ? 1 : -1,
    wallGap: -1,
    wallDir: 0,
    wallTicks: 0,
    edges: [],
    distance: 0,
    planned: -1_000_000,
    goalX: x,
    goalY: y,
  };
}

/** Say something, unless the same thing was said in the last second: a squad does not talk over itself. */
export function bark(state: SimState, kind: BarkKind, x: number, y: number): void {
  const barks = state.police.barks;
  for (const said of barks) if (said.kind === kind && state.tick - said.tick < BARK_MEMORY) return;
  barks.push({ tick: state.tick, kind, x, y });
  if (barks.length > BARK_CAP) barks.splice(0, barks.length - BARK_CAP);
}

/** Forget the barks older than the audio needs, and the bodies that have been taken away. Once a tick. */
export function forgetOfficerRecords(state: SimState): void {
  const barks = state.police.barks;
  let keep = 0;
  while (keep < barks.length && state.tick - (barks[keep] as Bark).tick >= BARK_MEMORY) keep++;
  if (keep > 0) barks.splice(0, keep);
  const fallen = state.police.fallen;
  keep = 0;
  while (keep < fallen.length && state.tick - (fallen[keep] as FallenOfficer).body.first >= FALLEN_TICKS) keep++;
  if (keep > 0) fallen.splice(0, keep);
}

/**
 * Take health off an officer, and put them down once they have none left.
 * Shooting at officers is what the spec's hardest heat is for: a hit is an
 * assault in proportion to what it took, and a kill is a killing on top of it.
 * `dir` is the way the round was going, which is the way they fall. `ground`
 * says how far that fall can go before a wall stops it. Answers true where
 * this was the hit that put them down.
 */
export function hurtOfficer(state: SimState, id: number, amount: number, dir: number, ground?: CasualtyGround): boolean {
  const officers = state.police.officers;
  for (let i = 0; i < officers.length; i++) {
    const officer = officers[i] as Officer;
    if (officer.id !== id) continue;
    const took = Math.min(Math.max(0, amount), officer.health);
    officer.health -= took;
    report(state, CRIME_HEAT.officerAssault * (took / OFFICER_HEALTH[officer.kind]));
    if (officer.health > 0) return false;
    fall(state, officer, dir, ground);
    officers.splice(i, 1);
    if (state.police.cuffs?.officer === id) state.police.cuffs = null;
    report(state, CRIME_HEAT.officerKilling);
    bark(state, 'down', officer.x, officer.y);
    return true;
  }
  return false;
}

/**
 * Put a blast into every officer inside its radius, in id order. `falloff`
 * answers how much of it is felt at a distance, which is `weapon.ts`'s rule.
 */
export function blastOfficers(state: SimState, x: number, y: number, damage: number, falloff: (distance: number) => number): void {
  for (const officer of [...state.police.officers]) {
    const share = falloff(hypot(officer.x - x, officer.y - y));
    if (share <= 0) continue;
    hurtOfficer(state, officer.id, damage * share, atan2(officer.y - y, officer.x - x));
  }
}

/** The body left where an officer fell, with their gun beside it, loaded (spec section 11.6). */
function fall(state: SimState, officer: Officer, dir: number, ground?: CasualtyGround): void {
  const weapon = officerWeapon(officer.kind, Math.max(FIRE_STARS, heatStars(state.heat)));
  dropWeapon(state, weapon, weaponOf(weapon).capacity, 0, [], officer.x, officer.y, officer.height);
  const reach = ground?.reach(officer.x, officer.height + 1, officer.y, dir, FALL_REACH) ?? FALL_REACH;
  const body: Casualty = {
    id: officer.id,
    since: state.tick,
    first: state.tick,
    cause: 'shot',
    health: 0,
    x: officer.x,
    y: officer.y,
    height: officer.height,
    rest: officer.height,
    heading: officer.heading,
    dir,
    push: FALL_PUSH,
    lift: 0,
    reach,
    down: -1,
    side: officer.id % 2 === 0 ? 1 : -1,
    cash: 0,
    gone: false,
    bumped: -1,
    ragdoll: null,
  };
  const fallen = state.police.fallen;
  fallen.push({ kind: officer.kind, body });
  if (fallen.length > FALLEN_CAP) fallen.splice(0, fallen.length - FALLEN_CAP);
}
