import type { Blast } from './blast.ts';
import { stepArrest } from './arrest.ts';
import { EMPTY_INPUT, type InputFrame } from './input.ts';
import { gameTime, TICKS_PER_HOUR } from './clock.ts';
import { type CharacterAppearance, DEFAULT_APPEARANCE, normaliseAppearance } from './character.ts';
import { createPlayerState, type Place, type PlayerState } from './on-foot.ts';
import type { SimPhysics } from './physics.ts';
import { fateOf, respawn, respawnPlace, type RespawnRecord } from './respawn.ts';
import type { TheftState } from './theft.ts';
import type { BoardingState } from './boarding.ts';
import { createVehicleState, DEFAULT_CLASS, specOf, type VehicleState } from './vehicle.ts';
import { stepPickups, type PickupState } from './pickup.ts';
import { createPedestrianState, type PedestrianState } from './pedestrians.ts';
import { createTrafficState, type TrafficState } from './traffic.ts';
import { createLoadout, type LoadoutState, type ProjectileState } from './weapon.ts';
import type { MeleeHit } from './melee.ts';
import type { Tracer } from './tracer.ts';
import { createMetroState, stepMetro, travelling, type MetroState } from './metro.ts';
import { stepShops, type ShopVisit } from './shop.ts';
import { createMarketState, stepMarket, type MarketState } from './market.ts';
import { createPropertyState, stepHome, type PropertyState } from './safehouse.ts';
import { createPoliceState, type PoliceState } from './police.ts';
import { createEmergencyState, type EmergencyState } from './emergency.ts';
import { createFireState, type FireState } from './fire.ts';
import { createEnforcerState, type EnforcerState } from './enforcer.ts';
import { createFactionState, type FactionState } from './faction.ts';
import { createMissionState, stepMissions, type MissionState } from './mission.ts';
import { createCrimeState, stepStreetCrime, type CrimeState } from './street-crime.ts';
import { stepTerritory } from './territory.ts';
import { stepRadio } from './radio.ts';
import { stepTowing } from './tow.ts';

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
   * The player getting into their vehicle or out of it (`boarding.ts`), or
   * null while they are doing neither. A save made mid-move loads mid-move.
   */
  boarding: BoardingState | null;
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
   * The blows a melee weapon has landed lately (spec section 11.6): what was
   * struck, where, and how hard. They are part of the record, so a replay
   * throws the same sparks and plays the same knock; `melee.ts` says how long
   * one is kept and `gunfire.ts` writes them.
   */
  hits: MeleeHit[];
  /**
   * The paths the rounds of the last few ticks took (spec section 11.6), so
   * the frame can draw the flash, the streak and the impact. `tracer.ts` says
   * how long one is kept and `gunfire.ts` writes them.
   */
  tracers: Tracer[];
  /**
   * The projectiles that went off in the last few ticks (spec section 11.6),
   * so the frame can draw the burst and the mix can play it. `blast.ts` says
   * how long one is kept and `gunfire.ts` writes them.
   */
  blasts: Blast[];
  /**
   * The weapons lying in the world to be picked up (spec section 11.6): what
   * the dead dropped and what was taken out of a police car.
   */
  pickups: PickupState[];
  /** The id the next pickup is given. */
  nextPickup: number;
  /**
   * The shop the player is standing inside (spec section 16.1), or null while
   * they are out on the street. What they bought there is already in the
   * fields around it: the loadout, the money, the health and the paint.
   */
  shop: ShopVisit | null;
  /**
   * The contraband trade of spec section 16.2: what the player is carrying,
   * what they paid for it, and the dealer they have a deal open with. The
   * prices are not here, because a price is a function of the seed and the
   * tick (`contraband.ts`) and a record may not hold a second copy of one.
   */
  market: MarketState;
  /**
   * How much attention the player has drawn (spec section 14). A crime raises
   * it by what `crime.ts` weighs the crime at, and it falls again only while
   * nobody is looking. `police.ts` reads it as how many units come and what
   * kind.
   */
  heat: number;
  /**
   * What the player is carrying, in dollars (spec section 12). The shop
   * counters of spec section 16.1 and the contraband market of 16.2 are what
   * move it; the HUD and both panels read it.
   */
  money: number;
  /**
   * The line the HUD shows as the current objective (spec section 12), or empty
   * while the player has none. The missions of spec section 18 write it, off
   * the leg of the job being carried (`mission.ts`).
   */
  objective: string;
  /**
   * The place the player has marked on the map (spec section 12), or null. It
   * is part of the record, so a save keeps the mark and a replay draws it.
   */
  waypoint: { x: number; y: number } | null;
  /**
   * The properties the player has bought, and what is in them (spec section
   * 16.3): the stash, the garage and which one they come back to.
   */
  property: PropertyState;
  /**
   * Where the player comes back with no safehouse to their name (spec sections
   * 11.7, 16.3): the place the session started at. A new record holds the
   * origin, and the game writes it once the world is built.
   */
  origin: Place;
  /**
   * True once the player has been taken in (spec section 11.7). The end of the
   * tick turns it into a respawn at the nearest police station. A unit that
   * reaches a player on foot sets it (spec section 14), as does the debug key.
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
  /**
   * The pedestrians who have left their loops (spec sections 5.3, 20.1). The
   * rest of the crowd is a function of the seed and the tick.
   */
  pedestrians: PedestrianState;
  /**
   * The metro of spec section 13.3: the stations the player has been to and the
   * trip they are on. A save carries the visited set, so the fast travel a
   * session earned is still there when it is loaded.
   */
  metro: MetroState;
  /**
   * The police of spec section 14: the units that are out, where they last saw
   * the player and when. The heat above is what calls them, and `police.ts`
   * steps them from the physics.
   */
  police: PoliceState;
  /**
   * What is burning on the ground (spec sections 11.3, 20.3): the blazes the
   * wrecks have left, which outlast the vehicles that started them and are
   * what a fire engine is really called to. What is burning in a vehicle is in
   * its own damage, and not here.
   */
  fires: FireState;
  /**
   * The fire engines and the ambulances of spec section 20.3: the calls the
   * city has made and the units that are out on them. A call is what has
   * happened — a fire, a crash, a blast — so it is on the record, while the
   * police above come out on the heat instead.
   */
  emergency: EmergencyState;
  /**
   * The factions of spec section 17: how the player stands with each of the
   * eight, the blocks they have taken, and the retaliation that is out after
   * them. Whose ground a block is otherwise is a function of the seed and the
   * tick (`territory.ts`), so the record holds the captures and never a map.
   */
  factions: FactionState;
  /**
   * The enforcers a faction has sent (spec section 17.2). They are the record's
   * like the police units are, so a save catches a wave mid-street and a replay
   * sends the same people down it.
   */
  enforcers: EnforcerState;
  /**
   * The work of spec section 18: the job being carried, the contact being
   * talked to, and what has been finished and lost. What a contact is offering
   * is not here, because an offer is a function of the seed, the contact and
   * the tick (`job.ts`) and a record may not hold a second copy of one.
   */
  missions: MissionState;
  /**
   * The street crime of spec section 20.5: the incidents the player has broken
   * up. What is going on where they are not is a function of the seed and the
   * tick (`street-crime.ts`), so the record holds only what they settled.
   */
  crimes: CrimeState;
}

/** Dollars a new session starts with (spec section 16). */
export const START_MONEY = 500;

/** Tick at which a new session starts: 08:00 on day 0. */
export const START_TICK = 8 * TICKS_PER_HOUR;

export function createSimState(
  seed: number,
  character: CharacterAppearance = DEFAULT_APPEARANCE,
  startTick = START_TICK,
  money = START_MONEY,
): SimState {
  return {
    seed,
    tick: startTick,
    character: normaliseAppearance(character),
    vehicle: createVehicleState(specOf(DEFAULT_CLASS)),
    player: createPlayerState(),
    theft: null,
    boarding: null,
    shop: null,
    loadout: createLoadout(),
    projectiles: [],
    hits: [],
    tracers: [],
    blasts: [],
    pickups: [],
    nextPickup: 0,
    market: createMarketState(),
    heat: 0,
    money,
    objective: '',
    waypoint: null,
    property: createPropertyState(),
    origin: { x: 0, y: 0, heading: 0 },
    arrested: false,
    respawn: null,
    traffic: createTrafficState(),
    pedestrians: createPedestrianState(),
    metro: createMetroState(),
    police: createPoliceState(),
    fires: createFireState(),
    emergency: createEmergencyState(),
    factions: createFactionState(),
    enforcers: createEnforcerState(),
    missions: createMissionState(),
    crimes: createCrimeState(),
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
 * The metro of spec section 13.3 runs first, because a trip freezes the player:
 * the physics is then stepped with an empty frame, so the city carries on
 * around them and nothing they press steers the walk under the fade. A player
 * with a deal open at a dealer (spec section 16.2) hands the metro an empty
 * frame for the other half of that reason: the number keys are the trading
 * panel's while it is up, and a dealer may be standing at a station entrance.
 *
 * A death or an arrest is resolved last (spec section 11.7), so the tick that
 * ends a run is the tick the player comes back on.
 *
 * The burnt-out shells the player has left behind are cleared after the physics
 * (`tow.ts`), which is the one thing that ever takes a vehicle back out of the
 * record.
 */
export function stepSim(state: SimState, input: InputFrame = EMPTY_INPUT, physics?: SimPhysics): void {
  // The radio of spec section 15 is a turn of a number in the record and
  // nothing else, so it is taken before anything moves.
  stepRadio(state, input);
  if (stepMetro(state, state.market.deal === null ? input : EMPTY_INPUT, physics?.metro ?? [])) physics?.stand(state);
  // The shops of spec section 16.1 run before the physics for the reason the
  // metro does: a door walked through moves the player, and the physics has to
  // stand them on the ground where they landed. It is also where the interact
  // key is spent when a door opens on it, before `transfer` looks for the same
  // edge. A player under the fade of a trip is holding nothing.
  const homes = physics?.safehouses ?? [];
  if (!travelling(state) && stepShops(state, input, physics?.shops ?? [], homes)) physics?.stand(state);
  // The front doors of spec section 16.3 take what the shops left of the
  // interact key. Nothing here moves the player — a safehouse is a door and not
  // a room — but a car taken out of the garage has to be stood on the ground
  // outside it, and the record does not know how high that ground is.
  const fetched = travelling(state) ? null : stepHome(state, input, homes);
  if (fetched !== null) physics?.settle(state, fetched.x, fetched.y, fetched.heading);
  // The dealers of spec section 16.2 take what is left of the interact key
  // after those two, so one press never opens two panels. Nothing here moves
  // the player, so the physics is told nothing.
  if (!travelling(state)) stepMarket(state, input, physics?.dealers ?? []);
  // The contacts of spec section 18 take the last of the interact key, after
  // every door and every corner, so one press never opens two panels. The job
  // being carried is judged here too, before the turf, because a job to take a
  // block is what allows the block to be taken (`territory.ts`).
  const missions = physics?.missions;
  if (missions !== undefined && !travelling(state)) stepMissions(state, input, missions);
  // The turf of spec section 17.2 is a rule of the record rather than a thing
  // on the street: standing on a block is what takes it, so it is read before
  // the physics moves the player off it. The enforcers it calls out are people,
  // so they are stepped with the police, after the world has moved.
  const turf = physics?.turf;
  if (turf !== undefined && !travelling(state)) stepTerritory(state, turf);
  // The cuffs of spec section 11.7 are judged before the physics: a player an
  // officer has hold of, or one with their hands up, is stepped holding nothing.
  const held = stepArrest(state, input);
  physics?.step(state, travelling(state) || held ? EMPTY_INPUT : input);
  stepPickups(state);
  // The street crime of spec section 20.5 is judged where the physics left the
  // player, so walking into a mugging on this tick breaks it up on this tick.
  stepStreetCrime(state, physics?.crimes ?? []);
  // The wrecks of spec section 20.2 are cleared after the physics has settled
  // them, so a shell is only ever taken from where the tick left it.
  stepTowing(state);
  const fate = fateOf(state);
  if (fate !== null) {
    respawn(state, fate, respawnPlace(state, fate, physics?.stations ?? [], homes));
    physics?.stand(state);
  }
  state.tick += 1;
}

export { gameTime };
