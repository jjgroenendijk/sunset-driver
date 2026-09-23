/**
 * The bus layout of spec section 15, and the one place that plays a plan.
 *
 * Four buses meet at the master: the music — the radio and the score — the
 * effects, being cues, sirens, tyres and the horn, the player's own engine,
 * kept apart so it can be held under the rest of the mix, and the ambient beds
 * of the place itself. A limiter sits on the master so nothing an explosion
 * does can clip the output.
 *
 * The beds have their own bus because they are not an effect and must not duck:
 * the city does not stop humming because somebody fired a gun in it.
 *
 * The music bus is what ducks, and it is what the radio stations and the
 * situational score of spec section 15 play into. A cue marked `ducks` in
 * `cue.ts` pulls it down and it climbs back over {@link DUCK_RECOVER}, so
 * gunfire and collisions open a hole for themselves without the radio jumping
 * back the instant they stop.
 *
 * The siren voices follow units rather than places in the list: a voice keeps
 * the unit it was given as long as that unit is still one of the nearest, so a
 * second car joining a chase does not make the first one's siren change pitch.
 */
import { Gain, getDestination, Limiter, now } from 'tone';
import { AmbientBeds } from './beds.ts';
import { CryBank } from './cries.ts';
import type { AudioPlan } from './plan.ts';
import { SIREN_VOICES } from './plan.ts';
import { ShotBank } from './one-shots.ts';
import { RadioVoice, ScoreVoice } from './radio.ts';
import type { Listener } from './space.ts';
import { EngineVoice, HornVoice, RAMP, SirenVoice, SquealVoice, TramVoice } from './voices.ts';

/** Where the master sits before the limiter. Headroom for the cues to peak into. */
export const MASTER_GAIN = 0.42;

/** What each family of voices is worth against the others. */
export const LEVELS = Object.freeze({
  engine: 0.42,
  siren: 3,
  squeal: 0.35,
  tram: 1.6,
  horn: 0.5,
  cue: 1.2,
  cry: 0.8,
  radio: 0.7,
  score: 0.5,
  bed: 0.5,
});

/** Seconds the music bus takes to climb back after a cue has ducked it. */
export const DUCK_RECOVER = 0.9;

/** The whole node graph of a session's audio. Built once and ramped after that. */
export class Mixer {
  /** The buses. `music` is public because the radio of spec section 15 plugs into it. */
  readonly music = new Gain(1);
  readonly effects = new Gain(1);
  private readonly master = new Gain(MASTER_GAIN);
  private readonly limiter = new Limiter(-1);
  private readonly engineBus = new Gain(1);
  /** The ambient beds, on their own bus: the place does not duck for a gunshot. */
  private readonly ambience = new Gain(1);
  private readonly beds: AmbientBeds;
  private readonly engine: EngineVoice;
  private readonly sirens: SirenVoice[];
  private readonly squeal: SquealVoice;
  private readonly horn: HornVoice;
  /** The nearest tram on its rails (spec section 13.2). */
  private readonly tram: TramVoice;
  private readonly shots: ShotBank;
  /** The human cries of `cry.ts`, on the effects bus beside the one-shots. */
  private readonly cries: CryBank;
  /** The radio of spec section 15 and the score over it, both on the music bus. */
  private readonly radio: RadioVoice;
  private readonly score: ScoreVoice;
  /** How far the music is pulled down, and the context time that was last measured at. */
  private duck = 0;
  private at = 0;

  constructor() {
    this.master.chain(this.limiter, getDestination());
    this.music.connect(this.master);
    this.effects.connect(this.master);
    this.engineBus.connect(this.master);
    this.ambience.connect(this.master);
    this.beds = new AmbientBeds(this.ambience);
    this.engine = new EngineVoice(this.engineBus);
    this.sirens = Array.from({ length: SIREN_VOICES }, () => new SirenVoice(this.effects));
    this.squeal = new SquealVoice(this.effects);
    this.horn = new HornVoice(this.effects);
    this.tram = new TramVoice(this.effects);
    this.shots = new ShotBank(this.effects);
    this.cries = new CryBank(this.effects);
    // Both ride the music bus, so a gunshot ducks the station and the score
    // with it, and the radio of spec section 15 needs no bus of its own.
    this.radio = new RadioVoice(this.music);
    this.score = new ScoreVoice(this.music);
  }

  /** Set every oscillator running. Called once the browser has given a context. */
  start(): void {
    this.engine.start();
    for (const siren of this.sirens) siren.start();
    this.squeal.start();
    this.horn.start();
    this.tram.start();
    this.score.start();
    this.beds.start();
    this.at = now();
  }

  /** Play one frame of the plan. */
  apply(plan: AudioPlan, listener: Listener): void {
    const at = now();
    const elapsed = Math.max(0, at - this.at);
    this.at = at;
    if (plan.engine === null) this.engine.silence();
    else this.engine.set(plan.engine, LEVELS.engine);
    this.squeal.set(plan.squeal, LEVELS.squeal);
    this.horn.set(plan.horn, LEVELS.horn);
    if (plan.tram === null) this.tram.silence();
    else this.tram.set(plan.tram, LEVELS.tram);
    this.setSirens(plan);
    this.beds.set(plan.beds, LEVELS.bed);
    this.shots.play(plan.cues, listener, LEVELS.cue);
    this.cries.play(plan.cries, listener, LEVELS.cry);
    this.radio.set(plan.radio, LEVELS.radio, at);
    this.score.set(plan.score, LEVELS.score);
    // The duck falls away on its own and is pushed back down by anything this
    // frame asked for, so a run of shots holds the hole open rather than
    // reopening it.
    this.duck = Math.max(plan.duck, this.duck * Math.exp(-elapsed / DUCK_RECOVER));
    this.music.gain.rampTo(1 - this.duck, RAMP);
  }

  /** Take every held note off, leaving the graph standing. A paused session sounds like this. */
  hush(): void {
    this.engine.silence();
    for (const siren of this.sirens) siren.silence();
    this.squeal.silence();
    this.horn.silence();
    this.tram.silence();
    this.radio.silence();
    this.score.silence();
    this.beds.silence();
  }

  /** Cues and cries dropped for want of a voice, which says whether the cap is biting. */
  get dropped(): number {
    return this.shots.dropped + this.cries.dropped;
  }

  dispose(): void {
    this.engine.dispose();
    for (const siren of this.sirens) siren.dispose();
    this.squeal.dispose();
    this.horn.dispose();
    this.tram.dispose();
    this.shots.dispose();
    this.cries.dispose();
    this.radio.dispose();
    this.score.dispose();
    this.beds.dispose();
    for (const node of [this.music, this.effects, this.engineBus, this.ambience, this.master, this.limiter]) {
      node.dispose();
    }
  }

  /**
   * Hand each siren of the plan to the voice already following that unit, and
   * give what is left over to the voices nobody claimed.
   */
  private setSirens(plan: AudioPlan): void {
    const taken = new Array<boolean>(this.sirens.length).fill(false);
    const placed = new Array<boolean>(plan.sirens.length).fill(false);
    for (let i = 0; i < plan.sirens.length; i++) {
      const siren = plan.sirens[i];
      if (siren === undefined) continue;
      const at = this.sirens.findIndex((voice, v) => !taken[v] && voice.unit === siren.id);
      if (at < 0) continue;
      taken[at] = true;
      placed[i] = true;
      this.sirens[at]?.set(siren, LEVELS.siren);
    }
    for (let i = 0; i < plan.sirens.length; i++) {
      const siren = plan.sirens[i];
      if (siren === undefined || placed[i]) continue;
      const at = taken.indexOf(false);
      if (at < 0) break;
      taken[at] = true;
      const voice = this.sirens[at];
      if (voice === undefined) continue;
      voice.unit = siren.id;
      voice.set(siren, LEVELS.siren);
    }
    for (let v = 0; v < this.sirens.length; v++) {
      if (taken[v]) continue;
      const voice = this.sirens[v];
      if (voice === undefined) continue;
      voice.unit = -1;
      voice.silence();
    }
  }
}
