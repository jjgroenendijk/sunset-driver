/**
 * What the ear is given each frame: the scene of `cues.ts`, placed by `mix.ts`,
 * handed to a sink as a small set of calls.
 *
 * The director holds no Tone.js and no browser: it is the whole of the game's
 * audio behaviour as arithmetic, so `test/audio-director.test.ts` drives it
 * against a sink that only writes down what it was told. `tone-sink.ts` is the
 * sink that makes a sound.
 *
 * A loop is kept across frames by its id, so a police car keeps its own siren
 * while it drives past rather than starting one each frame. Everything is
 * budgeted here: the voices that would be heard least are dropped before the
 * sink is asked for them.
 */
import type { InputFrame } from '../sim/input.ts';
import type { SimState } from '../sim/simulation.ts';
import {
  createCueMemory,
  readScene,
  type AudioScene,
  type CueMemory,
  type EngineCue,
  type LoopCue,
  type ShotCue,
  type WorldSounds,
  NO_WORLD_SOUNDS,
} from './cues.ts';
import { duckFor, loudest, mixAt, SHOTS_PER_FRAME, VOICE_CAP, type Ear, type Mixed } from './mix.ts';

/** A loop or a shot, already placed at the ear. */
export interface HeldLoop extends LoopCue, Mixed {}
export interface FiredShot extends ShotCue, Mixed {}

/** What the director talks to. `tone-sink.ts` is the one that makes a sound. */
export interface AudioSink {
  /** Hold the player's engine at this note, or let it go when the cue is null. */
  engine(cue: EngineCue | null, mix: Mixed): void;
  /** Start the loop if it is new, and set where it stands and how hard it is. */
  hold(loop: HeldLoop): void;
  /** Let a loop go. Called once, for a loop that was held. */
  release(id: string): void;
  /** Start a sound that rings out on its own. */
  fire(shot: FiredShot): void;
  /** How far the music and ambient bus stands down, 0 to 1 (spec section 15). */
  duck(amount: number): void;
}

/** A sink that does nothing, which is what a muted or unstarted session uses. */
export const SILENT_SINK: AudioSink = {
  engine: () => {},
  hold: () => {},
  release: () => {},
  fire: () => {},
  duck: () => {},
};

/**
 * One session's audio behaviour. `update` is called once a frame with the
 * record, the input frame the last tick was stepped with, and where the ear is.
 */
export class AudioDirector {
  private readonly sink: AudioSink;
  private readonly memory: CueMemory = createCueMemory();
  /** The loops the sink is holding, by id, so a frame can let the rest go. */
  private readonly held = new Set<string>();
  /** Reused between frames, so a frame allocates nothing of its own. */
  private readonly scene: AudioScene = { engine: null, loops: [], shots: [] };
  private readonly placed: HeldLoop[] = [];
  private readonly fired: FiredShot[] = [];

  constructor(sink: AudioSink) {
    this.sink = sink;
  }

  /** The scene of the last frame, for the HUD and the tests. */
  get lastScene(): AudioScene {
    return this.scene;
  }

  update(state: SimState, input: InputFrame, ear: Ear, world: WorldSounds = NO_WORLD_SOUNDS): void {
    const scene = readScene(state, input, world, this.memory, this.scene);

    const engine = scene.engine;
    this.sink.engine(
      engine,
      engine === null ? { gain: 0, pan: 0 } : mixAt(ear, { kind: 'engine', x: engine.x, y: engine.y, strength: 1 }),
    );

    this.placed.length = 0;
    for (const loop of scene.loops) this.placed.push({ ...loop, ...mixAt(ear, loop) });
    const keeping = loudest(this.placed, VOICE_CAP);
    const wanted = new Set(keeping.map((loop) => loop.id));
    for (const id of [...this.held]) {
      if (wanted.has(id)) continue;
      this.sink.release(id);
      this.held.delete(id);
    }
    for (const loop of keeping) {
      this.sink.hold(loop);
      this.held.add(loop.id);
    }

    this.fired.length = 0;
    for (const shot of scene.shots) this.fired.push({ ...shot, ...mixAt(ear, shot) });
    const starting = loudest(this.fired, SHOTS_PER_FRAME);
    for (const shot of starting) this.sink.fire(shot);

    this.sink.duck(duckFor([...keeping, ...starting]));
  }

  /**
   * Let everything go: what a mute, a pause and the end of a session all come
   * to. The memory is kept, so the frame after a pause does not hear the whole
   * pause as one crash.
   */
  silence(): void {
    for (const id of [...this.held]) this.sink.release(id);
    this.held.clear();
    this.sink.engine(null, { gain: 0, pan: 0 });
    this.sink.duck(0);
  }
}
