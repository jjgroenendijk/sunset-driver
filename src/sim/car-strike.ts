/**
 * The player's car against the people in the street (spec sections 11.3, 13.1).
 *
 * Once a tick, after the physics has moved the car, every person inside its
 * footprint is struck. How hard depends on how fast the car is going, and the
 * curve is a forgiving one: a car at a crawl pushes a person aside, one in
 * town traffic knocks them down and hurts them, and it takes a very fast car
 * to kill. A fast car lifts a person over its bonnet, and they land and slide.
 *
 * A body lying in the road is not struck like that: the car goes over it, and
 * it is the car that feels it, as a bump. Whoever is lying there and still
 * alive is hurt by it.
 *
 * The car feels every hit. What it gives a person it loses itself, so a car
 * slows through a crowd, and a hit dents the front of it. This answers what
 * the car lost and how hard it bumped, and `physics.ts` puts that into the
 * chassis, since only it holds the Rapier body.
 */
import { hashInts } from '../core/hash.ts';
import { atan2, cos, hypot, sin } from '../core/libm.ts';
import { rngFor, Subsystem } from '../core/rng.ts';
import { casualtyPose, emptyCasualtyPose, upright } from './casualty-motion.ts';
import { dead, hurtPerson, PERSON_HEALTH, type CasualtyGround } from './casualty.ts';
import { BODY_RADIUS, type CrowdLookup } from './crowd-contact.ts';
import { damageVehicle } from './damage.ts';
import { markHit } from './melee.ts';
import type { CrowdSource } from './melee.ts';
import { crowdPoseOf, type PedestrianPose } from './pedestrians.ts';
import type { SimState } from './simulation.ts';
import { headingOf, type VehicleSpec } from './vehicle.ts';

/** Metres per second below which a car only pushes a person aside: about 15 km/h. */
export const SHOVE_SPEED = 4;

/** Metres per second at which a car kills anybody it hits: about 80 km/h. */
export const KILL_SPEED = 22;

/** Metres per second above which a hit lifts a person over the bonnet rather than knocking them down. */
export const LIFT_SPEED = 8;

/** Kilograms a person weighs, which is what the car gives up in a hit. */
export const PERSON_MASS = 75;

/** The share of the car's speed a person struck is thrown at. */
export const THROW_SHARE = 0.8;

/** Metres per second up a hit gives, per metre a second of the car, and the most it gives. */
export const LIFT_SHARE = 0.2;
export const LIFT_MAX = 5;

/** Ticks between two bumps from the same body, so going over one is one bump a wheel pair. */
export const BUMP_GAP = 20;

/** Metres per second up a body under the car gives it. */
export const BUMP_LIFT = 0.9;

/** Damage going over a person who is still alive does to them. */
export const RUN_OVER_DAMAGE = 35;

/** What the car took from the people it met on one tick. */
export interface CarStrike {
  /** Kilogram metres per second the car loses along its travel. */
  loss: number;
  /** Kilogram metres per second up the bodies under it give it. */
  bump: number;
  /** How many people it struck standing. */
  struck: number;
}

/** The damage a car hit at `speed` does, before the per-person spread. */
export function carDamage(speed: number): number {
  if (speed < SHOVE_SPEED) return 0;
  const share = Math.min(1, (speed - SHOVE_SPEED) / (KILL_SPEED - SHOVE_SPEED));
  return 100 * share ** 1.6;
}

/**
 * Strike everyone inside the player's car on this tick, and answer what the
 * car lost. Only a car the player is driving strikes anybody.
 */
export function strikeCrowd(
  state: SimState,
  crowd: CrowdSource & CrowdLookup,
  spec: VehicleSpec,
  ground: CasualtyGround | undefined,
  ids: number[] = [],
): CarStrike {
  const strike: CarStrike = { loss: 0, bump: 0, struck: 0 };
  const v = state.vehicle;
  if (!state.player.driving) return strike;
  const speed = hypot(v.vx, v.vz);
  if (speed < 1) return strike;
  const heading = headingOf(v);
  const fx = cos(heading);
  const fy = sin(heading);
  const travel = atan2(v.vz, v.vx);
  const floor = v.y - spec.halfHeight;
  const reach = spec.halfLength + spec.halfWidth + BODY_RADIUS;
  const inside = (x: number, y: number, h: number, pad: number): number | undefined => {
    const rx = x - v.x;
    const ry = y - v.z;
    const along = rx * fx + ry * fy;
    const across = -rx * fy + ry * fx;
    if (Math.abs(along) > spec.halfLength + pad || Math.abs(across) > spec.halfWidth + pad) return undefined;
    if (Math.abs(h - floor) > 1.5) return undefined;
    return across;
  };
  const peds = state.pedestrians;
  const pose: PedestrianPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' };
  const standing: { id: number; x: number; y: number; height: number; heading: number; across: number }[] = [];
  for (const id of crowd.near(v.x - reach, v.z - reach, v.x + reach, v.z + reach, ids)) {
    if (crowdPoseOf(crowd, peds, id, state.tick, pose) === undefined) continue;
    const across = inside(pose.x, pose.y, pose.height, BODY_RADIUS);
    if (across !== undefined) standing.push({ id, x: pose.x, y: pose.y, height: pose.height, heading: pose.heading, across });
  }
  const hurt = emptyCasualtyPose();
  for (const record of [...peds.casualties]) {
    if (record.gone) continue;
    casualtyPose(record, state.tick, hurt);
    if (hurt.phase === 'air') continue;
    const across = inside(hurt.x, hurt.y, hurt.height, upright(hurt) ? BODY_RADIUS : 0);
    if (across === undefined) continue;
    if (upright(hurt)) {
      standing.push({ id: record.id, x: hurt.x, y: hurt.y, height: hurt.height, heading: hurt.heading, across });
      continue;
    }
    // Lying in the road: the car goes over them.
    if (state.tick - record.bumped < BUMP_GAP || speed < 1.5) continue;
    record.bumped = state.tick;
    strike.bump += PERSON_MASS * BUMP_LIFT;
    strike.loss += PERSON_MASS * speed * 0.15;
    markHit(state.hits, { tick: state.tick, x: hurt.x, y: hurt.y, h: hurt.height + 0.3, surface: 'person', strength: 0.4 });
    if (!dead(record)) {
      hurtPerson(state, crowd, record.id, hurt, { cause: 'car', damage: RUN_OVER_DAMAGE, dir: travel, push: 0.5, lift: 0 }, ground);
    }
  }
  for (const person of standing) {
    if (speed < SHOVE_SPEED) {
      // A car at a crawl pushes somebody aside, and they run: a fright from a
      // hair behind them, so nobody else is taken with them.
      const back = atan2(person.y - v.z, person.x - v.x);
      crowd.startle(peds, state.tick, person.x - cos(back) * 0.05, person.y - sin(back) * 0.05, 0.1, 'flee', ids);
      continue;
    }
    const rng = rngFor(state.seed, state.tick, Subsystem.Casualties, hashInts(2, person.id));
    // Past the speed that kills, it kills whoever it is: the spread is below it.
    const damage = speed >= KILL_SPEED ? PERSON_HEALTH : carDamage(speed) * rng.range(0.8, 1.2);
    // Struck off the middle of the bonnet, a person goes off to that side.
    const dir = travel + 0.35 * (person.across / Math.max(0.5, spec.halfWidth)) + rng.range(-0.1, 0.1);
    const fast = speed >= LIFT_SPEED;
    const push = speed * (fast ? THROW_SHARE : 0.9);
    const lift = fast ? Math.min(LIFT_MAX, speed * LIFT_SHARE) : 0;
    const record = hurtPerson(state, crowd, person.id, person, { cause: 'car', damage, dir, push, lift }, ground);
    if (record === undefined) continue;
    strike.struck++;
    strike.loss += PERSON_MASS * push;
    markHit(state.hits, {
      tick: state.tick,
      x: person.x,
      y: person.y,
      h: person.height + 1,
      surface: 'person',
      strength: Math.min(1, speed / 20),
    });
    // The front of the car takes the dent: the panel rule reads along, across, up.
    const side = Math.max(-1, Math.min(1, person.across / Math.max(0.5, spec.halfWidth))) * 0.5;
    damageVehicle(v.damage, speed * 0.004, 1, side, 0, state.seed, state.tick);
  }
  return strike;
}
