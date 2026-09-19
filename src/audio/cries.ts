/**
 * The bank that voices the cries of `cry.ts` (spec section 15).
 *
 * A cry is a small formant synthesiser. A sawtooth at the pitch of the voice
 * goes through three band-pass filters in parallel, one per formant of the
 * vowel, and a band of pink noise is laid over it as breath. A low-pass after
 * both takes the treble off with the distance. One envelope on the output
 * shapes the whole cry.
 *
 * The bank works as `one-shots.ts` does: {@link CRY_VOICES} voices are built
 * once and lent out, and a cry that finds no free voice is dropped. A voice is
 * free only after its tail, because Tone.js refuses to start a source before a
 * stop it has already scheduled.
 */
import { Filter, Gain, Noise, now, Oscillator, Panner } from 'tone';
import {
  CRIES,
  cryCurve,
  cryLength,
  FORMANT_GAIN,
  FORMANT_WIDTH,
  formantsOf,
  muffleOf,
  type Cry,
} from './cry.ts';
import { hear, type Listener } from './space.ts';

/** Cry voices the bank holds: a scream, a crowd of three, and room for their tails. */
export const CRY_VOICES = 6;

/**
 * What the envelope's peak is lifted by. Narrow bands take most of a
 * sawtooth away, so a cry needs this to stand level with a thud. The number is
 * read off `node scripts/audio-check.ts`, not reasoned about.
 */
const MAKEUP = 3.2;

/** The floor an envelope ramps from and to: an exponential ramp may not touch zero. */
const FLOOR = 0.0008;

/** Seconds of quiet left after a cry, so a voice is free only once it is silent. */
const TAIL = 0.03;

/** Where the breath sits, as a factor of the second formant, and how wide it is. */
const BREATH_AT = 1.5;
const BREATH_Q = 0.7;

/** One lent-out voice: a source, three formants, a breath, and one envelope. */
class CryVoiceNode {
  private readonly source = new Oscillator({ type: 'sawtooth', frequency: 220 });
  private readonly formants = FORMANT_GAIN.map(() => new Filter({ type: 'bandpass', frequency: 800, Q: 8 }));
  private readonly formantGains = FORMANT_GAIN.map((gain) => new Gain(gain));
  private readonly breath = new Noise({ type: 'pink' });
  private readonly breathFilter = new Filter({ type: 'bandpass', frequency: 1800, Q: BREATH_Q });
  private readonly breathGain = new Gain(0);
  private readonly air = new Filter({ type: 'lowpass', frequency: 9000, Q: 0.5 });
  private readonly out = new Gain(FLOOR);
  private readonly panner = new Panner(0);
  /** The context time this voice is free again at. */
  busyUntil = 0;

  constructor(bus: Gain) {
    for (let i = 0; i < this.formants.length; i++) {
      const formant = this.formants[i] as Filter;
      this.source.connect(formant);
      formant.chain(this.formantGains[i] as Gain, this.air);
    }
    this.breath.chain(this.breathFilter, this.breathGain, this.air);
    this.air.chain(this.out, this.panner);
    this.panner.connect(bus);
  }

  /** Start a cry `delay` seconds after `at`. `level` is what it is worth, `muffle` the low-pass. */
  fire(cry: Cry, level: number, pan: number, muffle: number, at: number): void {
    const shape = CRIES[cry.kind];
    const start = at + Math.max(0, cry.delay);
    const length = cryLength(cry);
    const end = start + length;
    const peak = Math.max(FLOOR * 2, shape.gain * level * MAKEUP);
    const release = Math.min(shape.release, length * 0.6);

    // Up fast, held with a little sag as the breath runs out, then let go —
    // or, for the dying, cut off in a few milliseconds.
    const gain = this.out.gain;
    gain.cancelScheduledValues(at);
    gain.setValueAtTime(FLOOR, start);
    gain.linearRampToValueAtTime(peak, start + shape.attack);
    gain.linearRampToValueAtTime(peak * 0.8, end - release);
    if (shape.cut) gain.linearRampToValueAtTime(FLOOR, end);
    else gain.exponentialRampToValueAtTime(FLOOR, end);
    this.panner.pan.cancelScheduledValues(at);
    this.panner.pan.setValueAtTime(pan, start);
    this.air.frequency.cancelScheduledValues(at);
    this.air.frequency.setValueAtTime(muffle, start);

    const frequency = this.source.frequency;
    frequency.cancelScheduledValues(at);
    frequency.setValueCurveAtTime(cryCurve(cry), start, length);

    // The vowel opens on one shape of the mouth and closes on another.
    const from = formantsOf(shape.from, cry.voice);
    const to = formantsOf(shape.to, cry.voice);
    for (let i = 0; i < this.formants.length; i++) {
      const formant = this.formants[i] as Filter;
      const a = from[i] as number;
      const b = to[i] as number;
      const width = FORMANT_WIDTH[i] as number;
      formant.frequency.cancelScheduledValues(at);
      formant.frequency.setValueAtTime(a, start);
      formant.frequency.linearRampToValueAtTime(b, end);
      formant.Q.cancelScheduledValues(at);
      formant.Q.setValueAtTime(a / width, start);
      formant.Q.linearRampToValueAtTime(b / width, end);
    }
    // The breath rises towards the end, as the air runs out.
    const breath = cry.voice.breath * shape.breath;
    this.breathFilter.frequency.cancelScheduledValues(at);
    this.breathFilter.frequency.setValueAtTime(from[1] * BREATH_AT, start);
    this.breathGain.gain.cancelScheduledValues(at);
    this.breathGain.gain.setValueAtTime(breath * 0.6, start);
    this.breathGain.gain.linearRampToValueAtTime(breath, end);

    this.source.start(start);
    this.source.stop(end + TAIL);
    this.breath.start(start);
    this.breath.stop(end + TAIL);
    this.busyUntil = end + TAIL;
  }

  dispose(): void {
    const nodes = [this.source, ...this.formants, ...this.formantGains, this.breath, this.breathFilter, this.breathGain];
    for (const node of [...nodes, this.air, this.out, this.panner]) node.dispose();
  }
}

/** The pool of cry voices, and the door the mixer starts cries through. */
export class CryBank {
  private readonly voices: CryVoiceNode[];
  /** Cries dropped for want of a free voice. */
  dropped = 0;

  constructor(bus: Gain, size = CRY_VOICES) {
    this.voices = Array.from({ length: size }, () => new CryVoiceNode(bus));
  }

  /** Start each cry of a plan, as far as the free voices reach. */
  play(cries: readonly Cry[], listener: Listener, level: number): void {
    if (cries.length === 0) return;
    const at = now();
    for (const cry of cries) {
      const heard = hear(listener, cry.x, cry.y);
      if (heard.gain <= 0) continue;
      const voice = this.voices.find((node) => node.busyUntil <= at);
      if (voice === undefined) {
        this.dropped++;
        continue;
      }
      const muffle = muffleOf(heard.distance, CRIES[cry.kind].clear);
      voice.fire(cry, cry.strength * heard.gain * level, heard.pan, muffle, at);
    }
  }

  dispose(): void {
    for (const voice of this.voices) voice.dispose();
    this.voices.length = 0;
  }
}
