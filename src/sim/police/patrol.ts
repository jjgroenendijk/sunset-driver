/**
 * The police policing the world (spec section 14): while nobody is after the
 * player, a patrol car answers the city's own street crime near them.
 *
 * The incidents are the diary of spec section 20.5 (`street-crime.ts`), which
 * is a pure function of the seed and the tick. A car is sent to one that is
 * going on near the player and pulls up at it: behind the driver of a traffic
 * stop, which is the driver it has pulled over, and at the corner of anything
 * else. When the incident is over, or the player has left it behind, the car
 * drives off and is taken off the map out of sight, as a stood-down unit is.
 *
 * It runs only at no heat. A chase calls every car on its own business in,
 * and the force steps none of this while the chase is on, so the patrol costs
 * a chase nothing. Between chases it reads the diary once a second.
 */
import { rngFor, Subsystem } from '../../core/rng.ts';
import { atan2, cos, hypot, sin } from '../../core/libm.ts';
import { TICK_RATE } from '../clock.ts';
import type { PoliceUnit } from './police.ts';
import type { SimState } from '../simulation.ts';
import type { Quarry } from './squad.ts';
import { crimesAt, type CrimeGround, type StreetCrime } from '../city/street-crime.ts';

/** Metres from the player an incident is answered over: about what the street shows of it. */
export const ANSWER_NEAR = 160;

/** Cars answering at once. */
export const ANSWERING = 2;

/** Ticks between two reads of the diary. */
export const ANSWER_EVERY = TICK_RATE;

/** Metres from the incident a car comes in at, on the far side from the player. */
const APPROACH = 220;

/** Radians either side of straight away from the player the car comes in on. */
const APPROACH_SPREAD = 0.9;

/** Metres behind a stopped driver the patrol car pulls up. */
const PULL_UP = 7;

/** Metres from the player a car that is done drives off to, past where it is taken off the map. */
const LEAVE_REACH = 320;

/** Brings a patrol car out on the road nearest a place, or answers nothing where there is none. */
export type Raise = (id: number, x: number, y: number) => PoliceUnit | undefined;

/** The incidents going on within {@link ANSWER_NEAR} of the player, in id order. */
export function incidentsNear(state: SimState, grounds: readonly CrimeGround[], quarry: Quarry): StreetCrime[] {
  if (grounds.length === 0) return [];
  return crimesAt(state.seed, state.tick, grounds, state.crimes).filter(
    (crime: StreetCrime) => hypot(crime.x - quarry.x, crime.y - quarry.y) <= ANSWER_NEAR,
  );
}

/** Where a car answering an incident pulls up: behind a stopped driver, at the corner of anything else. */
export function answerGoal(crime: StreetCrime): { x: number; y: number } {
  if (crime.kind !== 'stop') return { x: crime.x, y: crime.y };
  return { x: crime.x - cos(crime.heading) * PULL_UP, y: crime.y - sin(crime.heading) * PULL_UP };
}

/**
 * One read of the diary, at no heat: release the cars whose incident is over
 * or out of reach, and send one to each incident nobody is answering, up to
 * {@link ANSWERING}. Cars are sent in the id order of the incidents, so a
 * replay sends the same car to the same corner.
 */
export function patrol(state: SimState, quarry: Quarry, grounds: readonly CrimeGround[], raise: Raise): void {
  if (state.tick % ANSWER_EVERY !== 0) return;
  const police = state.police;
  const live = incidentsNear(state, grounds, quarry);
  let answering = 0;
  for (const unit of police.units) {
    if (unit.task === 'leave') leave(unit, quarry);
    if (unit.task !== 'answer') continue;
    if (live.some((crime: StreetCrime) => crime.id === unit.incident)) {
      answering += 1;
      continue;
    }
    unit.task = 'leave';
    unit.incident = -1;
    leave(unit, quarry);
  }
  for (const crime of live) {
    if (answering >= ANSWERING) return;
    if (police.units.some((unit: PoliceUnit) => unit.incident === crime.id)) continue;
    const id = police.nextUnit;
    const rng = rngFor(state.seed, state.tick, Subsystem.Patrol, id);
    const away = atan2(crime.y - quarry.y, crime.x - quarry.x) + rng.range(-APPROACH_SPREAD, APPROACH_SPREAD);
    const unit = raise(id, crime.x + cos(away) * APPROACH, crime.y + sin(away) * APPROACH);
    if (unit === undefined) continue;
    const goal = answerGoal(crime);
    unit.task = 'answer';
    unit.incident = crime.id;
    unit.goalX = goal.x;
    unit.goalY = goal.y;
    police.nextUnit = id + 1;
    police.units.push(unit);
    answering += 1;
  }
}

/** Aim a car that is done at a place past the edge of what the player sees, away from them. */
function leave(unit: PoliceUnit, quarry: Quarry): void {
  const away = atan2(unit.y - quarry.y, unit.x - quarry.x);
  unit.goalX = quarry.x + cos(away) * LEAVE_REACH;
  unit.goalY = quarry.y + sin(away) * LEAVE_REACH;
}
