/**
 * The sink that makes a sound: what the director asks for, played through
 * Tone.js (spec section 15).
 *
 * It owns the voices and nothing else. What is heard, how loud and how many at
 * once are all decided in `director.ts` and `mix.ts`, which hold no Tone.js and
 * are tested headless; this file only builds, sets and tears down.
 */
import type { AudioSink, FiredShot, HeldLoop } from './director.ts';
import type { EngineCue } from './cues.ts';
import type { Mixed } from './mix.ts';
import { EngineVoice, makeLoop, type PlacedVoice } from './tone-loops.ts';
import { ToneMixer } from './tone-mixer.ts';
import { ShotPool } from './tone-shots.ts';

export class ToneSink implements AudioSink {
  private readonly mixer: ToneMixer;
  private readonly shots: ShotPool;
  private readonly loops = new Map<string, PlacedVoice>();
  private readonly engineVoice: EngineVoice;

  constructor(mixer: ToneMixer) {
    this.mixer = mixer;
    this.shots = new ShotPool(mixer.tone, mixer.effects);
    this.engineVoice = new EngineVoice(mixer.tone, mixer.engine);
  }

  engine(cue: EngineCue | null, mix: Mixed): void {
    if (cue === null) this.engineVoice.quieten();
    else this.engineVoice.set(cue, mix);
  }

  hold(loop: HeldLoop): void {
    let voice = this.loops.get(loop.id);
    if (voice === undefined) {
      const made = makeLoop(this.mixer.tone, this.mixer.effects, loop.kind);
      if (made === null) return;
      voice = made;
      this.loops.set(loop.id, voice);
    }
    voice.set(loop);
  }

  release(id: string): void {
    const voice = this.loops.get(id);
    if (voice === undefined) return;
    this.loops.delete(id);
    voice.dispose();
  }

  fire(shot: FiredShot): void {
    this.shots.fire(shot);
  }

  duck(amount: number): void {
    this.mixer.duck(amount);
  }

  /** The master volume, 0 to 1. */
  set volume(value: number) {
    this.mixer.volume = value;
  }

  dispose(): void {
    for (const voice of this.loops.values()) voice.dispose();
    this.loops.clear();
    this.engineVoice.dispose();
    this.shots.dispose();
    this.mixer.dispose();
  }
}
