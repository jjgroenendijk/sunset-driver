/**
 * Vehicle theft and the hotwire minigame (spec section 11.4).
 *
 * This holds the rules and nothing else: which vehicles open on the key and
 * which have to be worked at, the state of one attempt at a lock, and the one
 * tick of that attempt. Nothing here touches Rapier or the DOM, so the whole
 * minigame can be read and tested headless. `physics.ts` is what calls it once
 * a tick, and `src/ui/hotwire.ts` is what draws it.
 *
 * Most of the roster is get in and go. Only a vehicle with an alarm, and every
 * luxury or high-end one, makes the player work: {@link needsHotwire} is that
 * rule and it reads the roster's own `alarm` and `luxury` flags, so nothing
 * here carries a second list of what is worth stealing.
 *
 * The minigame is a marker sweeping a bar and a window on it to stop the marker
 * in. Each hit sets one pin; the lock opens on the last one. It works this way
 * for three reasons the spec asks for:
 *
 * - It never pauses the world. One call is one tick, made from the same step
 *   that drives the traffic and burns the fires, so the police close in while
 *   the player works.
 * - It is always winnable. A miss costs time and nothing else, and
 *   {@link HOTWIRE_CAP} ticks after it started the last pin gives way on its
 *   own, so no attempt can strand a player under pressure.
 * - It is replay-deterministic. Where the window sits for each pin comes from
 *   `rngFor(seed, startedTick, Subsystem.Theft, pin)`, so the same theft at the
 *   same tick of the same seed asks for the same presses.
 *
 * An alarm is the hook spec section 14 grows into: it sounds from the first
 * tick of the attempt until the lock opens, and every tick of it raises the
 * session's heat. Working quickly is therefore worth something beyond the
 * seconds it saves.
 */
import { rngFor, Subsystem } from '../core/rng.ts';
import { TICK_RATE } from './clock.ts';
import type { VehicleSpec, VehicleState } from './vehicle.ts';

/** Pins a lock has. Each one is a hit on the bar; the last one opens it. */
export const HOTWIRE_PINS = 3;

/** Ticks the marker takes to cross the bar once. There and back is twice this. */
export const SWEEP_TICKS = 72;

/**
 * Half the width of the window a pin is set in, as a fraction of the bar. The
 * marker crosses the whole bar in {@link SWEEP_TICKS}, so a window this wide is
 * open for about a quarter of a second at a time.
 */
export const TARGET_HALF = 0.11;

/**
 * Ticks a miss costs. The marker jams at the near end of the bar for this long
 * before it sweeps again, so a player who presses at random is slower than one
 * who waits, and neither can lose.
 */
export const MISS_PENALTY = 24;

/**
 * Ticks the whole attempt may take, after which the last pin gives way on its
 * own. Eight seconds: long enough to be under pressure, and short enough that
 * it is always survivable.
 *
 * A hit restarts the sweep, so a pin takes at most {@link SWEEP_TICKS} ticks
 * to reach however far across the bar its window sits. Every pin of a lock is
 * therefore winnable in {@link HOTWIRE_PINS} times that, which is well inside
 * this cap; {@link hotwireFloor} is that number and the tests pin the margin.
 */
export const HOTWIRE_CAP = 480;

/** Heat one finished theft is worth (spec section 14). */
export const THEFT_HEAT = 1;

/** Heat a sounding alarm is worth per second, on top of the theft itself. */
export const ALARM_HEAT_PER_SECOND = 0.5;

/** The most ticks a lock can ask of a player who never misses. */
export function hotwireFloor(): number {
  return HOTWIRE_PINS * SWEEP_TICKS;
}

/**
 * True where getting in means breaking in (spec section 11.4). An alarm says a
 * vehicle is watched and luxury says it is worth watching; everything else on
 * the roster opens on the key.
 */
export function needsHotwire(spec: VehicleSpec): boolean {
  return spec.alarm || spec.luxury;
}

/**
 * True while a vehicle still has to be worked at. A lock is beaten once: a
 * vehicle the player has already hotwired carries that in its record, so
 * getting out to look at something does not mean doing it all again.
 */
export function isLocked(v: VehicleState, spec: VehicleSpec): boolean {
  return needsHotwire(spec) && !v.hotwired;
}

/** One attempt at a lock, as the record carries it: plain numbers, like everything else. */
export interface TheftState {
  /** The tick the attempt started. Its age, and every window on it, is read off this. */
  startedTick: number;
  /** Pins set so far, 0 to {@link HOTWIRE_PINS}. */
  pins: number;
  /**
   * The tick the marker last left the near end of the bar. A hit or a miss
   * moves it, so the sweep is a function of the tick and nothing else.
   */
  sweepTick: number;
  /** True once the last pin is set and the vehicle is open. */
  open: boolean;
  /** True while the vehicle's alarm is sounding, which is what raises heat. */
  alarm: boolean;
  /** Heat the alarm has raised so far, so the HUD can say what it is costing. */
  noise: number;
}

/** A fresh attempt at a vehicle's lock, starting at a tick. */
export function createTheft(spec: VehicleSpec, tick: number): TheftState {
  return {
    startedTick: tick,
    pins: 0,
    sweepTick: tick,
    open: false,
    alarm: spec.alarm,
    noise: 0,
  };
}

/**
 * Where on the bar the window for a pin sits, 0 to 1. It is kept a window's
 * width clear of both ends, so every pin can be hit from either direction of
 * the sweep.
 */
export function targetFor(seed: number, startedTick: number, pin: number): number {
  return rngFor(seed, startedTick, Subsystem.Theft, pin).range(TARGET_HALF, 1 - TARGET_HALF);
}

/**
 * Where the marker stands on the bar at a tick, 0 to 1. It crosses the bar in
 * {@link SWEEP_TICKS} and comes back in the same, and it waits at the near end
 * while a miss is being paid for.
 */
export function markerAt(theft: TheftState, tick: number): number {
  const phase = tick - theft.sweepTick;
  if (phase <= 0) return 0;
  const cycle = (phase % (2 * SWEEP_TICKS)) / SWEEP_TICKS;
  return cycle <= 1 ? cycle : 2 - cycle;
}

/** True where a press at this tick would set the pin being worked at. */
export function wouldHit(theft: TheftState, seed: number, tick: number): boolean {
  const target = targetFor(seed, theft.startedTick, theft.pins);
  return Math.abs(markerAt(theft, tick) - target) <= TARGET_HALF;
}

/**
 * Advance an attempt by one tick and answer the heat its alarm raised over it
 * (spec section 14).
 *
 * `pressed` is the rising edge of the interact key: the key is held for as many
 * ticks as the finger is on it, and a pin set on the level would take the whole
 * lock in one press.
 */
export function stepTheft(theft: TheftState, seed: number, tick: number, pressed: boolean): number {
  if (theft.open) return 0;
  if (pressed) {
    if (wouldHit(theft, seed, tick)) {
      theft.pins += 1;
      theft.sweepTick = tick;
    } else {
      // The marker jams at the near end, then sweeps again from there.
      theft.sweepTick = tick + MISS_PENALTY;
    }
  }
  // The cap: the last pin gives way on its own, so the attempt always ends.
  if (tick - theft.startedTick >= HOTWIRE_CAP) theft.pins = HOTWIRE_PINS;
  if (theft.pins >= HOTWIRE_PINS) {
    theft.pins = HOTWIRE_PINS;
    theft.open = true;
  }
  const heat = theft.alarm ? ALARM_HEAT_PER_SECOND / TICK_RATE : 0;
  theft.noise += heat;
  return heat;
}
