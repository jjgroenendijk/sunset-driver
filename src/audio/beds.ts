/**
 * The ambient beds of spec section 15, as Web Audio: the hum of the city, the
 * surf, the wind and the rain.
 *
 * A bed is noise through a filter and nothing else. Spec section 1.2 forbids
 * audio files, and a bed is exactly the sound a loop would be worst at: it must
 * run for an hour without a seam and change as the player walks. Shaped noise
 * has no seam to hear, and the shape is a handful of numbers.
 *
 * Two of them breathe. Surf is a swell that opens and closes, and wind gusts,
 * so each has a slow {@link LFO} on its filter rather than a fixed note; the
 * one on the surf is slower than a wave so no two passes land alike against the
 * other beds. Nothing here reads the record: `ambience.ts` decides how loud
 * each bed stands and this file is only how each one sounds.
 *
 * Every gain ramps over {@link BED_RAMP}, which is far longer than the
 * {@link RAMP} the rest of the mix uses. That is the crossfade on movement the
 * issue asks for: walking from downtown to the beach takes the hum down and
 * brings the surf up over about a second and a half, so neither is heard to
 * switch.
 */
import { Filter, Gain, LFO, Noise } from 'tone';
import type { BedPlan } from './ambience.ts';

/** Seconds a bed takes to reach the level the plan asked for. */
const BED_RAMP = 1.5;

/**
 * What each bed is worth against the others at full strength. Noise through a
 * closing filter is much quieter than its gain suggests, so these are read off
 * the meter of `scripts/audio-check.ts` rather than reasoned about.
 */
const BED_LEVELS = Object.freeze({ traffic: 0.85, surf: 0.7, wind: 0.8, rain: 0.35, metal: 0.16 });

/** One bed: a colour of noise, a filter over it, and a gain the plan ramps. */
class BedVoice {
  private readonly noise: Noise;
  private readonly filter: Filter;
  private readonly out = new Gain(0);
  /** The swell or the gust, on a bed that has one. */
  private readonly lfo: LFO | null;

  constructor(bus: Gain, colour: 'white' | 'pink' | 'brown', filter: ConstructorParameters<typeof Filter>[0], swell?: { hz: number; low: number; high: number }) {
    this.noise = new Noise({ type: colour });
    this.filter = new Filter(filter);
    this.noise.chain(this.filter, this.out);
    this.out.connect(bus);
    this.lfo = swell === undefined ? null : new LFO({ frequency: swell.hz, min: swell.low, max: swell.high });
    this.lfo?.connect(this.filter.frequency);
  }

  start(): void {
    this.noise.start();
    this.lfo?.start();
  }

  set(gain: number): void {
    this.out.gain.rampTo(gain, BED_RAMP);
  }

  dispose(): void {
    this.lfo?.dispose();
    for (const node of [this.noise, this.filter, this.out]) node.dispose();
  }
}

/**
 * The whole ambient bed of a session. Built with the mixer, started with it,
 * and ramped from there: a bed is never stopped and started, because a bed that
 * stops is a hole in the world.
 */
export class AmbientBeds {
  /** The city: brown noise under a low lid, which is distance and tyres and plant. */
  private readonly traffic: BedVoice;
  /** The sea: pink noise through a lid that opens and closes on the swell. */
  private readonly surf: BedVoice;
  /** The air: brown noise through a band that wanders, which is a gust. */
  private readonly wind: BedVoice;
  /** The rain itself: white noise with the body taken out of it. */
  private readonly rain: BedVoice;
  /** What the rain is falling on: a narrow band high up, which rings like a roof. */
  private readonly metal: BedVoice;

  constructor(bus: Gain) {
    this.traffic = new BedVoice(bus, 'brown', { type: 'lowpass', frequency: 260, Q: 0.6 });
    this.surf = new BedVoice(bus, 'pink', { type: 'lowpass', frequency: 700, Q: 0.8 }, { hz: 0.07, low: 260, high: 1500 });
    this.wind = new BedVoice(bus, 'pink', { type: 'lowpass', frequency: 500, Q: 0.9 }, { hz: 0.05, low: 220, high: 950 });
    this.rain = new BedVoice(bus, 'white', { type: 'highpass', frequency: 1300, Q: 0.5 });
    this.metal = new BedVoice(bus, 'white', { type: 'bandpass', frequency: 3300, Q: 4.5 });
  }

  /** Set the noise running. Called once the browser has given a context. */
  start(): void {
    for (const bed of this.voices()) bed.start();
  }

  /** Follow the plan. `level` is what the whole bed is worth in the mix. */
  set(beds: BedPlan, level: number): void {
    this.traffic.set(beds.traffic * BED_LEVELS.traffic * level);
    this.surf.set(beds.surf * BED_LEVELS.surf * level);
    this.wind.set(beds.wind * BED_LEVELS.wind * level);
    this.rain.set(beds.rain * BED_LEVELS.rain * level);
    this.metal.set(beds.metal * BED_LEVELS.metal * level);
  }

  /** Take the place off, leaving the noise running. A paused session sounds like this. */
  silence(): void {
    for (const bed of this.voices()) bed.set(0);
  }

  dispose(): void {
    for (const bed of this.voices()) bed.dispose();
  }

  private voices(): readonly BedVoice[] {
    return [this.traffic, this.surf, this.wind, this.rain, this.metal];
  }
}
