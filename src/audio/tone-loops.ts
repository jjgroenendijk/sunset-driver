/**
 * The sounds that hold (spec section 15), synthesised: the player's engine, a
 * siren, a helicopter's rotor, a tyre sliding, a burning vehicle and a horn.
 *
 * Every one is oscillators and noise, built once and left running, with its
 * gain, its pan and its own parameters set each frame. Nothing is started and
 * stopped per frame: a browser's audio thread pays for a node when it is built,
 * and an oscillator turned down to nothing costs about what a silent one does.
 *
 * `tone-shots.ts` is the other half — the sounds that ring out on their own.
 */
import type * as Tone from 'tone';
import type { HeldLoop } from './director.ts';
import { ENGINES, firingHz } from './engine-model.ts';
import type { EngineCue } from './cues.ts';
import type { Mixed, SoundKind } from './mix.ts';
import type { ToneModule } from './tone-mixer.ts';

/**
 * The level of each voice is the number `node scripts/audio-check.ts` measured
 * it against the others at. A synthesised voice's own amplitude is not its
 * gain — a band of noise through a filter comes out far under a square wave at
 * the same gain — so these are read off the meter rather than reasoned about.
 */

/** Seconds every per-frame change is ramped over. A step in a gain is a click. */
const RAMP = 0.06;

/** The lowest and highest the engine's firing note is allowed to reach, in hertz. */
const ENGINE_LOW = 22;
const ENGINE_HIGH = 260;

/** One voice that stands somewhere on the map and holds until it is disposed. */
abstract class PlacedVoice {
  protected readonly tone: ToneModule;
  protected readonly out: Tone.Gain;
  private readonly panner: Tone.Panner;

  constructor(tone: ToneModule, bus: Tone.InputNode) {
    this.tone = tone;
    this.panner = new tone.Panner(0).connect(bus);
    this.out = new tone.Gain(0).connect(this.panner);
  }

  /** Put the voice where it stands and set how loud it is heard. */
  protected place(mix: Mixed, gain: number): void {
    this.out.gain.rampTo(gain, RAMP);
    this.panner.pan.rampTo(mix.pan, RAMP);
  }

  abstract set(loop: HeldLoop): void;

  dispose(): void {
    this.out.dispose();
    this.panner.dispose();
  }
}

/**
 * The engine of spec section 15, from the revolutions, the load and the class.
 *
 * Three oscillators and a band of noise: the firing note the cylinders make,
 * the harmonic over it that gives the engine its shape, the sub an octave under
 * that is the weight of the vehicle, and the intake noise that rises with the
 * load. A lowpass over the lot opens as the engine works, which is what makes
 * an engine under load sound harder than one coasting at the same speed.
 */
export class EngineVoice {
  private readonly fire: Tone.Oscillator;
  private readonly harmonic: Tone.Oscillator;
  private readonly sub: Tone.Oscillator;
  private readonly noise: Tone.Noise;
  private readonly noiseGain: Tone.Gain;
  private readonly harmonicGain: Tone.Gain;
  private readonly subGain: Tone.Gain;
  private readonly tone: Tone.Filter;
  private readonly panner: Tone.Panner;
  private readonly out: Tone.Gain;

  constructor(tone: ToneModule, bus: Tone.InputNode) {
    this.panner = new tone.Panner(0).connect(bus);
    this.out = new tone.Gain(0).connect(this.panner);
    this.tone = new tone.Filter(900, 'lowpass').connect(this.out);
    this.fire = new tone.Oscillator(60, 'sawtooth').connect(this.tone).start();
    this.harmonicGain = new tone.Gain(0.45).connect(this.tone);
    this.harmonic = new tone.Oscillator(120, 'square').connect(this.harmonicGain).start();
    this.subGain = new tone.Gain(0.5).connect(this.tone);
    this.sub = new tone.Oscillator(30, 'sine').connect(this.subGain).start();
    this.noiseGain = new tone.Gain(0).connect(this.tone);
    this.noise = new tone.Noise('brown').connect(this.noiseGain).start();
  }

  set(cue: EngineCue, mix: Mixed): void {
    const timbre = ENGINES[cue.cls];
    const hz = Math.max(ENGINE_LOW, Math.min(ENGINE_HIGH, firingHz(cue.rpm, timbre.cylinders)));
    this.fire.frequency.rampTo(hz, RAMP);
    this.harmonic.frequency.rampTo(hz * 2, RAMP);
    this.sub.frequency.rampTo(hz * 0.5, RAMP);
    this.tone.frequency.rampTo(340 + hz * 4 + 2200 * cue.load, RAMP);
    this.noiseGain.gain.rampTo(timbre.roughness * (0.12 + 0.3 * cue.load), RAMP);
    this.out.gain.rampTo(mix.gain * (0.3 + 0.5 * cue.load), RAMP);
    this.panner.pan.rampTo(mix.pan, RAMP);
  }

  /** Let the engine go quiet without tearing the voice down: the player left the car. */
  quieten(): void {
    this.out.gain.rampTo(0, RAMP);
  }

  dispose(): void {
    for (const node of [this.fire, this.harmonic, this.sub, this.noise]) node.stop().dispose();
    for (const node of [this.noiseGain, this.harmonicGain, this.subGain, this.tone, this.out, this.panner]) node.dispose();
  }
}

/** The two-tone wail of spec section 15, held while a unit is out (spec section 14). */
class SirenVoice extends PlacedVoice {
  private readonly osc: Tone.Oscillator;
  private readonly wail: Tone.LFO;
  private readonly shape: Tone.Filter;

  constructor(tone: ToneModule, bus: Tone.InputNode) {
    super(tone, bus);
    this.shape = new tone.Filter(2400, 'lowpass').connect(this.out);
    this.osc = new tone.Oscillator(760, 'square').connect(this.shape).start();
    // The wail: a slow sweep between the two tones rather than a switch, which
    // is the American siren the spec's city is built on.
    this.wail = new tone.LFO(0.42, 620, 1180).start();
    this.wail.connect(this.osc.frequency);
  }

  set(loop: HeldLoop): void {
    this.place(loop, loop.gain * 1.5 * loop.strength);
  }

  override dispose(): void {
    this.wail.stop().dispose();
    this.osc.stop().dispose();
    this.shape.dispose();
    super.dispose();
  }
}

/** The helicopter of spec section 14: blade chop over a low thump. */
class RotorVoice extends PlacedVoice {
  private readonly noise: Tone.Noise;
  private readonly band: Tone.Filter;
  private readonly chop: Tone.Gain;
  private readonly blade: Tone.LFO;
  private readonly thump: Tone.Oscillator;
  private readonly thumpGain: Tone.Gain;

  constructor(tone: ToneModule, bus: Tone.InputNode) {
    super(tone, bus);
    this.chop = new tone.Gain(0.5).connect(this.out);
    this.band = new tone.Filter(340, 'bandpass').connect(this.chop);
    this.noise = new tone.Noise('brown').connect(this.band).start();
    this.blade = new tone.LFO(12.5, 0.05, 1).start();
    this.blade.connect(this.chop.gain);
    this.thumpGain = new tone.Gain(0.4).connect(this.out);
    this.thump = new tone.Oscillator(25, 'sine').connect(this.thumpGain).start();
  }

  set(loop: HeldLoop): void {
    this.place(loop, loop.gain * 2.2 * loop.strength);
  }

  override dispose(): void {
    this.blade.stop().dispose();
    this.noise.stop().dispose();
    this.thump.stop().dispose();
    for (const node of [this.band, this.chop, this.thumpGain]) node.dispose();
    super.dispose();
  }
}

/** A tyre sliding across the road (spec section 11.3): narrow, high noise that wavers. */
class SquealVoice extends PlacedVoice {
  private readonly noise: Tone.Noise;
  private readonly band: Tone.Filter;
  private readonly waver: Tone.LFO;

  constructor(tone: ToneModule, bus: Tone.InputNode) {
    super(tone, bus);
    this.band = new tone.Filter({ frequency: 2600, type: 'bandpass', Q: 7 }).connect(this.out);
    this.noise = new tone.Noise('white').connect(this.band).start();
    this.waver = new tone.LFO(6.2, 2200, 3100).start();
    this.waver.connect(this.band.frequency);
  }

  set(loop: HeldLoop): void {
    this.place(loop, loop.gain * 1.2 * loop.strength);
  }

  override dispose(): void {
    this.waver.stop().dispose();
    this.noise.stop().dispose();
    this.band.dispose();
    super.dispose();
  }
}

/** A vehicle burning (spec section 11.3): low noise that breathes. */
class FireVoice extends PlacedVoice {
  private readonly noise: Tone.Noise;
  private readonly body: Tone.Filter;
  private readonly breath: Tone.LFO;

  constructor(tone: ToneModule, bus: Tone.InputNode) {
    super(tone, bus);
    this.body = new tone.Filter(600, 'lowpass').connect(this.out);
    this.noise = new tone.Noise('brown').connect(this.body).start();
    this.breath = new tone.LFO(2.7, 380, 980).start();
    this.breath.connect(this.body.frequency);
  }

  set(loop: HeldLoop): void {
    this.place(loop, loop.gain * 1.1 * loop.strength);
  }

  override dispose(): void {
    this.breath.stop().dispose();
    this.noise.stop().dispose();
    this.body.dispose();
    super.dispose();
  }
}

/** The horn, held while the key is down. Two tones a minor third apart, as a car horn is. */
class HornVoice extends PlacedVoice {
  private readonly low: Tone.Oscillator;
  private readonly high: Tone.Oscillator;
  private readonly highGain: Tone.Gain;
  private readonly body: Tone.Filter;

  constructor(tone: ToneModule, bus: Tone.InputNode) {
    super(tone, bus);
    this.body = new tone.Filter(2200, 'lowpass').connect(this.out);
    this.low = new tone.Oscillator(370, 'sawtooth').connect(this.body).start();
    this.highGain = new tone.Gain(0.8).connect(this.body);
    this.high = new tone.Oscillator(440, 'sawtooth').connect(this.highGain).start();
  }

  set(loop: HeldLoop): void {
    this.place(loop, loop.gain * 0.3 * loop.strength);
  }

  override dispose(): void {
    this.low.stop().dispose();
    this.high.stop().dispose();
    this.highGain.dispose();
    this.body.dispose();
    super.dispose();
  }
}

/** The voice one loop of each kind is played on. The engine has its own class. */
export function makeLoop(tone: ToneModule, bus: Tone.InputNode, kind: SoundKind): PlacedVoice | null {
  switch (kind) {
    case 'siren':
      return new SirenVoice(tone, bus);
    case 'rotor':
      return new RotorVoice(tone, bus);
    case 'squeal':
      return new SquealVoice(tone, bus);
    case 'fire':
      return new FireVoice(tone, bus);
    case 'horn':
      return new HornVoice(tone, bus);
    default:
      return null;
  }
}

export type { PlacedVoice };
