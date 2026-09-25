/**
 * The band inside the radio, and the score over it (spec section 15).
 *
 * `song.ts` says what the notes are and `plan.ts` when the next bar starts;
 * this is the only file that plays them. One instrument per part, built once
 * with the mixer and kept, because a station change is a change of settings and
 * not a change of graph — a new synth for every song would be a stall in the
 * middle of a drive.
 *
 * A bar is scheduled whole, a little before it is due, at absolute times off
 * the audio context's own clock. The game's clock is what says when that is:
 * `dial.ts` reads the bar off the simulation tick, so the music keeps the same
 * time as the city and a paused session stops mid-bar rather than running on.
 *
 * The score is a different animal: it holds rather than being scheduled, so it
 * is a drone and a pulse whose rate and brightness follow the chase.
 */
import { AmplitudeEnvelope, Filter, Gain, LFO, MembraneSynth, NoiseSynth, Oscillator, PolySynth, Synth } from 'tone';
import type { RadioPlan } from './plan.ts';
import type { Score } from './score.ts';
import { barOf, type Note } from './song.ts';
import { STEPS, type Part } from './stations.ts';
import { RAMP } from './voices.ts';

/** Seconds a bar is scheduled before it is due. Long enough to survive a slow frame. */
const LOOKAHEAD = 0.4;

/** What each part is worth against the others inside the radio. */
const PART_GAIN: Record<Part, number> = { bass: 0.5, chord: 0.22, lead: 0.3, kick: 0.6, snare: 0.35, hat: 0.12 };

/** How much of a bar of an ident or an announcement is played: the bed under the line. */
const BED_VELOCITY = 0.45;

/** The parts that carry on under an ident or an announcement. The tune stops for it. */
const BED_PARTS: readonly Part[] = ['chord', 'hat', 'kick'];

/** The note a score drone sits on, in hertz, and the fifth over it. */
const DRONE_HZ = 55;
const DRONE_FIFTH = 82.5;

/** Hertz of the tritone a fight adds, which is the interval nothing agrees with. */
const DREAD_HZ = 77.8;

/** Pulses a minute the score beats at, from a chase to a fight. */
const PULSE_SLOW = 2.2;
const PULSE_FAST = 7;

/** MIDI note to hertz. */
function hz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/**
 * The radio's band: bass, chords, tune and drums, each on its own voice, mixed
 * inside the radio and handed to the music bus as one.
 */
export class RadioVoice {
  private readonly out = new Gain(0);
  private readonly bass = new Synth({ oscillator: { type: 'square' }, envelope: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.1 } });
  private readonly chord = new PolySynth(Synth, { oscillator: { type: 'sawtooth' }, envelope: { attack: 0.02, decay: 0.3, sustain: 0.4, release: 0.3 } });
  private readonly lead = new Synth({ oscillator: { type: 'triangle' }, envelope: { attack: 0.01, decay: 0.15, sustain: 0.3, release: 0.2 } });
  private readonly kick = new MembraneSynth({ pitchDecay: 0.03, octaves: 5, envelope: { attack: 0.001, decay: 0.24, sustain: 0 } });
  private readonly snare = new NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.16, sustain: 0 } });
  private readonly hat = new NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.03, sustain: 0 } });
  private readonly hatTop = new Filter({ type: 'highpass', frequency: 6000 });
  private readonly snareBody = new Filter({ type: 'bandpass', frequency: 1800, Q: 0.8 });
  private readonly gains: Record<Part, Gain>;
  /** The last bar handed to the instruments, so one is never scheduled twice. */
  private scheduled = -1;
  /** The station the last bar belonged to, so a change of station starts again. */
  private tuned = -1;

  constructor(bus: Gain) {
    this.gains = {
      bass: new Gain(PART_GAIN.bass).connect(this.out),
      chord: new Gain(PART_GAIN.chord).connect(this.out),
      lead: new Gain(PART_GAIN.lead).connect(this.out),
      kick: new Gain(PART_GAIN.kick).connect(this.out),
      snare: new Gain(PART_GAIN.snare).connect(this.out),
      hat: new Gain(PART_GAIN.hat).connect(this.out),
    };
    this.bass.connect(this.gains.bass);
    this.chord.connect(this.gains.chord);
    this.lead.connect(this.gains.lead);
    this.kick.connect(this.gains.kick);
    this.snare.chain(this.snareBody, this.gains.snare);
    this.hat.chain(this.hatTop, this.gains.hat);
    this.out.connect(bus);
  }

  /**
   * Follow the plan: set how loud the radio is, and hand the band the next bar
   * once it is near enough to be worth scheduling.
   */
  set(plan: RadioPlan, level: number, at: number): void {
    this.out.gain.rampTo(plan.station === null ? 0 : plan.gain * level, RAMP);
    const next = plan.next;
    if (plan.station === null || next === null) {
      this.tuned = -1;
      return;
    }
    // A change of station drops whatever was about to go out: the new station is
    // in the middle of its own bar and nothing of the old one belongs over it.
    if (plan.dial !== this.tuned) {
      this.tuned = plan.dial;
      this.scheduled = -1;
      this.bass.triggerRelease(at);
      this.chord.releaseAll(at);
      this.lead.triggerRelease(at);
    }
    if (next.seconds > LOOKAHEAD || next.bar === this.scheduled) return;
    this.scheduled = next.bar;
    const seconds = (60 / plan.station.tempo) / (STEPS / 4);
    const start = at + Math.max(0, next.seconds);
    const bed = next.kind !== 'song';
    for (const note of barOf(plan.seed, plan.station, next.song, next.bar)) {
      if (bed && !BED_PARTS.includes(note.part)) continue;
      this.play(note, start + note.step * seconds, note.length * seconds, bed ? BED_VELOCITY : 1);
    }
  }

  /** Let every held note go, leaving the graph standing. */
  silence(): void {
    this.out.gain.rampTo(0, RAMP);
    this.scheduled = -1;
  }

  dispose(): void {
    for (const node of [this.bass, this.chord, this.lead, this.kick, this.snare, this.hat]) node.dispose();
    for (const node of [this.hatTop, this.snareBody, this.out]) node.dispose();
    for (const part of ['bass', 'chord', 'lead', 'kick', 'snare', 'hat'] as const) this.gains[part].dispose();
  }

  /** One note on the instrument its part is played on. */
  private play(note: Note, at: number, length: number, scale: number): void {
    const velocity = Math.max(0.05, Math.min(1, note.velocity * scale));
    switch (note.part) {
      case 'bass':
        this.bass.triggerAttackRelease(hz(note.note), length, at, velocity);
        return;
      case 'chord':
        this.chord.triggerAttackRelease(hz(note.note), length, at, velocity);
        return;
      case 'lead':
        this.lead.triggerAttackRelease(hz(note.note), length, at, velocity);
        return;
      case 'kick':
        this.kick.triggerAttackRelease(hz(note.note - 24), length, at, velocity);
        return;
      case 'snare':
        this.snare.triggerAttackRelease(length, at, velocity);
        return;
      case 'hat':
        this.hat.triggerAttackRelease(length, at, velocity);
        return;
    }
  }
}

/**
 * The score over the radio: a drone that beats. The chase sets how fast it
 * beats and how bright it is, and a fight adds the interval that does not
 * agree with it.
 */
export class ScoreVoice {
  private readonly low = new Oscillator({ type: 'sawtooth', frequency: DRONE_HZ });
  private readonly fifth = new Oscillator({ type: 'sawtooth', frequency: DRONE_FIFTH, detune: 5 });
  private readonly dread = new Oscillator({ type: 'square', frequency: DREAD_HZ });
  private readonly dreadGain = new Gain(0);
  private readonly colour = new Filter({ type: 'lowpass', frequency: 300, Q: 2 });
  private readonly pulse = new AmplitudeEnvelope({ attack: 0.02, decay: 0.2, sustain: 0.35, release: 0.2 });
  private readonly beat = new LFO({ frequency: PULSE_SLOW, min: 0.25, max: 1, type: 'triangle' });
  private readonly out = new Gain(0);

  constructor(bus: Gain) {
    this.low.connect(this.colour);
    this.fifth.connect(this.colour);
    this.dread.chain(this.dreadGain, this.colour);
    this.colour.chain(this.pulse, this.out);
    this.out.connect(bus);
    this.beat.connect(this.out.gain);
  }

  start(): void {
    this.low.start();
    this.fifth.start();
    this.dread.start();
    this.beat.start();
    this.pulse.triggerAttack();
  }

  /** Follow the score: how hard it leans, and whether it is a chase or a fight. */
  set(score: Score, level: number): void {
    if (score.mood === 'calm') {
      this.silence();
      return;
    }
    const heavy = score.mood === 'combat';
    this.beat.frequency.rampTo(PULSE_SLOW + (PULSE_FAST - PULSE_SLOW) * score.intensity, RAMP);
    this.colour.frequency.rampTo(220 + 900 * score.intensity, RAMP);
    this.dreadGain.gain.rampTo(heavy ? 0.35 * score.intensity : 0, RAMP);
    // The LFO writes the gain, so the level is set on its own range rather than
    // on the parameter it is moving.
    this.beat.min = level * score.intensity * 0.25;
    this.beat.max = level * score.intensity;
  }

  silence(): void {
    this.beat.min = 0;
    this.beat.max = 0;
    this.out.gain.rampTo(0, RAMP);
  }

  dispose(): void {
    for (const node of [this.low, this.fifth, this.dread]) node.stop().dispose();
    this.beat.stop().dispose();
    for (const node of [this.dreadGain, this.colour, this.pulse, this.out]) node.dispose();
  }
}
