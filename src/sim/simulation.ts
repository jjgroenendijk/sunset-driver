import { EMPTY_INPUT, type InputFrame } from './input.ts';
import { gameTime, TICKS_PER_HOUR } from './clock.ts';
import { type CharacterAppearance, DEFAULT_APPEARANCE, normaliseAppearance } from './character.ts';

/** The serialisable, deterministic state of a session. */
export interface SimState {
  seed: number;
  tick: number;
  /** The look picked on the title screen; saved and replicated with the player. */
  character: CharacterAppearance;
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
 */
export function stepSim(state: SimState, input: InputFrame = EMPTY_INPUT): void {
  const dt = 1 / 60;
  const p = state.player;

  // Placeholder character motion until the driving and on-foot models land.
  const accel = 12;
  const drag = 2.5;
  const target = input.throttle * (input.sprint ? 14 : 8);
  p.speed += (target - p.speed) * Math.min(1, accel * dt);
  p.speed -= p.speed * drag * dt;
  p.heading += input.steer * 2.5 * dt;
  p.x += Math.cos(p.heading) * p.speed * dt;
  p.y += Math.sin(p.heading) * p.speed * dt;

  state.tick += 1;
}

export { gameTime };
