/**
 * The Tone.js mixer of spec section 15: the buses everything is played into,
 * the ducking bus the bed rides, and the limiter that keeps the whole of it
 * inside the speakers.
 *
 * This is the only file that decides what the mix is plugged into. A voice
 * (`tone-loops.ts`, `tone-shots.ts`) is given a bus and knows nothing else
 * about the graph, so the radio of spec section 15 and the ambient beds can be
 * added later by playing into {@link ToneMixer.music} without touching them.
 *
 * Tone.js is imported for its types alone here; the module itself is handed in,
 * because it is loaded on the player's first gesture and not before (`audio.ts`).
 */
import type * as Tone from 'tone';

/** The Tone.js module, as `audio.ts` imports it. */
export type ToneModule = typeof import('tone');

/**
 * How much of the bed is left at a full duck (spec section 15). Not silence: a
 * radio that cut out at every gunshot would sound broken rather than ducked.
 */
export const DUCK_FLOOR = 0.25;

/** Seconds the bed takes to stand down, and the longer time it takes to come back. */
export const DUCK_ATTACK = 0.06;
export const DUCK_RELEASE = 0.5;

/** Decibels the sustained mix is held under, which is what the limiter is for. */
const LIMIT_DB = -6;

/**
 * The soft clip on the end of the mix. Tone's limiter is a compressor and takes
 * 3 ms to close, so a gunshot, a crash and an explosion on the same frame go
 * straight through it: `node scripts/audio-check.ts` measured peaks well over
 * 1, which a browser clips into a crackle.
 *
 * So the mix ends in a curve rather than a wall. The signal is halved into a
 * shaper of `tanh`, which is a straight line for anything quiet and bends over
 * as it grows, and doubled again after it: quiet passes through untouched, and
 * nothing can leave over {@link CEILING}.
 */
const DRIVE = 0.5;
const CEILING = 0.96;

/** Seconds a change of the master volume is ramped over, so a setting never clicks. */
const VOLUME_RAMP = 0.08;

/**
 * Where the buses sit against each other. The engine is the sound a driver
 * hears most of a session, so it is held under the effects: a gunshot or a
 * crash must cut through the car the player is sitting in.
 */
const BUS_GAIN = { effects: 0.9, engine: 0.55, music: 0.7 };

export class ToneMixer {
  readonly tone: ToneModule;
  /** Everything ends here, and the master volume is this gain. */
  private readonly master: Tone.Gain;
  private readonly limiter: Tone.Limiter;
  private readonly drive: Tone.Gain;
  private readonly shaper: Tone.WaveShaper;
  private readonly makeUp: Tone.Gain;
  /** The one-shots and the placed loops of `tone-shots.ts` and `tone-loops.ts`. */
  readonly effects: Tone.Gain;
  /** The player's own engine, held under the effects. */
  readonly engine: Tone.Gain;
  /** The radio and the ambient beds of spec section 15, which ride the duck. */
  readonly music: Tone.Gain;
  private readonly ducked: Tone.Gain;
  private standing = 1;

  constructor(tone: ToneModule, volume: number) {
    this.tone = tone;
    // A limiter and not a compressor: the mix is synthesised, so its peaks are
    // known only when they happen, and a browser that clips sounds broken. It
    // sits well under the ceiling, because Tone's limiter takes 3 ms to close
    // and a firefight is all transients: at -1 dB the overshoot clipped, and
    // `node scripts/audio-check.ts` measures that.
    this.makeUp = new tone.Gain(1 / DRIVE).toDestination();
    this.shaper = new tone.WaveShaper((x: number) => Math.tanh(x / DRIVE) * DRIVE, 4096).connect(this.makeUp);
    this.drive = new tone.Gain(DRIVE).connect(this.shaper);
    this.limiter = new tone.Limiter(LIMIT_DB).connect(this.drive);
    this.master = new tone.Gain(volume).connect(this.limiter);
    this.effects = new tone.Gain(BUS_GAIN.effects).connect(this.master);
    this.engine = new tone.Gain(BUS_GAIN.engine).connect(this.master);
    this.ducked = new tone.Gain(1).connect(this.master);
    this.music = new tone.Gain(BUS_GAIN.music).connect(this.ducked);
  }

  /** The master volume, 0 to 1. */
  set volume(value: number) {
    this.master.gain.rampTo(Math.max(0, Math.min(1, value)), VOLUME_RAMP);
  }

  /**
   * Take the bed down by `amount`, 0 to 1 (spec section 15). It falls quickly
   * and comes back slowly, which is what a ducking bus does everywhere: the
   * ear forgives a slow return and notices a late duck.
   */
  duck(amount: number): void {
    const target = 1 - (1 - DUCK_FLOOR) * Math.max(0, Math.min(1, amount));
    if (Math.abs(target - this.standing) < 0.01) return;
    this.ducked.gain.rampTo(target, target < this.standing ? DUCK_ATTACK : DUCK_RELEASE);
    this.standing = target;
  }

  dispose(): void {
    this.music.dispose();
    this.ducked.dispose();
    this.engine.dispose();
    this.effects.dispose();
    this.master.dispose();
    this.limiter.dispose();
    this.drive.dispose();
    this.shaper.dispose();
    this.makeUp.dispose();
  }
}
