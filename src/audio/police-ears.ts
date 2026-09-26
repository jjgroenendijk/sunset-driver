/**
 * What the police on foot sound like (spec sections 14, 15): the crack of each
 * round an officer fires, their shouts in the street, and the calls over their
 * radio when the player is picked up or lost.
 *
 * This is the pure half. It reads the tracers and the barks the record keeps
 * (`src/sim/police/officer.ts`) and answers cues and cries; `one-shots.ts` and
 * `cries.ts` play them as they play every other. The player's own shots are
 * counted off the loadout in `plan.ts`, so only a tracer marked `police` is
 * heard here, and only its first pellet: a shotgun blast is one bang.
 */
import { hashInts } from '../core/hash.ts';
import type { BarkKind } from '../sim/police/officer.ts';
import type { SimState } from '../sim/simulation.ts';
import { TRACER_CAP } from '../sim/weapons/tracer.ts';
import { cueAt, type Cue } from './cue.ts';
import { cryOf, type Cry, type CryKind } from './cry.ts';

/** How loud a police gun is, against the player's own at full weight. */
const POLICE_SHOT = 0.85;

/** How loud the radio's squelch is. */
const SQUELCH = 0.8;

/** Which voice each bark is said in: a shout in the street, or a call over the radio. */
const BARK_VOICE: Readonly<Record<BarkKind, CryKind>> = Object.freeze({
  spotted: 'radio',
  lost: 'radio',
  fire: 'shout',
  freeze: 'shout',
  cuff: 'shout',
  down: 'shout',
});

/** The keys of the streams the shots and the voices are drawn from. */
const SHOT_STREAM = 0x0e01;
const VOICE_STREAM = 0x0e02;
const SQUELCH_STREAM = 0x0e03;

/** The officers a squad sounds like: a few voices, so the same shout is not always the same man. */
const VOICES = 4;

/**
 * The cues and cries of the police in the ticks after `was` up to the record's
 * own. Gunshots go first, so a frame at the cap keeps them over a shout.
 */
export function hearPolice(state: SimState, was: number, cues: Cue[], cries: Cry[]): void {
  for (let i = 0; i < state.tracers.length; i++) {
    const round = state.tracers[i];
    if (round === undefined || round.by !== 'police' || round.pellet !== 0) continue;
    if (round.tick <= was || round.tick > state.tick) continue;
    const id = hashInts(SHOT_STREAM, round.tick * TRACER_CAP + i);
    cues.push(cueAt(state.seed, round.tick, 'gunshot', round.x, round.y, POLICE_SHOT, id));
  }
  for (const bark of state.police.barks) {
    if (bark.tick <= was || bark.tick > state.tick) continue;
    const voice = BARK_VOICE[bark.kind];
    if (voice === 'radio') {
      cues.push(cueAt(state.seed, bark.tick, 'squelch', bark.x, bark.y, SQUELCH, hashInts(SQUELCH_STREAM, bark.tick)));
    }
    const who = hashInts(VOICE_STREAM, bark.tick % VOICES);
    cries.push(cryOf(state.seed, bark.tick, voice, who, bark.x, bark.y, 1));
  }
}
