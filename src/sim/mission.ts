/**
 * The mission framework of spec section 18: taking a job, carrying it, and the
 * four states one can be in.
 *
 * A job is offered by a contact standing on a street (`giver.ts`), assembled
 * from the seeded world (`job.ts`), and then lives on the record until it is
 * finished or lost. The four states the spec asks for are the record itself: an
 * offer is a job nobody has taken, so it is generated and never kept; the
 * active job is the one field here; a completed job pays and is gone; a failed
 * one is gone without paying. One job at a time, so the state machine is one
 * field and not a list.
 *
 * A job is judged leg by leg. Nothing watches the player except the leg they
 * are on: arrive, arrive at the wheel of the class asked for, stand the ground
 * for a while, or hold the block. That is what lets seven kinds of work share
 * one loop, and what keeps a replay exact — the record says which leg and how
 * long they have stood on it, and nothing reads a clock.
 *
 * Losing a job is the clock running out, or the player dying or being taken in
 * while carrying it. Walking away from a hold puts the standing back to zero
 * rather than losing the job, because a player driven off a corner by the
 * people they were hired against has not failed yet.
 *
 * Pure: it reads the record and writes the record, and takes no wall-clock.
 */
import { hypot } from '../core/libm.ts';
import { chainFinished, chainLost, chainOffers, createChainState, type ChainState } from './chain.ts';
import { TICK_RATE } from './clock.ts';
import { shiftStanding } from './faction.ts';
import { giverAt, giverRefusal, GIVER_REACH, type GiverPlace } from './giver.ts';
import type { InputFrame } from './input.ts';
import { offerFor, type JobLeg, type JobOffer, type MissionJob, type MissionWorld } from './job.ts';
import { dollars } from './market.ts';
import { reachesVehicle } from './on-foot.ts';
import type { SimState } from './simulation.ts';
import { blockKeyAt, callWave, captured } from './territory.ts';
import { specOf } from './vehicle.ts';

/** Metres of a leg's place the player must reach to have arrived there. */
export const LEG_REACH = 10;

/** Metres of a `hold` leg they must stay inside, which is a corner rather than a doorstep. */
export const HOLD_REACH = 14;

/** Metres past the reach a player may drift before the board shuts behind them. */
const BOARD_MARGIN = 2;

/** How far finishing a job moves the standing of the faction that paid for it. */
export const JOB_STANDING = 0.06;

/** How far losing one moves it the other way. It is the smaller of the two: they hired a stranger. */
export const JOB_FAILURE = 0.03;

/** Ticks the line about the job just ended stays on the HUD. */
const SAID_TICKS = 6 * TICK_RATE;

/** The missions of spec section 18, as the record carries them. */
export interface MissionState {
  /** The job being carried, or null while the player is carrying none. */
  active: MissionJob | null;
  /** The contact whose board is open, or null out on the street. */
  visit: GiverVisit | null;
  /** Jobs finished and jobs lost, which the board reads: the offer turns over on both. */
  done: number;
  failed: number;
  /** How far the authored chain has been walked (`chain.ts`), which the save carries. */
  chain: ChainState;
  /** What the end of the last job said, in the words the HUD shows, and when it said it. */
  said: string;
  saidTick: number;
}

/** The contact the player is talking to, as the record carries it. */
export interface GiverVisit {
  /** Index into the world's contacts of the one they are standing at. */
  giver: number;
  /** The tick they opened the board on. */
  started: number;
  /** What the last thing they did said, in the words the panel shows. */
  said: string;
}

/** One row of the board at a contact. */
export interface JobRow {
  label: string;
  /** Do it, and say what happened in the words the panel shows. */
  take: (state: SimState, world: MissionWorld) => string;
}

export function createMissionState(): MissionState {
  return { active: null, visit: null, done: 0, failed: 0, chain: createChainState(), said: '', saidTick: -SAID_TICKS };
}

/** The contact whose board is open, or undefined while the player is out on the street. */
export function visitingGiver(state: SimState, givers: readonly GiverPlace[]): GiverPlace | undefined {
  const visit = state.missions.visit;
  return visit === null ? undefined : givers[visit.giver];
}

/** The leg the active job is on, or undefined while there is no job. */
export function activeLeg(state: SimState): JobLeg | undefined {
  const job = state.missions.active;
  return job === null ? undefined : job.legs[job.leg];
}

/**
 * What a contact is offering: the chapter of the authored chain they are
 * holding, first, and then the one piece of side work their board has. Most
 * contacts in most sessions have only the second; at the fork of the chain, two
 * contacts each hold a chapter at once (`chain.ts`).
 *
 * A contact who will not talk offers nothing, and the panel says why instead
 * (`giver.ts`).
 */
export function jobOffers(state: SimState, world: MissionWorld, giver: GiverPlace): JobOffer[] {
  if (state.missions.active !== null || giverRefusal(state, giver) !== null) return [];
  const offers = chainOffers(state, world, giver);
  const side = offerFor(state, world, giver);
  if (side !== undefined) offers.push({ job: side, label: 'Take it', note: '' });
  return offers;
}

/**
 * The rows of the board at a contact: the jobs on offer, or the way out of the
 * one they already handed over.
 */
export function jobRows(state: SimState, world: MissionWorld, giver: GiverPlace): JobRow[] {
  const job = state.missions.active;
  if (job !== null) {
    if (job.giver !== giver.id) return [];
    return [{ label: 'Give the job up', take: (s) => give(s) }];
  }
  return jobOffers(state, world, giver).map((offer) => ({
    label: `${offer.label} · ${dollars(offer.job.pay)}`,
    take: (s: SimState) => accept(s, offer.job),
  }));
}

/**
 * Advance the missions by one tick, after the deals and before the turf.
 *
 * It is before the turf because a job to take a block is permission to take it
 * (`territory.ts`), and a job taken this tick has to be on the record before
 * the block the player is standing on is read.
 *
 * Nothing here moves the player, so unlike a shop door it has nothing to tell
 * the physics.
 */
export function stepMissions(state: SimState, input: InputFrame, world: MissionWorld): void {
  carry(state);
  board(state, input, world);
  state.objective = objectiveLine(state);
}

/** The board at a contact: opened, read and shut on the interact and number keys. */
function board(state: SimState, input: InputFrame, world: MissionWorld): void {
  const p = state.player;
  const givers = world.givers;
  // A lock, a shop counter, a front door and a dealer's corner all hold the
  // interact key before this does (spec sections 11.4, 16.1, 16.2, 16.3), and a
  // player inside any of them is not talking to anybody on the street.
  if (state.theft !== null || state.shop !== null || state.property.visit !== null || state.market.deal !== null) {
    state.missions.visit = null;
    return;
  }
  const pressed = input.interact && !p.held.interact;
  const visit = state.missions.visit;
  if (visit !== null) {
    const giver = givers[visit.giver];
    if (giver === undefined) {
      state.missions.visit = null;
      return;
    }
    if (pressed) {
      // The press is spent here, so the car at the kerb does not open on it.
      p.held.interact = true;
      state.missions.visit = null;
      return;
    }
    if (p.driving || hypot(giver.x - p.x, giver.y - p.y) > GIVER_REACH + BOARD_MARGIN) {
      state.missions.visit = null;
      return;
    }
    const row = Math.trunc(input.buy);
    if (row >= 1) use(state, world, giver, row - 1);
    return;
  }
  if (!pressed || p.driving) return;
  // The vehicle has the key first (spec section 11.2), as it does at a shop door.
  if (reachesVehicle(p, state.vehicle, specOf(state.vehicle.cls))) return;
  const at = giverAt(givers, state);
  const giver = givers[at];
  if (giver === undefined) return;
  // A contact who will not talk opens no board, except to the player carrying
  // the job they themselves handed over, who has a way out of it.
  if (giverRefusal(state, giver) !== null && state.missions.active?.giver !== giver.id) return;
  p.held.interact = true;
  state.missions.visit = { giver: at, started: state.tick, said: '' };
}

/** Do one row of the board. A row that is not there leaves the record as it was. */
function use(state: SimState, world: MissionWorld, giver: GiverPlace, row: number): void {
  const visit = state.missions.visit;
  const chosen = jobRows(state, world, giver)[row];
  if (visit === null || chosen === undefined) return;
  visit.said = chosen.take(state, world);
}

/** Take a job off the board. It is copied onto the record: the board keeps nothing. */
function accept(state: SimState, offer: MissionJob): string {
  if (state.missions.active !== null) return '';
  offer.taken = state.tick;
  state.missions.active = offer;
  return `${offer.title}. You have ${countdown(offer.limit)}.`;
}

/** Hand a job back. It counts as a job lost, so the board moves on to the next one. */
function give(state: SimState): string {
  const job = state.missions.active;
  if (job === null) return '';
  lose(state, job, 'You handed it back.', true);
  return 'Handed back.';
}

/**
 * One tick of the job being carried: whether it has been lost, whether the leg
 * being worked on is done, and what that leaves.
 */
function carry(state: SimState): void {
  const job = state.missions.active;
  if (job === null) return;
  if (state.respawn !== null && state.respawn.tick >= job.taken) {
    lose(state, job, state.respawn.cause === 'arrest' ? 'They took you in with it.' : 'You did not make it.');
    return;
  }
  if (state.tick - job.taken >= job.limit) {
    lose(state, job, 'Out of time.');
    return;
  }
  const leg = job.legs[job.leg];
  if (leg === undefined) {
    finish(state, job);
    return;
  }
  if (!done(state, job, leg)) return;
  job.leg += 1;
  job.held = 0;
  if (job.leg >= job.legs.length) finish(state, job);
}

/** Whether the leg being worked on is behind the player, and what standing on it costs. */
function done(state: SimState, job: MissionJob, leg: JobLeg): boolean {
  const p = state.player;
  const at = p.driving ? { x: state.vehicle.x, y: state.vehicle.z } : { x: p.x, y: p.y };
  const away = hypot(leg.x - at.x, leg.y - at.y);
  switch (leg.kind) {
    case 'go':
      return away <= LEG_REACH;
    case 'drive':
      return away <= LEG_REACH && p.driving && (job.cls === '' || state.vehicle.cls === job.cls);
    case 'hold':
      return stand(state, job, leg, away);
    case 'take':
      return captured(state.factions, job.block);
  }
}

/**
 * A tick of standing your ground. The first tick of it is what calls the people
 * the player was hired against, because a corner nobody is coming for is not
 * work; walking out of the circle puts the standing back to zero, so the job is
 * lost to the clock rather than to one step too many.
 */
function stand(state: SimState, job: MissionJob, leg: JobLeg, away: number): boolean {
  const p = state.player;
  if (away > HOLD_REACH || p.driving || p.health <= 0) {
    job.held = 0;
    return false;
  }
  if (job.held === 0 && job.against >= 0) callWave(state, job.against, blockKeyAt(leg.x, leg.y), 1);
  job.held += 1;
  return job.held >= leg.ticks;
}

/**
 * A job finished: it pays, it is worth a name with the faction, and it is gone.
 * A chapter of the chain carries the record a step further as well, and says so
 * in its own words rather than in the words a job of the street gets.
 */
function finish(state: SimState, job: MissionJob): void {
  state.money += job.pay;
  shiftStanding(state, job.faction, JOB_STANDING);
  // A stash somebody burned is a stash somebody comes looking for.
  if (job.kind === 'sabotage' && job.against >= 0) {
    const leg = job.legs[job.legs.length - 1] as JobLeg;
    callWave(state, job.against, blockKeyAt(leg.x, leg.y), 1);
  }
  state.missions.done += 1;
  state.missions.active = null;
  const written = job.chapter === '' ? '' : chainFinished(state, job);
  say(state, `Paid ${dollars(job.pay)}. ${written === '' ? `${job.title}.` : written}`);
}

/**
 * A job lost: no money, a little of the standing it would have earned, and it
 * is gone. `gaveUp` is the one loss the player chose, which the chain does not
 * hold against them: a chapter handed back is a chapter still on offer.
 */
function lose(state: SimState, job: MissionJob, why: string, gaveUp = false): void {
  shiftStanding(state, job.faction, -JOB_FAILURE);
  state.missions.failed += 1;
  state.missions.active = null;
  const written = job.chapter === '' ? '' : chainLost(state, job, gaveUp);
  say(state, `${why} ${written === '' ? `${job.title} is off.` : written}`);
}

function say(state: SimState, line: string): void {
  state.missions.said = line;
  state.missions.saidTick = state.tick;
}

/**
 * The line the HUD shows (spec section 12): what is being carried and how long
 * is left of it, or what the end of the last job left, for a few seconds.
 */
export function objectiveLine(state: SimState): string {
  const job = state.missions.active;
  const leg = activeLeg(state);
  if (job !== null && leg !== undefined) {
    const left = Math.max(0, job.limit - (state.tick - job.taken));
    const standing = leg.kind === 'hold' ? ` · ${Math.ceil((leg.ticks - job.held) / TICK_RATE)}s to go` : '';
    return `${leg.label} · ${countdown(left)}${standing}`;
  }
  if (state.tick - state.missions.saidTick < SAID_TICKS) return state.missions.said;
  return '';
}

/** `4:05` from a number of ticks, counted in the seconds a player watches. */
export function countdown(ticks: number): string {
  const seconds = Math.max(0, Math.ceil(ticks / TICK_RATE));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
