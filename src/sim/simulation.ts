import { EMPTY_INPUT, type InputFrame } from './input.ts';
import { gameTime, TICKS_PER_HOUR } from './clock.ts';
import { type CharacterAppearance, DEFAULT_APPEARANCE, normaliseAppearance } from './character.ts';
import type { SimPhysics } from './physics.ts';
import { createVehicleState, DEFAULT_CLASS, specOf, type VehicleState } from './vehicle.ts';

/** The serialisable, deterministic state of a session. */
export interface SimState {
  seed: number;
  tick: number;
  /** The look picked on the title screen; saved and replicated with the player. */
  character: CharacterAppearance;
  /**
   * The car the player is in (spec section 11.3). Plain numbers: the Rapier
   * body is built from this, never stored in it, so a session is saved and
   * replayed as the record it is.
   */
  vehicle: VehicleState;
  player: {
    x: number;
    y: number;
    heading: number;
    speed: number;
  };
}

/** Tick at which a new session starts: 08:00 on day 0. */
export const START_TICK = 8 * TICKS_PER_HOUR;

export function createSimState(
  seed: number,
  character: CharacterAppearance = DEFAULT_APPEARANCE,
  startTick = START_TICK,
): SimState {
  return {
    seed,
    tick: startTick,
    character: normaliseAppearance(character),
    vehicle: createVehicleState(specOf(DEFAULT_CLASS)),
    player: { x: 0, y: 0, heading: 0, speed: 0 },
  };
}

/** Structural clone via JSON: state is plain data by design. */
export function cloneSimState(state: SimState): SimState {
  return JSON.parse(JSON.stringify(state)) as SimState;
}

/**
 * Advance the state by exactly one tick. Pure with respect to its inputs:
 * no wall-clock, no frame delta, no unseeded randomness.
 *
 * `physics` is the Rapier world of `physics.ts`, stepped here so the physics
 * runs at the simulation's 60 Hz and nowhere else (spec section 2.2). It holds
 * no state of its own: it reads the record, steps, and writes the record back.
 * Without it the tick still advances, so the clock and everything driven by it
 * can be exercised on their own; nothing moves.
 */
export function stepSim(state: SimState, input: InputFrame = EMPTY_INPUT, physics?: SimPhysics): void {
  physics?.step(state, input);
  state.tick += 1;
}

export { gameTime };
