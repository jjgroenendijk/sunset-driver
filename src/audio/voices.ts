/**
 * The voices that hold a note rather than being struck: the engine, a siren,
 * the tyres, the horn and a tram on its rails (spec section 15).
 *
 * Each one is a handful of Tone.js oscillators wired once and then only ever
 * ramped, because a Web Audio node graph is cheap to hold and dear to rebuild.
 * A voice starts when the mixer starts and runs until it is disposed of; what
 * changes from frame to frame is a gain, a frequency and a pan. Silence is a
 * gain of nothing, not a stopped oscillator.
 *
 * Every number ramps over {@link RAMP} rather than jumping, which is what keeps
 * a click out of the mix when the plan of one frame differs from the last.
 *
 * `plan.ts` decides what these should be doing; nothing here reads the record.
 */
import { Filter, Gain, Noise, Oscillator, Panner } from 'tone';
import type { AudioPlan, SirenPlan, TramNoisePlan } from './plan.ts';

/** Seconds every parameter takes to reach the value the plan asked for. */
export const RAMP = 0.04;

/** Hertz the engine fires at with the vehicle idling, and at the redline. */
export const IDLE_HZ = 30;
export const RED_HZ = 135;

/** The two notes of a siren, in hertz, and the seconds it takes to swap them. */
export const SIREN_LOW = 660;
export const SIREN_HIGH = 880;
export const SIREN_SWAP = 0.05;

/** The two notes of a horn, in hertz: a minor third, as a road car's is. */
export const HORN_LOW = 400;
export const HORN_HIGH = 480;

/**
 * A tram's wheels on the rail: where the rumble sits, in hertz, and how far it
 * rises as the tram runs faster. It is low and broad, which is what a steel
 * wheel on steel rail is, and nothing like a tyre.
 */
export const RUMBLE_HZ = 105;
export const RUMBLE_RISE = 90;
export const RUMBLE_Q = 0.8;

/** Where a flange biting the rail on a curve sings, in hertz, and how narrow that band is. */
export const FLANGE_HZ = 2400;
export const FLANGE_Q = 12;

/** Where a sliding tyre sings, in hertz, and how narrow that band is. */
export const SQUEAL_HZ = 1900;
export const SQUEAL_Q = 7;

/** The player's own engine: a firing note, its octave, and the air it draws. */
export class EngineVoice {
  private readonly body = new Oscillator({ type: 'sawtooth', frequency: IDLE_HZ });
  private readonly upper = new Oscillator({ type: 'square', frequency: IDLE_HZ * 2, detune: 8 });
  private readonly upperGain = new Gain(0.3);
  private readonly air = new Noise({ type: 'brown' });
  private readonly airGain = new Gain(0);
  private readonly filter = new Filter({ type: 'lowpass', frequency: 500, Q: 1 });
  private readonly out = new Gain(0);
  private readonly panner = new Panner(0);

  constructor(bus: Gain) {
    this.body.connect(this.filter);
    this.upper.chain(this.upperGain, this.filter);
    this.air.chain(this.airGain, this.filter);
    this.filter.chain(this.out, this.panner);
    this.panner.connect(bus);
  }

  start(): void {
    this.body.start();
    this.upper.start();
    this.air.start();
  }

  /** Follow the plan: the note from the revs, the brightness and the air from the load. */
  set(engine: NonNullable<AudioPlan['engine']>, level: number): void {
    const { rev, load } = engine.sound;
    const hz = (IDLE_HZ + rev * (RED_HZ - IDLE_HZ)) * engine.pitch;
    this.body.frequency.rampTo(hz, RAMP);
    this.upper.frequency.rampTo(hz * 2, RAMP);
    // An engine under load is bright; one on the overrun is all body. The revs
    // open it further, so the note hardens as it climbs.
    this.filter.frequency.rampTo(320 + 2400 * (0.25 + 0.75 * load) * (0.4 + 0.6 * rev), RAMP);
    this.airGain.gain.rampTo(0.04 + 0.22 * load, RAMP);
    this.out.gain.rampTo(engine.gain * level * (0.3 + 0.4 * load + 0.3 * rev), RAMP);
    this.panner.pan.rampTo(engine.pan, RAMP);
  }

  silence(): void {
    this.out.gain.rampTo(0, RAMP);
  }

  dispose(): void {
    for (const node of [this.body, this.upper, this.upperGain, this.air, this.airGain, this.filter, this.out, this.panner]) {
      node.dispose();
    }
  }
}

/**
 * One siren: a square and a saw a hair apart. A police car's swaps between two
 * notes on the wail the plan hands it (spec section 14); a fire engine's and an
 * ambulance's sweep between them instead (spec section 20.3).
 */
export class SirenVoice {
  private readonly square = new Oscillator({ type: 'square', frequency: SIREN_LOW });
  private readonly saw = new Oscillator({ type: 'sawtooth', frequency: SIREN_LOW, detune: 6 });
  private readonly sawGain = new Gain(0.35);
  private readonly filter = new Filter({ type: 'bandpass', frequency: 1200, Q: 1.4 });
  private readonly out = new Gain(0);
  private readonly panner = new Panner(0);
  /** The unit this voice is following, or -1 while it follows nobody. */
  unit = -1;

  constructor(bus: Gain) {
    this.square.connect(this.filter);
    this.saw.chain(this.sawGain, this.filter);
    this.filter.chain(this.out, this.panner);
    this.panner.connect(bus);
  }

  start(): void {
    this.square.start();
    this.saw.start();
  }

  set(siren: SirenPlan, level: number): void {
    // Two notes swapped at the half, or one note swept up and back down.
    const sweep = 1 - Math.abs(2 * siren.wail - 1);
    const hz = siren.pitch * (siren.sound === 'two-tone' ? (siren.wail < 0.5 ? SIREN_HIGH : SIREN_LOW) : SIREN_LOW + (SIREN_HIGH - SIREN_LOW) * sweep);
    this.square.frequency.rampTo(hz, SIREN_SWAP);
    this.saw.frequency.rampTo(hz, SIREN_SWAP);
    this.out.gain.rampTo(siren.gain * level, RAMP);
    this.panner.pan.rampTo(siren.pan, RAMP);
  }

  silence(): void {
    this.out.gain.rampTo(0, RAMP);
  }

  dispose(): void {
    for (const node of [this.square, this.saw, this.sawGain, this.filter, this.out, this.panner]) node.dispose();
  }
}

/**
 * The tyres: white noise through a narrow band, which is what a tyre losing the
 * road actually is. It is never panned, because it is the player's own car and
 * the player is sitting in it.
 */
export class SquealVoice {
  private readonly noise = new Noise({ type: 'white' });
  private readonly filter = new Filter({ type: 'bandpass', frequency: SQUEAL_HZ, Q: SQUEAL_Q });
  private readonly out = new Gain(0);

  constructor(bus: Gain) {
    this.noise.chain(this.filter, this.out);
    this.out.connect(bus);
  }

  start(): void {
    this.noise.start();
  }

  /** A harder slide sings higher as well as louder, as a tyre does. */
  set(amount: number, level: number): void {
    this.filter.frequency.rampTo(SQUEAL_HZ * (0.8 + 0.4 * amount), RAMP);
    this.out.gain.rampTo(amount * level, RAMP);
  }

  silence(): void {
    this.out.gain.rampTo(0, RAMP);
  }

  dispose(): void {
    for (const node of [this.noise, this.filter, this.out]) node.dispose();
  }
}

/** The horn: two notes a minor third apart, through a lid that keeps it from shrieking. */
export class HornVoice {
  private readonly low = new Oscillator({ type: 'square', frequency: HORN_LOW });
  private readonly high = new Oscillator({ type: 'sawtooth', frequency: HORN_HIGH });
  private readonly highGain = new Gain(0.5);
  private readonly filter = new Filter({ type: 'lowpass', frequency: 2400, Q: 0.7 });
  private readonly out = new Gain(0);

  constructor(bus: Gain) {
    this.low.connect(this.filter);
    this.high.chain(this.highGain, this.filter);
    this.filter.chain(this.out);
    this.out.connect(bus);
  }

  start(): void {
    this.low.start();
    this.high.start();
  }

  set(amount: number, level: number): void {
    this.out.gain.rampTo(amount * level, RAMP);
  }

  silence(): void {
    this.out.gain.rampTo(0, RAMP);
  }

  dispose(): void {
    for (const node of [this.low, this.high, this.highGain, this.filter, this.out]) node.dispose();
  }
}

/**
 * A tram running on its rails: a low band for the rumble of its wheels, and a
 * narrow high one for the flanges biting on a curve. Both are noise through a
 * filter, because that is what steel on steel is; neither is a note.
 *
 * It is panned, unlike the tyres, because the tram is out on the street and the
 * player is not in it.
 */
export class TramVoice {
  private readonly noise = new Noise({ type: 'brown' });
  private readonly rumble = new Filter({ type: 'bandpass', frequency: RUMBLE_HZ, Q: RUMBLE_Q });
  private readonly rumbleGain = new Gain(0);
  private readonly hiss = new Noise({ type: 'white' });
  private readonly flange = new Filter({ type: 'bandpass', frequency: FLANGE_HZ, Q: FLANGE_Q });
  private readonly flangeGain = new Gain(0);
  private readonly out = new Gain(0);
  private readonly panner = new Panner(0);

  constructor(bus: Gain) {
    this.noise.chain(this.rumble, this.rumbleGain, this.out);
    this.hiss.chain(this.flange, this.flangeGain, this.out);
    this.out.chain(this.panner);
    this.panner.connect(bus);
  }

  start(): void {
    this.noise.start();
    this.hiss.start();
  }

  /** A tram running faster rumbles louder and higher, and bites harder on a bend. */
  set(tram: TramNoisePlan, level: number): void {
    this.rumble.frequency.rampTo(RUMBLE_HZ + RUMBLE_RISE * tram.rumble, RAMP);
    this.rumbleGain.gain.rampTo(tram.rumble, RAMP);
    this.flangeGain.gain.rampTo(tram.squeal * 0.5, RAMP);
    this.out.gain.rampTo(tram.gain * level, RAMP);
    this.panner.pan.rampTo(tram.pan, RAMP);
  }

  silence(): void {
    this.out.gain.rampTo(0, RAMP);
  }

  dispose(): void {
    for (const node of [this.noise, this.rumble, this.rumbleGain, this.hiss, this.flange, this.flangeGain, this.out, this.panner]) node.dispose();
  }
}
