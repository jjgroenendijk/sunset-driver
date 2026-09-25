/**
 * Vehicle damage, fire and explosion (spec section 11.3).
 *
 * This holds the rules and nothing else: what one impact does to a vehicle,
 * how a wreck catches fire, how long it burns before it goes up, and how the
 * fire reaches the vehicles parked around it. Nothing here touches Rapier or
 * three.js, so the whole progression can be read and tested headless.
 * `physics.ts` is what measures the impacts, and `src/render/damage-fx.ts` is
 * what draws the smoke and the flames.
 *
 * A vehicle carries its damage in its record, as plain numbers, for the same
 * reason it carries its pose there: a session is saved and replayed as the
 * record it is. Every roll comes from `rngFor(seed, tick, Subsystem.Damage,
 * id)`, so the same crash at the same tick of the same seed always burns the
 * same way.
 *
 * Damage is a progression of states:
 *
 * - `intact` — nothing has touched it;
 * - `dented` — panels are pushed in, and some may be torn off;
 * - `smoking` — the engine is hurt and trailing smoke;
 * - `burning` — it is on fire, and a timer is running;
 * - `burnt` — it has exploded, and what is left is a shell.
 *
 * A vehicle only ever moves forward through them, with one exception:
 * {@link extinguish} takes a fire the fire engine of spec section 20.3 has
 * reached back to `smoking`. Nothing takes a vehicle out of `burnt`.
 */
import { hypot } from '../core/libm.ts';
import { rngFor, Subsystem } from '../core/rng.ts';
import type { VehicleSpec } from './vehicle.ts';

/**
 * The panels an impact pushes in, and a hard enough one tears off.
 *
 * They are named in the vehicle's own frame: `front` is local `+x`, which is
 * the way it drives, `left` is `+z` and `right` is `-z`. Nothing stands for
 * the floor, because a car that lands on its wheels bends its floor and shows
 * nothing from a camera 60 m above it.
 */
export type Panel = 'front' | 'rear' | 'left' | 'right' | 'roof';

/** Every panel, in the order the state stores them. Nothing else should list them. */
export const PANELS: readonly Panel[] = ['front', 'rear', 'left', 'right', 'roof'];

/** How far a vehicle has been taken through the progression above. */
export type DamageStage = 'intact' | 'dented' | 'smoking' | 'burning' | 'burnt';

/**
 * Metres per second of speed a vehicle may lose in one tick before it counts
 * as an impact. Braking, the suspension and a hard landing all fall well under
 * it: the brakes of the roster take about 0.1 m/s a tick and a spring at full
 * force about 0.3, so nothing a driver does on their own reaches this.
 */
export const IMPACT_FLOOR = 1.2;

/**
 * Metres per second of speed lost in one tick that writes off a saloon
 * outright. A vehicle's own toughness scales it, so the same wall costs a bus
 * much less than it costs a motorcycle.
 *
 * Rapier resolves a crash inside one step, so what a vehicle loses in the tick
 * it hits a wall is about the speed it hit the wall at. This is therefore the
 * speed a wall is fatal at — 100 km/h — and driving into one at 30 costs a car
 * a tenth of itself. A game where the third kerb ends the car is not a game
 * anybody drives.
 */
export const CRUSH_SPEED = 28;

/** How deep one impact pushes the panel it lands on, per unit of severity. */
export const DENT_PER_SEVERITY = 1.7;

/** Integrity under which the engine trails smoke, and under which it can catch fire. */
export const SMOKE_BELOW = 0.45;
export const FIRE_BELOW = 0.12;

/** The chance an impact on an already ruined vehicle sets it alight. */
export const FIRE_CHANCE = 0.35;

/** Ticks a vehicle burns before it explodes: seven seconds to get clear of it. */
export const FUSE_TICKS = 420;

/**
 * Ticks a fire burns before it can reach anything else, and the timer it
 * reaches on after that. The delay is what gives a driver time to get out; the
 * period is the timer spec section 11.3 asks for, so a row of parked cars goes
 * up one after another rather than all at once.
 */
export const SPREAD_DELAY = 120;
export const SPREAD_PERIOD = 30;

/** Metres a fire reaches, and the chance it takes hold each time the timer comes round. */
export const SPREAD_RADIUS = 6;
export const SPREAD_CHANCE = 0.3;

/** Metres an explosion is felt over, and the health it takes at the middle of it. */
export const BLAST_RADIUS = 9;
export const BLAST_DAMAGE = 65;

/** Newtons of impulse an explosion throws its own vehicle up with, per tonne. */
export const BLAST_LIFT = 4200;

/** Health a crash costs the driver, per unit of severity. */
export const CRASH_DAMAGE = 45;

/** What is left of the engine at no integrity at all. A wreck still limps. */
const LIMP_POWER = 0.55;

/**
 * The damage of one vehicle, as the record carries it. Plain numbers, like
 * everything else in the state.
 */
export interface DamageState {
  /** What is left of the vehicle, 1 at the showroom and 0 at a write-off. */
  integrity: number;
  /** How far each panel of {@link PANELS} is pushed in, 0 to 1. */
  dents: number[];
  /** True where that panel has been torn off altogether. */
  lost: boolean[];
  /** How far through the progression it is. */
  stage: DamageStage;
  /** The tick the fire caught, or -1 while nothing is burning. */
  litTick: number;
  /** The tick it exploded, or -1 while it has not. */
  blownTick: number;
}

/** An undamaged vehicle. */
export function createDamageState(): DamageState {
  return {
    integrity: 1,
    dents: PANELS.map(() => 0),
    lost: PANELS.map(() => false),
    stage: 'intact',
    litTick: -1,
    blownTick: -1,
  };
}

/**
 * How much punishment a class takes, against the saloon the roster is read
 * against. It is the vehicle's own mass, because mass is what a structure is
 * made of: a bus is built to shrug off what flattens a motorcycle. The bounds
 * keep both ends playable.
 */
export function toughnessOf(spec: VehicleSpec): number {
  return Math.min(2.5, Math.max(0.55, spec.mass / 1200));
}

/**
 * The panel an impact lands on, given the direction the vehicle was pushed in,
 * in its own frame.
 *
 * The vehicle is pushed away from whatever it hit, so a push toward the back
 * is a hit on the nose. A push upward is the floor taking a landing and is no
 * panel at all; a push downward is the roof, which is a vehicle landing on it.
 */
export function panelFor(along: number, across: number, up: number): Panel | undefined {
  const fore = Math.abs(along);
  const side = Math.abs(across);
  const rise = Math.abs(up);
  if (rise > fore && rise > side) return up < 0 ? 'roof' : undefined;
  if (fore >= side) return along < 0 ? 'front' : 'rear';
  return across < 0 ? 'left' : 'right';
}

/**
 * What one impact is worth, 0 to 1, as a fraction of a whole vehicle. Speed
 * lost is what a structure has absorbed, and the energy in it grows with the
 * square, so a crash twice as hard is four times the damage.
 */
export function severityOf(spec: VehicleSpec, speedLost: number): number {
  if (speedLost <= IMPACT_FLOOR) return 0;
  const share = (speedLost - IMPACT_FLOOR) / (CRUSH_SPEED * toughnessOf(spec));
  return Math.min(1, share * share);
}

/**
 * Take one impact, given the speed the vehicle lost in the tick, in its own
 * frame. Answers the severity, so the caller can hurt whoever was in it.
 *
 * The speed lost is what says how hard the blow was; {@link damageVehicle} is
 * what the blow then does, and gunfire (spec section 11.6) goes through that
 * instead, because a round carries no speed the chassis can lose.
 */
export function hitVehicle(
  damage: DamageState,
  spec: VehicleSpec,
  along: number,
  across: number,
  up: number,
  seed: number,
  tick: number,
  id = 0,
): number {
  return damageVehicle(damage, severityOf(spec, hypot(along, across, up)), along, across, up, seed, tick, id);
}

/**
 * Take one blow of a known severity, from a direction given in the vehicle's
 * own frame. Answers the severity it was given, so a caller can hurt whoever
 * was in it.
 *
 * A panel takes the dent, and a dent that reaches its depth tears the panel
 * off. What is left of the vehicle falls by the severity, and a vehicle at the
 * end of that can catch fire: the roll is the one place this reaches for
 * randomness, and it is keyed on the seed and the tick like every other.
 */
export function damageVehicle(
  damage: DamageState,
  severity: number,
  along: number,
  across: number,
  up: number,
  seed: number,
  tick: number,
  id = 0,
): number {
  if (severity <= 0) return 0;
  if (damage.stage === 'burnt') return severity;

  const panel = panelFor(along, across, up);
  if (panel !== undefined) {
    const index = PANELS.indexOf(panel);
    const dent = Math.min(1, (damage.dents[index] as number) + severity * DENT_PER_SEVERITY);
    damage.dents[index] = dent;
    if (dent >= 1) damage.lost[index] = true;
  }
  damage.integrity = Math.max(0, damage.integrity - severity);

  if (damage.stage !== 'burning' && damage.integrity <= FIRE_BELOW) {
    // A vehicle with nothing left of it always goes up; one nearly there takes
    // a roll. The stream is keyed on the tick, so the same crash of the same
    // session always decides the same way.
    if (damage.integrity === 0 || rngFor(seed, tick, Subsystem.Damage, id).chance(FIRE_CHANCE)) {
      ignite(damage, tick);
      return severity;
    }
  }
  settle(damage);
  return severity;
}

/**
 * Set a vehicle alight (spec section 11.3). This is what a Molotov, a spreading
 * fire and a ruinous crash all come to. A vehicle already burning or burnt out
 * is left alone, because the progression only runs one way.
 */
export function ignite(damage: DamageState, tick: number): void {
  if (damage.stage === 'burning' || damage.stage === 'burnt') return;
  damage.stage = 'burning';
  damage.litTick = tick;
}

/**
 * Put a fire out (spec section 20.3): what the hose of a fire engine does when
 * it reaches a vehicle that is still alight. Answers true where there was a
 * fire to put out.
 *
 * This is the one step back through the progression, and it is a short one. A
 * doused vehicle comes back to `smoking` and keeps everything the fire has
 * already cost it, so it is still a wreck and can still be set alight again. A
 * vehicle that has already gone up is `burnt`, and nothing takes it out of
 * that.
 */
export function extinguish(damage: DamageState): boolean {
  if (damage.stage !== 'burning') return false;
  damage.stage = 'smoking';
  damage.litTick = -1;
  return true;
}

/**
 * Take a vehicle's engine out, without touching its panels. This is what the
 * Barrett M82 does to what it shoots at (spec section 11.6): the car still
 * rolls, and what is left of the engine is {@link enginePowerScale} of a
 * smoking one. A vehicle already worse off than that is left where it is.
 */
export function disableEngine(damage: DamageState): void {
  if (damage.integrity <= SMOKE_BELOW) return;
  damage.integrity = SMOKE_BELOW;
  settle(damage);
}

/**
 * Run the fire of one vehicle for a tick. Answers true on the tick it
 * explodes, which is the tick the blast is felt on.
 */
export function tickFire(damage: DamageState, tick: number): boolean {
  if (damage.stage !== 'burning') return false;
  if (tick - damage.litTick < FUSE_TICKS) return false;
  explode(damage, tick);
  return true;
}

/**
 * Blow a vehicle up. Every panel goes, so what is left is the shell the
 * renderer scorches: an explosion is the end of the progression, and nothing
 * takes a vehicle out of it.
 */
export function explode(damage: DamageState, tick: number): void {
  if (damage.stage === 'burnt') return;
  damage.integrity = 0;
  for (let i = 0; i < PANELS.length; i++) {
    damage.dents[i] = 1;
    damage.lost[i] = true;
  }
  if (damage.litTick < 0) damage.litTick = tick;
  damage.stage = 'burnt';
  damage.blownTick = tick;
}

/** True where a fire could still take hold: it is not already burning or burnt out. */
export function isFlammable(damage: DamageState): boolean {
  return damage.stage !== 'burning' && damage.stage !== 'burnt';
}

/** One vehicle, as {@link spreadFire} needs to see it. */
export interface Burnable {
  /** Which vehicle this is. It keys the roll, so it must be stable across a replay. */
  id: number;
  /** Where it stands on the map, in metres. */
  x: number;
  y: number;
  damage: DamageState;
}

/**
 * Spread fire from the vehicles that are burning to the ones parked around
 * them (spec section 11.3).
 *
 * It is a timer: the fire reaches out every {@link SPREAD_PERIOD} ticks, and
 * only once it has burned for {@link SPREAD_DELAY}. So a row of cars goes up
 * one after another, with time between them, rather than all together. Each
 * vehicle within reach takes one roll however many fires reach it, which is
 * what keeps the answer the same whichever order the list is in.
 *
 * Answers the ids it set alight, so a caller can say so.
 */
export function spreadFire(vehicles: readonly Burnable[], seed: number, tick: number): number[] {
  const lit: number[] = [];
  if (tick % SPREAD_PERIOD !== 0) return lit;
  for (const target of vehicles) {
    if (!isFlammable(target.damage)) continue;
    let reached = false;
    for (const source of vehicles) {
      if (source.id === target.id || source.damage.stage !== 'burning') continue;
      if (tick - source.damage.litTick < SPREAD_DELAY) continue;
      if (hypot(source.x - target.x, source.y - target.y) > SPREAD_RADIUS) continue;
      reached = true;
      break;
    }
    if (!reached) continue;
    if (!rngFor(seed, tick, Subsystem.Damage, target.id).chance(SPREAD_CHANCE)) continue;
    ignite(target.damage, tick);
    lit.push(target.id);
  }
  return lit;
}

/**
 * What an explosion takes off someone standing a distance from it. It falls
 * away to nothing at {@link BLAST_RADIUS}, so the far edge of the blast is a
 * scare rather than a wound.
 */
export function blastDamageAt(distance: number): number {
  if (distance >= BLAST_RADIUS) return 0;
  const reach = 1 - distance / BLAST_RADIUS;
  return BLAST_DAMAGE * reach * reach;
}

/**
 * What is left of the engine, as a fraction of the roster's power. A battered
 * car is slower and still driveable; a burnt-out one does not move at all.
 */
export function enginePowerScale(damage: DamageState): number {
  if (damage.stage === 'burnt') return 0;
  return LIMP_POWER + (1 - LIMP_POWER) * damage.integrity;
}

/** True while the vehicle is trailing smoke, which it does from `smoking` on. */
export function isSmoking(damage: DamageState): boolean {
  return damage.stage !== 'intact' && damage.stage !== 'dented';
}

/** What the HUD calls the state it is in. */
export function conditionOf(damage: DamageState): string {
  if (damage.stage === 'burnt') return 'burnt out';
  if (damage.stage === 'burning') return 'on fire';
  return `${Math.round(damage.integrity * 100)}%`;
}

/**
 * Move the stage on to what the integrity now says, without ever moving it
 * back. Fire is not read off the integrity, so a burning vehicle is left where
 * it is.
 */
function settle(damage: DamageState): void {
  if (damage.stage === 'burning' || damage.stage === 'burnt') return;
  if (damage.integrity <= SMOKE_BELOW) damage.stage = 'smoking';
  else if (damage.integrity < 1) damage.stage = 'dented';
}
