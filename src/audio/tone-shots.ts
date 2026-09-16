/**
 * The sounds that ring out on their own (spec section 15), synthesised: a
 * gunshot, a swing, a collision, an explosion, a footfall, a landing and a
 * tram bell.
 *
 * Each kind owns a small ring of voices, built once and triggered again and
 * again. Nothing is built while the game is running: allocating an oscillator
 * on the frame a gun fires is how a browser drops the whole mix, and a
 * firefight fires many rounds a second.
 *
 * A voice is noise through a filter, with a drum under it where the sound has a
 * body: a gunshot is a crack over a thump, a crash is a tear over a much deeper
 * one, and an explosion is both, longer. `tone-loops.ts` is the other half.
 */
import type * as Tone from 'tone';
import type { FiredShot } from './director.ts';
import type { SoundKind } from './mix.ts';
import type { ToneModule } from './tone-mixer.ts';

/** Seconds between two triggers of one voice, so a retrigger never lands on itself. */
const RETRIGGER = 0.02;

/** How much the seeded variant moves the filter of a shot, either way. */
const VARIANCE = 0.3;

/** What one kind of one-shot is made of. */
interface ShotSpec {
  noise: 'white' | 'pink' | 'brown';
  /** Seconds the noise takes to die away. */
  decay: number;
  /** The filter the noise is heard through. */
  hz: number;
  type: 'lowpass' | 'bandpass';
  q: number;
  /** The kind's own level, before the distance and the strength. */
  gain: number;
  /** The drum under it, where the sound has a body. */
  body?: { hz: number; decay: number; pitchDecay: number; gain: number };
  /** Voices the kind keeps, which is how many of it can ring at once. */
  ring: number;
}

/**
 * Every one-shot of spec section 15. The bell is the one built from metal
 * rather than noise. Each `gain` is what `node scripts/audio-check.ts`
 * measured the kind at against the engine and each other: a band of noise
 * comes out well under an oscillator at the same gain, so these are read off
 * the meter rather than reasoned about.
 */
const SHOTS: Record<string, ShotSpec> = {
  gunshot: { noise: 'white', decay: 0.13, hz: 1900, type: 'lowpass', q: 1, gain: 4.5, ring: 3, body: { hz: 70, decay: 0.14, pitchDecay: 0.02, gain: 0.55 } },
  melee: { noise: 'white', decay: 0.06, hz: 900, type: 'bandpass', q: 2, gain: 3, ring: 2 },
  impact: { noise: 'brown', decay: 0.26, hz: 1300, type: 'lowpass', q: 1, gain: 4, ring: 2, body: { hz: 55, decay: 0.4, pitchDecay: 0.05, gain: 0.7 } },
  explosion: { noise: 'brown', decay: 1.4, hz: 760, type: 'lowpass', q: 1, gain: 2.6, ring: 2, body: { hz: 38, decay: 1.1, pitchDecay: 0.3, gain: 0.55 } },
  footstep: { noise: 'pink', decay: 0.06, hz: 900, type: 'bandpass', q: 1, gain: 6, ring: 2, body: { hz: 90, decay: 0.09, pitchDecay: 0.01, gain: 0.4 } },
  landing: { noise: 'brown', decay: 0.12, hz: 520, type: 'lowpass', q: 1, gain: 3.5, ring: 2, body: { hz: 60, decay: 0.2, pitchDecay: 0.03, gain: 0.5 } },
};

/** Voices the bell keeps. It rings long, so two trams may ring at once. */
const BELL_RING = 2;

/** One voice of one kind: noise through its filter, with its drum under it. */
class ShotVoice {
  private readonly spec: ShotSpec;
  private readonly noise: Tone.NoiseSynth;
  private readonly filter: Tone.Filter;
  private readonly noiseGain: Tone.Gain;
  private readonly panner: Tone.Panner;
  private readonly out: Tone.Gain;
  private readonly body: Tone.MembraneSynth | null;
  private readonly bodyGain: Tone.Gain | null;
  private at = 0;

  constructor(tone: ToneModule, bus: Tone.InputNode, spec: ShotSpec) {
    this.spec = spec;
    this.panner = new tone.Panner(0).connect(bus);
    this.out = new tone.Gain(0).connect(this.panner);
    // The kind's own level sits on the noise and the drum, not on the voice's
    // gain: what the mix hands over is between 0 and 1, and a level of its own
    // on top of that is how a loud kind came to clip.
    this.noiseGain = new tone.Gain(spec.gain).connect(this.out);
    this.filter = new tone.Filter({ frequency: spec.hz, type: spec.type, Q: spec.q }).connect(this.noiseGain);
    this.noise = new tone.NoiseSynth({
      noise: { type: spec.noise },
      envelope: { attack: 0.001, decay: spec.decay, sustain: 0, release: 0.02 },
    }).connect(this.filter);
    if (spec.body === undefined) {
      this.body = null;
      this.bodyGain = null;
    } else {
      this.bodyGain = new tone.Gain(spec.body.gain).connect(this.out);
      this.body = new tone.MembraneSynth({
        pitchDecay: spec.body.pitchDecay,
        octaves: 4,
        envelope: { attack: 0.001, decay: spec.body.decay, sustain: 0, release: 0.02 },
      }).connect(this.bodyGain);
    }
  }

  /** The soonest this voice may be triggered again, so two shots never collide on it. */
  get free(): number {
    return this.at;
  }

  play(shot: FiredShot, now: number): void {
    const at = Math.max(now, this.at + RETRIGGER);
    this.at = at;
    const strength = Math.max(0.05, Math.min(1, shot.strength));
    this.panner.pan.setValueAtTime(shot.pan, at);
    this.out.gain.setValueAtTime(shot.gain, at);
    // The seeded variant moves the filter rather than the pitch, so two shots
    // of one gun are the same gun heard twice and not two different guns.
    this.filter.frequency.setValueAtTime(this.spec.hz * (1 + VARIANCE * (shot.variant * 2 - 1)), at);
    this.noise.triggerAttackRelease(this.spec.decay, at, strength);
    const body = this.spec.body;
    if (this.body !== null && body !== undefined) {
      this.body.triggerAttackRelease(body.hz * (0.85 + 0.3 * strength), body.decay, at, strength);
    }
  }

  dispose(): void {
    this.noise.dispose();
    this.body?.dispose();
    this.bodyGain?.dispose();
    this.noiseGain.dispose();
    this.filter.dispose();
    this.out.dispose();
    this.panner.dispose();
  }
}

/** The tram bell of spec section 13.2: struck metal, which noise cannot make. */
class BellVoice {
  private readonly metal: Tone.MetalSynth;
  private readonly panner: Tone.Panner;
  private readonly out: Tone.Gain;
  private at = 0;

  constructor(tone: ToneModule, bus: Tone.InputNode) {
    this.panner = new tone.Panner(0).connect(bus);
    this.out = new tone.Gain(0).connect(this.panner);
    this.metal = new tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.9, release: 0.1 },
      harmonicity: 3.1,
      modulationIndex: 18,
      resonance: 3600,
      octaves: 1.2,
    }).connect(this.out);
  }

  get free(): number {
    return this.at;
  }

  play(shot: FiredShot, now: number): void {
    const at = Math.max(now, this.at + RETRIGGER);
    this.at = at;
    this.panner.pan.setValueAtTime(shot.pan, at);
    this.out.gain.setValueAtTime(shot.gain * 0.9, at);
    this.metal.triggerAttackRelease(660, 0.4, at, Math.max(0.2, Math.min(1, shot.strength)));
  }

  dispose(): void {
    this.metal.dispose();
    this.out.dispose();
    this.panner.dispose();
  }
}

interface Ring {
  voices: { free: number; play(shot: FiredShot, now: number): void; dispose(): void }[];
  next: number;
}

/**
 * Every one-shot voice of a session. `fire` takes the placed shot and plays it
 * on the voice of its kind that has been quiet longest, so a burst of fire
 * overlaps rather than cutting itself off.
 */
export class ShotPool {
  private readonly tone: ToneModule;
  private readonly rings = new Map<SoundKind, Ring>();

  constructor(tone: ToneModule, bus: Tone.InputNode) {
    this.tone = tone;
    for (const kind of Object.keys(SHOTS)) {
      const spec = SHOTS[kind] as ShotSpec;
      const voices = [];
      for (let i = 0; i < spec.ring; i++) voices.push(new ShotVoice(tone, bus, spec));
      this.rings.set(kind as SoundKind, { voices, next: 0 });
    }
    const bells = [];
    for (let i = 0; i < BELL_RING; i++) bells.push(new BellVoice(tone, bus));
    this.rings.set('bell', { voices: bells, next: 0 });
  }

  fire(shot: FiredShot): void {
    const ring = this.rings.get(shot.kind);
    if (ring === undefined) return;
    // The voice that will be free soonest, so a ring of two never cuts a tail
    // that a quiet voice could have carried.
    let chosen = ring.voices[0];
    for (const voice of ring.voices) {
      if (chosen === undefined || voice.free < chosen.free) chosen = voice;
    }
    chosen?.play(shot, this.tone.now());
  }

  dispose(): void {
    for (const ring of this.rings.values()) {
      for (const voice of ring.voices) voice.dispose();
    }
    this.rings.clear();
  }
}
