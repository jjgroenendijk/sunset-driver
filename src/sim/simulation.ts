import { EMPTY_INPUT, type InputFrame } from './input.ts';
import { gameTime, TICKS_PER_HOUR } from './clock.ts';
import { type CharacterAppearance, DEFAULT_APPEARANCE, normaliseAppearance } from './character.ts';
import { createPlayerState, type Place, type PlayerState } from './on-foot.ts';
import type { SimPhysics } from './physics.ts';
import { fateOf, respawn, respawnPlace, type RespawnRecord } from './respawn.ts';
import type { TheftState } from './theft.ts';
import { createVehicleState, DEFAULT_CLASS, specOf, type VehicleState } from './vehicle.ts';
import { stepPickups, type PickupState } from './pickup.ts';
import { createTrafficState, type TrafficState } from './traffic.ts';
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
   * The weapons lying in the world to be picked up (spec section 11.6): what
   * the dead dropped and what was taken out of a police car.
   */
  pickups: PickupState[];
  /** The id the next pickup is given. */
  nextPickup: number;
  /**
   * How much attention the player has drawn (spec section 14). The alarm of a
   * theft and every shot fired raise it; nothing spends it yet, and the police
   * issue is what will read it.
   */
  heat: number;
  /**
   * What the player is carrying, in dollars (spec section 12). The economy of
   * spec section 16 is what will move it; the HUD is what reads it today.
   */
  money: number;
  /**
   * The line the HUD shows as the current objective (spec section 12), or empty
   * while the player has none. The mission framework of spec section 18 is what
   * will write it.
   */
  objective: string;
  /**
   * The place the player has marked on the map (spec section 12), or null. It
   * is part of the record, so a save keeps the mark and a replay draws it.
   */
  waypoint: { x: number; y: number } | null;
  /**
   * Where the player comes back after a death (spec sections 11.7, 16.3). The
   * safehouses have not landed, so a session sets it to the place it starts
   * at; a new record holds the origin.
   */
  safehouse: Place;
  /**
   * True once the player has been taken in (spec section 11.7). The end of the
   * tick turns it into a respawn at the nearest police station. The police of
   * spec section 14 are what will set it; today only the debug key does.
   */
  arrested: boolean;
  /**
   * The last death or arrest, or null before the first. The renderer reads it
   * to put the camera down at once rather than slide it across the map, and
   * the HUD reads it to say what happened.
   */
  respawn: RespawnRecord | null;
  /**
   * The ambient vehicles that have left their trajectories (spec section 5.3).
   * The rest of the traffic is a function of the seed and the tick, so it is
   * not in the record at all.
   */
  traffic: TrafficState;
}

/** Dollars a new session starts with (spec section 16). */
export const START_MONEY = 500;

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
    pickups: [],
    nextPickup: 0,
    heat: 0,
    money: START_MONEY,
    objective: '',
    waypoint: null,
    safehouse: { x: 0, y: 0, heading: 0 },
    arrested: false,
    respawn: null,
    traffic: createTrafficState(),
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
 * can be exercised on their own; nothing moves. The pickups are stepped after
 * the physics, so the player takes what lies where the tick left them.
 *
 * A death or an arrest is resolved last (spec section 11.7), so the tick that
 * ends a run is the tick the player comes back on.
 */
export function stepSim(state: SimState, input: InputFrame = EMPTY_INPUT, physics?: SimPhysics): void {
  physics?.step(state, input);
  stepPickups(state);
  const fate = fateOf(state);
  if (fate !== null) {
    respawn(state, fate, respawnPlace(state, fate, physics?.stations ?? []));
    physics?.stand(state);
  }
  state.tick += 1;
}

export { gameTime };
