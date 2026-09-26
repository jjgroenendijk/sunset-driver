/**
 * The police shooting (spec section 14): who fires, with what, how often, and
 * what a round of theirs does.
 *
 * Below {@link FIRE_STARS} the police are there to take the player in and
 * nobody fires. From there it escalates with the heat: the patrol draw a
 * pistol, then a shotgun at the third star, and a SWAT team carries rifles. An
 * officer fires only at a player they can see, inside their gun's reach, and
 * not at one who is being cuffed or who has given themselves up.
 *
 * A round is a draw of the officer's own stream. It is worse at range and
 * worse at a moving target, and it is written into the record as a tracer the
 * player's own rounds share, so the flash, the streak and the crack of it are
 * drawn and played by the code that draws and plays the player's. A round
 * that hits a driver goes into the car rather than into them.
 *
 * The crew still in a car that has stopped fires the same guns out of the
 * window, slower and worse, over the roof of the car.
 */
import { rngFor, Subsystem, type Rng } from '../core/rng.ts';
import { atan2, cos, hypot, sin } from '../core/libm.ts';
import type { CasualtyGround } from './casualty.ts';
import { heatStars } from './crime.ts';
import { damageVehicle } from './damage.ts';
import { hurt } from './on-foot.ts';
import { bark, mayFire, OFFICER_MUZZLE, officerWeapon, type Officer } from './officer.ts';
import type { SimState } from './simulation.ts';
import { CAR_EYE, HELICOPTER_HEIGHT, HELICOPTER_STARS, type PoliceUnit } from './police.ts';
import { inSight, type Quarry } from './squad.ts';
import { markTracer, type TracerEnd } from './tracer.ts';
import { headingOf, specOf } from './vehicle.ts';
import { roundSeverity, weaponOf, type WeaponId } from './weapon.ts';

/** How one of the police guns is fired by an officer, rather than by the player. */
interface Drill {
  /** Metres they fire over. */
  range: number;
  /** Ticks between two shots. Slower than the gun can go: they fire aimed shots, not bursts. */
  cadence: number;
  /** The chance a round lands at point-blank range on a player standing still. */
  accuracy: number;
  /** Rounds a shot throws: the pellets of a shotgun blast that are drawn. */
  rounds: number;
  /** Share of a round's damage the player takes, so a firefight lasts long enough to answer. */
  share: number;
}

const DRILLS: Partial<Record<WeaponId, Drill>> = {
  'glock-17': { range: 26, cadence: 42, accuracy: 0.6, rounds: 1, share: 0.45 },
  'remington-870': { range: 16, cadence: 75, accuracy: 0.75, rounds: 4, share: 0.4 },
  m4a1: { range: 42, cadence: 16, accuracy: 0.5, rounds: 1, share: 0.32 },
};

const FALLBACK: Drill = { range: 20, cadence: 45, accuracy: 0.5, rounds: 1, share: 0.4 };

/** How much worse a round is at the edge of the range than at point blank. */
const RANGE_FALLOFF = 0.55;

/** Metres per second over which the player is a moving target, and what that leaves of the aim. */
const MOVING = 3;
const MOVING_AIM = 0.6;

/** Radians a miss goes wide by, at the least and at the most. */
const MISS_WIDE: readonly [number, number] = [0.05, 0.16];

/** Metres over the ground a round is aimed at on a player on foot, and on a car. */
const CHEST = 1.2;
const DOOR = 0.8;

/** How much slower and how much worse a crew fires out of a car's window than on foot. */
const WINDOW_CADENCE = 1.5;
const WINDOW_AIM = 0.7;

/** Ticks since their last shot after which an officer opening fire says so. */
const OPEN_FIRE = 5 * 60;

/** Metres the police fire a gun over. */
export function officerRange(weapon: WeaponId): number {
  return (DRILLS[weapon] ?? FALLBACK).range;
}

/**
 * One tick of an officer's gun: draw it and point it at a player they can see
 * inside its range, and fire when it is due.
 */
export function officerFire(state: SimState, officer: Officer, quarry: Quarry, sees: boolean, ground: CasualtyGround | undefined): void {
  officer.aiming = false;
  if (!sees || !mayShoot(state)) return;
  if (officer.task !== 'pursue' && officer.task !== 'cover') return;
  const weapon = officerWeapon(officer.kind, heatStars(state.heat));
  const drill = DRILLS[weapon] ?? FALLBACK;
  const distance = hypot(quarry.x - officer.x, quarry.y - officer.y);
  if (distance > drill.range) return;
  // An officer running in to cuff does not stop to shoot; one standing does.
  if (officer.speed > 0.5 && officer.kind === 'patrol' && heatStars(state.heat) < 3) return;
  officer.aiming = true;
  officer.heading = atan2(quarry.y - officer.y, quarry.x - officer.x);
  if (state.tick - officer.fired < drill.cadence) return;
  if (state.tick - officer.fired > OPEN_FIRE) bark(state, 'fire', officer.x, officer.y);
  officer.fired = state.tick;
  const rng = rngFor(state.seed, state.tick, Subsystem.Officers, officer.id);
  const x = officer.x + cos(officer.heading) * 0.45;
  const y = officer.y + sin(officer.heading) * 0.45;
  const muzzle = { id: officer.id, standX: officer.x, standY: officer.y, x, y, h: officer.height + OFFICER_MUZZLE, heading: officer.heading };
  shoot(state, muzzle, weapon, drill, quarry, distance, 1, rng, ground);
}

/**
 * One tick of the crew still in a police car: out of the window of a car that
 * has stopped, at a player the car can see, with the gun an officer of its
 * crew would draw on foot. They fire slower and worse than they would standing
 * in the street. A car that is moving, the helicopter and a car whose crew is
 * out do not fire.
 */
export function unitFire(state: SimState, unit: PoliceUnit, quarry: Quarry, ground: CasualtyGround | undefined): void {
  if (unit.kind === 'helicopter' || unit.crew <= 0 || unit.speed > 0.5 || !mayShoot(state)) return;
  const stars = heatStars(state.heat);
  const weapon = officerWeapon(unit.kind === 'swat' ? 'swat' : 'patrol', stars);
  const drill = DRILLS[weapon] ?? FALLBACK;
  const distance = hypot(quarry.x - unit.x, quarry.y - unit.y);
  if (distance > drill.range || state.tick - unit.fired < drill.cadence * WINDOW_CADENCE) return;
  if (!inSight(ground, unit, quarry.x, quarry.y, distance, CAR_EYE)) return;
  if (state.tick - unit.fired > OPEN_FIRE) bark(state, 'fire', unit.x, unit.y);
  unit.fired = state.tick;
  const rng = rngFor(state.seed, state.tick, Subsystem.UnitFire, unit.id);
  const muzzle = { id: unit.id, standX: unit.x, standY: unit.y, x: unit.x, y: unit.y, h: unit.height + CAR_EYE, heading: atan2(quarry.y - unit.y, quarry.x - unit.x) };
  shoot(state, muzzle, weapon, drill, quarry, distance, WINDOW_AIM, rng, ground);
}

/**
 * The mounted gun of the police helicopter (spec section 14): from
 * {@link HELICOPTER_STARS} up it fires down at a player it can see, in short
 * aimed bursts. It sees over the roofs, so nothing but range stops it, and it
 * is a poor shot at a moving target from a moving helicopter.
 */
const DOOR_GUN: Drill = { range: 110, cadence: 9, accuracy: 0.32, rounds: 1, share: 0.3 };

/** Ticks the gunner fires for, and then holds off for, so the gun speaks in bursts. */
const BURST = 60;
const BURST_PAUSE = 90;

/** One tick of the helicopter's gun. Every other unit is `unitFire`'s. */
export function helicopterFire(state: SimState, unit: PoliceUnit, quarry: Quarry): void {
  if (unit.kind !== 'helicopter' || heatStars(state.heat) < HELICOPTER_STARS || !mayShoot(state)) return;
  if (state.tick % (BURST + BURST_PAUSE) >= BURST) return;
  const distance = hypot(quarry.x - unit.x, quarry.y - unit.y);
  if (distance > DOOR_GUN.range || state.tick - unit.fired < DOOR_GUN.cadence) return;
  if (state.tick - unit.fired > OPEN_FIRE) bark(state, 'fire', unit.x, unit.y);
  unit.fired = state.tick;
  const rng = rngFor(state.seed, state.tick, Subsystem.UnitFire, unit.id);
  const heading = atan2(quarry.y - unit.y, quarry.x - unit.x);
  const muzzle = { id: unit.id, standX: unit.x, standY: unit.y, x: unit.x, y: unit.y, h: unit.height + HELICOPTER_HEIGHT, heading };
  shoot(state, muzzle, 'm4a1', DOOR_GUN, quarry, distance, 1, rng, undefined);
}

/** True while the police may shoot at all: at the heat for it, at a player not in their hands. */
function mayShoot(state: SimState): boolean {
  const police = state.police;
  return mayFire(state) && police.cuffs === null && !police.surrendered && state.player.health > 0;
}

/** Where a shot leaves the gun: the shooter's id, where they stand, the muzzle and the way it points. */
interface Muzzle {
  id: number;
  standX: number;
  standY: number;
  x: number;
  y: number;
  h: number;
  heading: number;
}

/**
 * Fire one shot of a drill at the player from a muzzle: the rounds it throws
 * as tracers, and what those that land do. `aim` is a share of the drill's
 * accuracy the shooter keeps. The draws come from the shooter's own stream.
 */
function shoot(
  state: SimState,
  muzzle: Muzzle,
  weapon: WeaponId,
  drill: Drill,
  quarry: Quarry,
  distance: number,
  aim: number,
  rng: Rng,
  ground: CasualtyGround | undefined,
): void {
  const moving = quarry.speed > MOVING ? MOVING_AIM : 1;
  const chance = drill.accuracy * (1 - (RANGE_FALLOFF * distance) / drill.range) * moving * aim;
  const driving = state.player.driving;
  const aimH = driving ? state.vehicle.y - specOf(state.vehicle.cls).halfHeight + DOOR : state.player.height + CHEST;
  let landed = 0;
  for (let round = 0; round < drill.rounds; round++) {
    const hit = rng.float() < chance;
    const wide = hit ? 0 : missAngle(rng);
    if (hit) landed += 1;
    traceRound(state, muzzle, round, hit, muzzle.heading + wide, distance, drill.range, aimH, ground);
  }
  if (landed === 0) return;
  landRounds(state, muzzle, weapon, drill, landed);
}

/** How far wide of the player a round that misses flies, to one side or the other. */
function missAngle(rng: Rng): number {
  const spread = rng.range(MISS_WIDE[0], MISS_WIDE[1]);
  return spread * (rng.float() < 0.5 ? -1 : 1);
}

/** What a round's tracer ends on: the player or their car on a hit, a wall, or nothing. */
function tracerEnd(hit: boolean, driving: boolean, blocked: number, reach: number): TracerEnd {
  if (hit) return driving ? 'vehicle' : 'person';
  return blocked < reach ? 'hard' : 'none';
}

/**
 * Mark the tracer of one round flying `dir` from the muzzle: to the player on
 * a hit, else out to the drill's range or the first thing in the way.
 */
function traceRound(
  state: SimState,
  muzzle: Muzzle,
  round: number,
  hit: boolean,
  dir: number,
  distance: number,
  range: number,
  aimH: number,
  ground: CasualtyGround | undefined,
): void {
  const { x, y, h } = muzzle;
  const reach = hit ? distance : range;
  const blocked = hit || ground === undefined ? reach : ground.reach(x, h, y, dir, reach);
  const end = tracerEnd(hit, state.player.driving, blocked, reach);
  const along = hit ? distance : blocked;
  const drop = hit ? aimH - h : (aimH - h) * (along / Math.max(1, distance));
  markTracer(state.tracers, { tick: state.tick, pellet: round, x, y, h, ex: x + cos(dir) * along, ey: y + sin(dir) * along, eh: h + drop, end, by: 'police' });
}

/** What the rounds that landed do: they hurt the player on foot, or damage the car they drive. */
function landRounds(state: SimState, muzzle: Muzzle, weapon: WeaponId, drill: Drill, landed: number): void {
  const spec = weaponOf(weapon);
  if (!state.player.driving) {
    hurt(state.player, spec.damage * drill.share * landed);
    return;
  }
  // Into the car the way the round was flying, which is the direction the
  // panel rule reads, as the player's own rounds go into a panel.
  const v = state.vehicle;
  const turn = headingOf(v);
  const dx = v.x - muzzle.standX;
  const dy = v.z - muzzle.standY;
  const along = dx * cos(turn) + dy * sin(turn);
  const across = -dx * sin(turn) + dy * cos(turn);
  const scale = 1 / Math.max(1e-6, hypot(along, across));
  damageVehicle(v.damage, roundSeverity(spec) * landed, along * scale, across * scale, 0.3, state.seed, state.tick, muzzle.id);
}
