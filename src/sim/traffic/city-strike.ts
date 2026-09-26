/**
 * A car of the traffic hitting a person of the crowd (spec section 13.1). It
 * is the city's doing, not the player's, so the blow is marked `city` and no
 * crime is written for it. Giving way (`give-way.ts`) keeps the two apart, so
 * this happens only to somebody who runs into a moving car.
 */
import { hashInts } from '../../core/hash.ts';
import { cos, sin } from '../../core/libm.ts';
import { rngFor, Subsystem } from '../../core/rng.ts';
import { carDamage, KILL_SPEED, LIFT_MAX, LIFT_SHARE, LIFT_SPEED, SHOVE_SPEED, THROW_SHARE } from '../vehicles/car-strike.ts';
import { hurtPerson, PERSON_HEALTH, type CasualtyGround } from '../crowd/casualty.ts';
import type { PedestrianPose } from '../crowd/pedestrians.ts';
import type { CrowdSource } from '../weapons/melee.ts';
import type { SimState } from '../simulation.ts';

/** The key of the stream a car of the traffic hitting a person draws from. */
const STRIKE_STREAM = 3;

/**
 * Hit person `id`, standing at `pose`, with a car moving at `speed` along
 * `travel`. At a crawl the car only pushes them aside; faster it hurts them,
 * and faster still throws them over the bonnet. `spare` is a scratch list.
 */
export function cityHit(
  state: SimState,
  crowd: CrowdSource,
  speed: number,
  travel: number,
  id: number,
  pose: PedestrianPose,
  ground: CasualtyGround | undefined,
  spare: number[],
): void {
  const { x, y, height, heading } = pose;
  if (speed < SHOVE_SPEED) {
    crowd.startle(state.pedestrians, state.tick, x - cos(travel) * 0.05, y - sin(travel) * 0.05, 0.1, 'scatter', spare);
    return;
  }
  const rng = rngFor(state.seed, state.tick, Subsystem.Casualties, hashInts(STRIKE_STREAM, id));
  const damage = speed >= KILL_SPEED ? PERSON_HEALTH : carDamage(speed) * rng.range(0.8, 1.2);
  const fast = speed >= LIFT_SPEED;
  const push = speed * (fast ? THROW_SHARE : 0.9);
  const lift = fast ? Math.min(LIFT_MAX, speed * LIFT_SHARE) : 0;
  const dir = travel + rng.range(-0.3, 0.3);
  hurtPerson(state, crowd, id, { x, y, height, heading }, { cause: 'car', damage, dir, push, lift, city: true }, ground);
}
