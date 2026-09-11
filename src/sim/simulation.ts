import { EMPTY_INPUT, type InputFrame } from './input.ts';
import { gameTime, TICKS_PER_HOUR } from './clock.ts';
import { type CharacterAppearance, DEFAULT_APPEARANCE, normaliseAppearance } from './character.ts';
import { createPlayerState, type PlayerState } from './on-foot.ts';
import type { SimPhysics } from './physics.ts';
import type { TheftState } from './theft.ts';
import { createVehicleState, DEFAULT_CLASS, specOf, type VehicleState } from './vehicle.ts';
import { createLoadout, type LoadoutState, type ProjectileState } from './weapon.ts';

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
  /**
   * The player themselves (spec sections 11.2, 11.5): where they stand, which
   * way they face, whether they are driving or on foot, and their health. Plain
   * numbers for the same reason the vehicle is.
   */
  player: PlayerState;
  /**
   * The lock the player is working at (spec section 11.4), or null while they
   * are not breaking into anything. The minigame is a record like everything
   * else, so a theft replays exactly as it was played.
   */
  theft: TheftState | null;
  /**
   * What the player is carrying and the state of the weapon in their hands
   * (spec section 11.6): the magazines, the pools behind them, the reload and
   * the recoil. Plain numbers for the same reason the vehicle is.
   */
  loadout: LoadoutState;
  /**
   * Everything in the air (spec section 11.6): grenades, Molotovs and rockets,
   * each flying the line it was thrown on. They are part of the record, so a
   * save catches them mid-flight and a replay throws them the same way.
   */
  projectiles: ProjectileState[];
  /**
   * How much attention the player has drawn (spec section 14). The alarm of a
   * theft and every shot fired raise it; nothing spends it yet, and the police
   * issue is what will read it.
   */
  heat: number;
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
    player: createPlayerState(),
    theft: null,
    loadout: createLoadout(),
    projectiles: [],
    heat: 0,
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
