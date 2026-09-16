/**
 * The metro and its fast travel (spec section 13.3).
 *
 * The line is underground and nothing of it is simulated: what the player meets
 * is a station entrance on the street, which `src/world/metro.ts` places. A
 * player who walks up to one on foot has visited it, and the record keeps the
 * set of stations they have visited. Standing at a visited station they may
 * travel to any other one they have visited.
 *
 * A trip is a fade, a teleport and a short arrival, and it costs exactly
 * {@link TRAVEL_TICKS} ticks of the simulation. The tick never skips: the city
 * around the player runs those ticks like any others, which is what makes the
 * trip safe to take in a session shared with other players (spec section 19).
 * The player is frozen while it runs, so the walk is not steered under the fade.
 *
 * Two things refuse a trip. Heat means the police are looking for the player,
 * and the metro is not a way out of that; a vehicle cannot be taken down the
 * stairs, so the player has to get out first.
 *
 * Pure: it reads the record and the stations, and writes the record. The
 * destination is taken from the input frame as a number, so a replay of a
 * recorded stream takes the same trip.
 */
import type { InputFrame } from './input.ts';
import type { Place } from './on-foot.ts';
import type { SimState } from './simulation.ts';

/** Metres of the entrance a player standing on foot is at the station. */
export const ENTRANCE_REACH = 7;

/** Ticks the screen fades out over, after which the player is at the far station. */
export const FADE_TICKS = 30;

/** Ticks the arrival takes: the fade back in at the far entrance. */
export const ARRIVAL_TICKS = 36;

/** Ticks a whole trip takes. The clock runs all of them (spec section 13.3). */
export const TRAVEL_TICKS = FADE_TICKS + ARRIVAL_TICKS;

/** A station entrance, as the simulation needs it: where the player comes out on the street. */
export interface MetroPlace extends Place {
  /** What the panel and the map call it, which is the district it serves. */
  name: string;
}

/** The trip in progress. */
export interface MetroTravel {
  /** Index into the world's stations of the station being travelled to. */
  to: number;
  /** The tick the trip started on. */
  started: number;
}

/** What the record keeps about the metro (spec section 13.3). */
export interface MetroState {
  /** Indices of the stations the player has been to, ascending. */
  visited: number[];
  /** The trip in progress, or null while the player is not on one. */
  travel: MetroTravel | null;
  /**
   * How many trips have been taken. The renderer reads it to put the camera
   * down at the far station rather than slide it across the city, the way it
   * reads a respawn.
   */
  trips: number;
}

export function createMetroState(): MetroState {
  return { visited: [], travel: null, trips: 0 };
}

/**
 * The station the player is at, or -1. A player driving past one is at it too,
 * so the panel can tell them why they may not take it. Stations never stand
 * within reach of each other, so the first within reach is the answer.
 */
export function stationAt(places: readonly MetroPlace[], state: SimState): number {
  for (let i = 0; i < places.length; i++) {
    const place = places[i] as MetroPlace;
    if (Math.hypot(place.x - state.player.x, place.y - state.player.y) <= ENTRANCE_REACH) return i;
  }
  return -1;
}

/**
 * The stations a trip from `from` may go to: every other station the player has
 * visited, ascending. The input frame's destination is a place in this list, so
 * the list is what the panel on screen has to show.
 */
export function destinations(state: SimState, from: number): number[] {
  return state.metro.visited.filter((id) => id !== from);
}

/**
 * Why a trip is refused, in the words the panel shows, or null when it is
 * allowed. A player at no station is asked nothing, so this answers for a
 * player who is at one.
 */
export function travelRefusal(state: SimState): string | null {
  if (state.player.driving) return 'Not with a vehicle.';
  if (state.heat > 0) return 'Not while the police want you.';
  return null;
}

/**
 * How dark the screen is, 0 to 1: full black at the moment of the teleport, and
 * clear at each end of the trip.
 */
export function travelFade(state: SimState, tick: number): number {
  const travel = state.metro.travel;
  if (travel === null) return 0;
  const elapsed = tick - travel.started;
  if (elapsed < FADE_TICKS) return Math.min(1, Math.max(0, elapsed / FADE_TICKS));
  return Math.min(1, Math.max(0, 1 - (elapsed - FADE_TICKS) / ARRIVAL_TICKS));
}

/** True while a trip holds the player, so the tick ignores what they press. */
export function travelling(state: SimState): boolean {
  return state.metro.travel !== null;
}

/**
 * Advance the metro by one tick, before the physics steps.
 *
 * It visits the station the player is standing at, starts the trip the input
 * frame asks for, and carries a trip in progress to the tick it lands on.
 * Answers true on the tick the player is put down at the far station, which is
 * the tick the physics has to stand them on the ground there.
 */
export function stepMetro(state: SimState, input: InputFrame, places: readonly MetroPlace[]): boolean {
  const metro = state.metro;
  const travel = metro.travel;
  if (travel !== null) {
    const elapsed = state.tick - travel.started;
    if (elapsed >= TRAVEL_TICKS) {
      metro.travel = null;
      return false;
    }
    if (elapsed !== FADE_TICKS) return false;
    const place = places[travel.to];
    if (place === undefined) {
      metro.travel = null;
      return false;
    }
    const p = state.player;
    p.x = place.x;
    p.y = place.y;
    p.heading = place.heading;
    p.speed = 0;
    p.vy = 0;
    p.grounded = false;
    metro.trips += 1;
    return true;
  }

  const here = stationAt(places, state);
  if (here < 0) return false;
  // A station is visited by walking up to it. Driving past the entrance is not
  // going down the stairs, whatever the panel says.
  if (state.player.driving) return false;
  visit(metro, here);
  const slot = Math.trunc(input.travel);
  if (slot < 1 || travelRefusal(state) !== null) return false;
  const to = destinations(state, here)[slot - 1];
  if (to === undefined) return false;
  metro.travel = { to, started: state.tick };
  return false;
}

/** Add a station to the visited set, which is kept ascending and without repeats. */
function visit(metro: MetroState, station: number): void {
  const at = metro.visited.findIndex((id) => id >= station);
  if (at < 0) metro.visited.push(station);
  else if (metro.visited[at] !== station) metro.visited.splice(at, 0, station);
}
