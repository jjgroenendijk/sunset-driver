/**
 * The bank that fires the one-shots of `cue.ts` (spec section 15).
 *
 * A cue is a sound that is struck and then gone, and the expensive way to make
 * one is to build a node graph for it and throw it away. So the bank builds
 * {@link VOICE_CAP} of them once and lends them out: a cue takes a voice that
 * is free, sets its envelope, and gives it back when the sound has died.
 *
 * A cue that finds no free voice is dropped rather than stealing one. That is
 * the CPU budget of spec section 15 doing its job: the loudest moment of a
 * firefight is exactly when the mixer must not start allocating, and a shot
 * that goes unheard under twelve others costs nobody anything.
 */
import { Filter, Gain, Noise, now, Oscillator, Panner } from 'tone';
import { CUES, type Cue } from './cue.ts';
import { hear, type Listener } from './space.ts';

/** One-shot voices the bank holds. Nothing beyond these is ever built. */
const VOICE_CAP = 12;

/** The floor an envelope ramps from and to: an exponential ramp may not touch zero. */
const FLOOR = 0.0008;

/** Seconds of quiet left after a cue's envelope, so a voice is free only once it is silent. */
const TAIL = 0.02;

/** One lent-out voice: a falling tone, a band of noise, and one envelope over both. */
class Shot {
  private readonly tone = new Oscillator({ type: 'sawtooth', frequency: 200 });
  private readonly toneGain = new Gain(0);
  private readonly noise = new Noise({ type: 'white' });
  private readonly noiseGain = new Gain(0);
  private readonly filter = new Filter({ type: 'lowpass', frequency: 2000, Q: 1 });
  private readonly out = new Gain(FLOOR);
  private readonly panner = new Panner(0);
  /** The context time this voice is free again at. */
  busyUntil = 0;

  constructor(bus: Gain) {
    this.tone.chain(this.toneGain, this.out);
    this.noise.chain(this.noiseGain, this.filter, this.out);
    this.out.connect(this.panner);
    this.panner.connect(bus);
  }

  /** Strike this voice with a cue. `at` is the context time, `level` what the cue is worth. */
  fire(cue: Cue, level: number, pan: number, at: number): void {
    const voice = CUES[cue.kind];
    const end = at + voice.attack + voice.decay;
    const peak = Math.max(FLOOR, voice.gain * level);
    this.out.gain.cancelScheduledValues(at);
    this.out.gain.setValueAtTime(FLOOR, at);
    this.out.gain.linearRampToValueAtTime(peak, at + voice.attack);
    this.out.gain.exponentialRampToValueAtTime(FLOOR, end);
    this.panner.pan.cancelScheduledValues(at);
    this.panner.pan.setValueAtTime(pan, at);

    this.noiseGain.gain.cancelScheduledValues(at);
    this.noiseGain.gain.setValueAtTime(voice.noise, at);
    this.filter.frequency.cancelScheduledValues(at);
    this.filter.frequency.setValueAtTime(voice.cutoff * cue.pitch, at);
    this.filter.frequency.exponentialRampToValueAtTime(Math.max(40, voice.cutoffEnd * cue.pitch), end);
    this.noise.start(at);
    this.noise.stop(end + TAIL);

    const tuned = voice.tone > 0;
    this.toneGain.gain.cancelScheduledValues(at);
    this.toneGain.gain.setValueAtTime(tuned ? 1 : 0, at);
    if (tuned) {
      this.tone.frequency.cancelScheduledValues(at);
      this.tone.frequency.setValueAtTime(voice.tone * cue.pitch, at);
      this.tone.frequency.exponentialRampToValueAtTime(Math.max(20, voice.toneEnd * cue.pitch), end);
      this.tone.start(at);
      this.tone.stop(end + TAIL);
    }
    this.busyUntil = end + TAIL;
  }

  dispose(): void {
    for (const node of [this.tone, this.toneGain, this.noise, this.noiseGain, this.filter, this.out, this.panner]) {
      node.dispose();
    }
  }
}

/** The pool of one-shot voices, and the door the mixer fires cues through. */
export class ShotBank {
  private readonly voices: Shot[];
  /** Cues dropped for want of a free voice, which the console reads back. */
  dropped = 0;

  constructor(bus: Gain, size = VOICE_CAP) {
    this.voices = Array.from({ length: size }, () => new Shot(bus));
  }

  /** Fire each cue of a plan, as far as the free voices reach. */
  play(cues: readonly Cue[], listener: Listener, level: number): void {
    if (cues.length === 0) return;
    const at = now();
    for (const cue of cues) {
      const heard = hear(listener, cue.x, cue.y);
      if (heard.gain <= 0) continue;
      const voice = this.voices.find((shot) => shot.busyUntil <= at);
      if (voice === undefined) {
        this.dropped++;
        continue;
      }
      voice.fire(cue, cue.strength * heard.gain * level, heard.pan, at);
    }
  }

  dispose(): void {
    for (const voice of this.voices) voice.dispose();
    this.voices.length = 0;
  }
}
