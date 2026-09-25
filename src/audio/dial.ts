/**
 * Where the dial stands and what the station on it has reached (spec section
 * 15).
 *
 * The record carries one number per vehicle: how far round the dial it has been
 * turned. It is not bounded there, because `src/sim` has no business knowing
 * how many stations there are; the wrap is here, and Off is a position on the
 * dial like any station, the way a car radio's is.
 *
 * A station's bar is read off the simulation tick, so every station is always
 * playing: tuning back to one finds it where it would have been, and the music
 * keeps the game's own clock rather than a clock of its own.
 */
import { TICK_RATE } from '../sim/clock.ts';
import { broadcastAt, type Broadcast } from './programme.ts';
import { STATIONS, type Station } from './stations.ts';

/** Positions on the dial: every station, and Off after the last of them. */
export const DIAL_POSITIONS = STATIONS.length + 1;

/** Beats to a bar. Everything on the dial is in four. */
const BEATS_PER_BAR = 4;

/** Where an unbounded turn of the dial lands, 0 to {@link DIAL_POSITIONS} - 1. */
export function wrapDial(dial: number): number {
  const at = Math.round(dial) % DIAL_POSITIONS;
  return at < 0 ? at + DIAL_POSITIONS : at;
}

/** The station the dial is on, or null where it is on Off. */
export function tunedTo(dial: number): Station | null {
  return STATIONS[wrapDial(dial)] ?? null;
}

/** Seconds one bar of a station lasts. */
export function barSeconds(station: Station): number {
  return (60 / station.tempo) * BEATS_PER_BAR;
}

/** Ticks one bar of a station lasts, which is how the bar is read off the record. */
export function barTicks(station: Station): number {
  return barSeconds(station) * TICK_RATE;
}

/** Where a station stands at a tick: the bar it is in, and how far through that bar. */
export interface DialPoint {
  station: Station;
  /** The bar the station has been running for, counted from the start of the session. */
  bar: number;
  /** How far through that bar, 0 to 1. */
  phase: number;
  /** What is going out on that bar. */
  broadcast: Broadcast;
}

/** What the station on `dial` is doing at `tick`, or null where the dial is on Off. */
export function dialAt(seed: number, dial: number, tick: number): DialPoint | null {
  const at = wrapDial(dial);
  const station = STATIONS[at];
  if (station === undefined) return null;
  const length = barTicks(station);
  const bar = Math.floor(tick / length);
  return { station, bar, phase: (tick - bar * length) / length, broadcast: broadcastAt(seed, at, bar) };
}

/** What the HUD calls the dial's position. */
export function dialName(dial: number): string {
  return tunedTo(dial)?.name ?? 'Radio off';
}
