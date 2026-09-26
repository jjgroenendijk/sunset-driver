/**
 * The airport the police guard (spec section 14): the runway, the taxiways and
 * the aprons are airside, and the military compound behind its fence is worse.
 *
 * A player on airside ground is reported every {@link AIRSIDE_EVERY} ticks, and
 * the heat it raises stops at {@link AIRSIDE_STARS}: a trespasser is chased,
 * not shot. The compound raises it to {@link COMPOUND_STARS}. A pilot at the
 * controls of a civil aircraft is no trespasser: the apron is where an aircraft
 * stands, and a hangar's aircraft comes out onto it. Nothing is stored,
 * because the rule is a function of where the player stands and the tick;
 * leaving the airside is all it takes to stop it.
 *
 * Taking one of the military's own aircraft is a crime of its own, weighed in
 * `crime.ts` to the stars at which the police helicopter comes up.
 */
import type { AircraftClass, Airfield, AirfieldPart } from '../world/types.ts';
import { toLocal } from '../world/airfield-frame.ts';
import { isMilitary } from './aircraft-roster.ts';
import { TICK_RATE } from './clock.ts';
import { heatStars, type Crime } from './crime.ts';
import { commitCrime } from './police.ts';
import type { SimState } from './simulation.ts';
import { isAircraft, type VehicleClass } from './vehicle.ts';

/** Ticks between two reports of a player on airside ground. */
export const AIRSIDE_EVERY = 2 * TICK_RATE;

/** The stars trespass on the airside, and in the compound, raises the heat to at most. */
export const AIRSIDE_STARS = 2;
export const COMPOUND_STARS = 3;

/** Metres over an airfield's level a player may be and still be on its ground. */
const ON_GROUND = 4;

/** The parts of an airport that are airside. */
const AIRSIDE: readonly AirfieldPart['kind'][] = ['runway', 'taxiway', 'apron', 'pad', 'compound'];

const scratch = { u: 0, v: 0 };

/** The two kinds of airside ground: the military compound and the rest. */
type Zone = 'compound' | 'airside';

/** What a place on an airport is: the compound, the rest of the airside, or neither. */
export function airsideAt(fields: readonly Airfield[], x: number, y: number): Zone | undefined {
  let found: Zone | undefined;
  for (const field of fields) {
    if (field.kind !== 'airport') continue;
    toLocal(field, x, y, scratch);
    if (Math.abs(scratch.u) > field.halfU || Math.abs(scratch.v) > field.halfV) continue;
    const zone = zoneInField(field);
    if (zone === 'compound') return 'compound';
    found = zone ?? found;
  }
  return found;
}

/** The airside zone of one airport under the local point in `scratch`, or undefined. */
function zoneInField(field: Airfield): Zone | undefined {
  let found: Zone | undefined;
  for (const part of field.parts) {
    if (!AIRSIDE.includes(part.kind)) continue;
    if (Math.abs(scratch.u - part.u) > part.halfU || Math.abs(scratch.v - part.v) > part.halfV) continue;
    if (part.kind === 'compound') return 'compound';
    found = 'airside';
  }
  return found;
}

/**
 * One tick of the airside rule: report a player standing or driving on it, up
 * to the stars it may raise the heat to. One flying over it is not on it.
 */
export function stepAirside(state: SimState, fields: readonly Airfield[] | undefined): void {
  if (fields === undefined || state.tick % AIRSIDE_EVERY !== 0) return;
  const p = state.player;
  const x = p.driving ? state.vehicle.x : p.x;
  const y = p.driving ? state.vehicle.z : p.y;
  const zone = airsideAt(fields, x, y);
  if (zone === undefined) return;
  // A pilot at the controls of a civil aircraft belongs on the apron; the
  // compound is still nobody's but the military's.
  const pilot = p.driving && isAircraft(state.vehicle.cls) && !isMilitary(state.vehicle.cls as AircraftClass);
  if (pilot && zone === 'airside') return;
  const level = fields.find((field) => field.kind === 'airport')?.level ?? p.height;
  if (p.height - level > ON_GROUND) return;
  if (heatStars(state.heat) >= (zone === 'compound' ? COMPOUND_STARS : AIRSIDE_STARS)) return;
  commitCrime(state, 'trespass');
}

/** The crime taking a vehicle of a class is: a military aircraft is worse than a car. */
export function theftOf(cls: VehicleClass): Crime {
  return isAircraft(cls) && isMilitary(cls as AircraftClass) ? 'militaryTheft' : 'theft';
}
