/**
 * What hurting people sounds like (spec sections 13.1 and 15): the cries of
 * the people hit, the panic of a crowd, the slap of a round, and a body
 * meeting the ground.
 *
 * This is part of the pure half of `src/audio`. It reads the casualties, the
 * startled crowd and the tracers of the record and answers cues and cries. It
 * makes no sound: `plan.ts` hands what it finds to the mixer.
 *
 * Everything is read off a tick in the record, the way the blows of a melee
 * weapon are: a hit is its `since`, a landing is `since` and the length of the
 * throw, a round is its tracer's tick. So a frame hears what happened on the
 * ticks it stepped over, a frame that stepped none hears nothing twice, and a
 * replay hears the same.
 */
import { hashInts } from '../core/hash.ts';
import { rngFor, Subsystem } from '../core/rng.ts';
import { TICK_RATE } from '../sim/clock.ts';
import { casualtyPose, emptyCasualtyPose, FALL_TICKS, throwOf, type Casualty } from '../sim/crowd/casualty-motion.ts';
import type { SimState } from '../sim/simulation.ts';
import { REACTIONS, type StartledPedestrian } from '../sim/crowd/pedestrians.ts';
import { TRACER_CAP } from '../sim/weapons/tracer.ts';
import { cueAt, type Cue } from './cue.ts';
import { cryOf, type Cry } from './cry.ts';
import { hear, type Listener } from './space.ts';

/** Cries one frame may start. The bank in `cries.ts` holds a few more, for the tails. */
export const CRIES_PER_FRAME = 4;

/** Voices a fleeing crowd cries in at once, and how many must flee on one tick to start it. */
export const PANIC_VOICES = 3;
const PANIC_MIN = 3;

/** Metres from the listener within which a fleeing crowd is heard to cry. */
const PANIC_REACH = 45;

/** Seconds after a hit before the wounded start to moan: the scream has to finish first. */
const MOAN_AFTER = 2.5;

/** The chance per tick that one of the wounded on the ground moans: about one every five seconds. */
const MOAN_RATE = 1 / (5 * TICK_RATE);

/** How loud a body landing from standing is, against a throw. */
export const FALL_STRENGTH = 0.35;

/** The keys of the streams the panic and the moans are drawn from. */
const PANIC_STREAM = 0x0d01;
const MOAN_STREAM = 0x0d02;
const LANDING_STREAM = 0x0d03;
const ROUND_STREAM = 0x0d04;
const DODGE_STREAM = 0x0d05;

/**
 * The tick a body hits the ground, and how hard, or null where it never
 * leaves its feet. A thrown body lands when its throw ends — the first tick
 * `casualtyPose` no longer calls it `air` — and a body knocked over lands at
 * the end of its fall, more softly.
 */
export function landingOf(record: Casualty): { tick: number; strength: number } | null {
  if (record.lift > 0) {
    const air = throwOf(record).air;
    return { tick: record.since + Math.ceil(air * TICK_RATE), strength: Math.min(1, 0.45 + record.lift / 10) };
  }
  if (record.down === 0) return null;
  return { tick: record.since + FALL_TICKS, strength: FALL_STRENGTH };
}

/**
 * The cry a hit draws, by what it left of the person: the dying cry out once
 * and stop, the knocked down scream, and a blow they stay on their feet
 * through is a short cry of pain.
 */
export function hitCry(record: Casualty): 'death' | 'scream' | 'pain' {
  if (record.health <= 0) return 'death';
  return record.down === 0 ? 'pain' : 'scream';
}

/**
 * The ears on the casualties. The one thing kept between frames is who was
 * already dead, because a body hit again makes a new record like a living
 * person does, and a body has nothing left to cry out with.
 */
export class HurtEars {
  private dead = new Set<number>();
  private readonly pose = emptyCasualtyPose();

  /** Take up the record as it stands, as `AudioPlanner.resync` does. */
  resync(state: SimState): void {
    this.dead.clear();
    for (const record of state.pedestrians.casualties) if (record.health <= 0) this.dead.add(record.id);
  }

  /**
   * The cues and cries of the ticks after `was` up to the record's own. Cues
   * go into `cues` and cries into `cries`, each in the order it should win a
   * voice in.
   */
  hear(state: SimState, was: number, listener: Listener, cues: Cue[], cries: Cry[]): void {
    this.rounds(state, was, cues);
    this.casualties(state, was, cues, cries);
    this.panic(state, was, listener, cries);
    this.dodges(state, was, listener, cries);
    this.moans(state, was, listener, cries);
    const dead = new Set<number>();
    for (const record of state.pedestrians.casualties) if (record.health <= 0) dead.add(record.id);
    this.dead = dead;
  }

  /** Every round that ended in somebody since the last frame: a wet slap where it went in. */
  private rounds(state: SimState, was: number, cues: Cue[]): void {
    for (let i = 0; i < state.tracers.length; i++) {
      const round = state.tracers[i];
      if (round === undefined || round.end !== 'person' || round.tick <= was || round.tick > state.tick) continue;
      // A flamethrower burns rather than strikes: the cry is the sound of it.
      if (round.flame === true) continue;
      const id = hashInts(ROUND_STREAM, round.tick * TRACER_CAP + i);
      cues.push(cueAt(state.seed, round.tick, 'flesh', round.ex, round.ey, 0.85, id));
    }
  }

  /** The cry of each new hit, and the thud of each body that has come down since the last frame. */
  private casualties(state: SimState, was: number, cues: Cue[], cries: Cry[]): void {
    for (const record of state.pedestrians.casualties) {
      if (record.gone) continue;
      if (record.since > was && record.since <= state.tick && !this.dead.has(record.id)) {
        const at = casualtyPose(record, state.tick, this.pose);
        cries.push(cryOf(state.seed, record.since, hitCry(record), record.id, at.x, at.y, 1));
      }
      const landing = landingOf(record);
      if (landing === null || landing.tick <= was || landing.tick > state.tick) continue;
      const at = casualtyPose(record, landing.tick, this.pose);
      const id = hashInts(LANDING_STREAM, record.id);
      cues.push(cueAt(state.seed, landing.tick, 'landing', at.x, at.y, landing.strength, id));
    }
  }

  /**
   * A crowd running from something near the player. Where enough people take
   * flight on one tick, a few of them cry out, a moment apart and quieter
   * than a scream. Which few, and how far apart, is drawn from the tick and
   * their ids.
   */
  private panic(state: SimState, was: number, listener: Listener, cries: Cry[]): void {
    const fled: StartledPedestrian[] = [];
    for (const person of state.pedestrians.startled) {
      if (person.reaction !== 'flee' || person.since <= was || person.since > state.tick) continue;
      if (hear(listener, person.x, person.y).distance > PANIC_REACH) continue;
      fled.push(person);
    }
    if (fled.length < PANIC_MIN) return;
    // Grouped by the tick they fled on, and inside a tick in an order drawn
    // from the tick and the id, so which of them cry is not always the lowest id.
    const order = (p: StartledPedestrian): number => hashInts(PANIC_STREAM, p.since, p.id) >>> 0;
    fled.sort((a, b) => a.since - b.since || order(a) - order(b) || a.id - b.id);
    let start = 0;
    while (start < fled.length) {
      const tick = (fled[start] as StartledPedestrian).since;
      let end = start;
      while (end < fled.length && (fled[end] as StartledPedestrian).since === tick) end++;
      if (end - start >= PANIC_MIN) {
        const rng = rngFor(state.seed, tick, Subsystem.Audio, PANIC_STREAM);
        const voices = Math.min(PANIC_VOICES, end - start);
        for (let i = 0; i < voices; i++) {
          const person = fled[start + i] as StartledPedestrian;
          const delay = i * 0.18 + rng.range(0.05, 0.3);
          cries.push(cryOf(state.seed, tick, 'panic', person.id, person.x, person.y, rng.range(0.7, 1), delay));
        }
      }
      start = end;
    }
  }

  /**
   * Somebody who jumped clear of a car shouts after it, once they have turned
   * to face it (`startledPose`). Each is heard alone: a dodge is one person
   * and one car, not a crowd.
   */
  private dodges(state: SimState, was: number, listener: Listener, cries: Cry[]): void {
    const after = REACTIONS.dodge.ticks;
    for (const person of state.pedestrians.startled) {
      if (person.reaction !== 'dodge') continue;
      const tick = person.since + after;
      if (tick <= was || tick > state.tick) continue;
      if (hear(listener, person.x, person.y).distance > PANIC_REACH) continue;
      const rng = rngFor(state.seed, tick, Subsystem.Audio, hashInts(DODGE_STREAM, person.id));
      cries.push(cryOf(state.seed, tick, 'shout', person.id, person.x, person.y, rng.range(0.6, 0.9), rng.range(0, 0.2)));
    }
  }

  /**
   * The wounded on the ground moan now and then, until they are up and away.
   * A moan is drawn per tick, over every tick the frame stepped, the way a
   * bird's call is, so how often it comes does not hang on the frame rate.
   */
  private moans(state: SimState, was: number, listener: Listener, cries: Cry[]): void {
    for (const record of state.pedestrians.casualties) {
      if (record.gone || record.health <= 0) continue;
      const at = casualtyPose(record, state.tick, this.pose);
      if (at.phase !== 'lie' && at.phase !== 'crawl' && at.phase !== 'limp' && at.phase !== 'rise') continue;
      if (hear(listener, at.x, at.y).gain <= 0) continue;
      const quiet = record.since + Math.ceil(MOAN_AFTER * TICK_RATE);
      for (let tick = Math.max(was + 1, quiet); tick <= state.tick; tick++) {
        const rng = rngFor(state.seed, tick, Subsystem.Audio, hashInts(MOAN_STREAM, record.id));
        if (!rng.chance(MOAN_RATE)) continue;
        cries.push(cryOf(state.seed, tick, 'moan', record.id, at.x, at.y, rng.range(0.6, 1)));
      }
    }
  }
}
