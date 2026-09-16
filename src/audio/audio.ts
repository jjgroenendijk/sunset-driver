/**
 * The door onto the game's audio (spec section 15): one object the frame loop
 * calls, which knows when it may make a sound at all.
 *
 * A browser gives no audio until the player has touched the page, so nothing is
 * built until their first key or click: Tone.js is not even fetched before
 * then, which also keeps it out of the first load. Turning the sound off tears
 * the whole graph down rather than turning a gain to zero, so a muted session
 * synthesises nothing, as the spec asks.
 *
 * `director.ts` decides what is heard and `tone-sink.ts` plays it. This file
 * only owns the gesture, the volume and the tear-down.
 */
import type { InputFrame } from '../sim/input.ts';
import type { SimState } from '../sim/simulation.ts';
import type { WorldSounds } from './cues.ts';
import { AudioDirector, SILENT_SINK } from './director.ts';
import type { Ear } from './mix.ts';
import { ToneMixer } from './tone-mixer.ts';
import { ToneSink } from './tone-sink.ts';

/** The events that count as the gesture a browser waits for. */
const GESTURES: readonly string[] = ['pointerdown', 'keydown'];

export class GameAudio {
  private director = new AudioDirector(SILENT_SINK);
  private sink: ToneSink | null = null;
  private level: number;
  /** True while Tone.js is being fetched, so a second gesture does not fetch it again. */
  private starting = false;
  private armed: Window | null = null;

  constructor(volume: number) {
    this.level = clamp(volume);
  }

  /** True once the graph is up and a sound can be made. */
  get playing(): boolean {
    return this.sink !== null;
  }

  /**
   * Wait for the player's first gesture on `target` and start there. Listening
   * costs nothing until one arrives, and the listeners come off once the graph
   * is up.
   */
  arm(target: Window): void {
    if (this.armed !== null) return;
    this.armed = target;
    for (const event of GESTURES) target.addEventListener(event, this.onGesture);
  }

  /** The master volume, 0 to 1. Zero tears the graph down; anything else builds it. */
  set volume(value: number) {
    this.level = clamp(value);
    if (this.level === 0) {
      this.stop();
      return;
    }
    if (this.sink === null) void this.start();
    else this.sink.volume = this.level;
  }

  get volume(): number {
    return this.level;
  }

  /**
   * One frame: the record, the input frame the last tick was stepped with, and
   * where the ear is. It is safe to call before the sound has started, which is
   * most of the frames of a session that never touches the page.
   */
  update(state: SimState, input: InputFrame, ear: Ear, world?: WorldSounds): void {
    this.director.update(state, input, ear, world);
  }

  /** Let everything go without tearing the graph down: a pause, or a menu. */
  hush(): void {
    this.director.silence();
  }

  dispose(): void {
    if (this.armed !== null) {
      for (const event of GESTURES) this.armed.removeEventListener(event, this.onGesture);
      this.armed = null;
    }
    this.stop();
  }

  private readonly onGesture = (): void => {
    void this.start();
  };

  /**
   * Build the graph. Tone.js is imported here and nowhere else, so a session
   * that never makes a sound never fetches it.
   */
  private async start(): Promise<void> {
    if (this.sink !== null || this.starting || this.level === 0) return;
    this.starting = true;
    try {
      const tone = await import('tone');
      await tone.start();
      const sink = new ToneSink(new ToneMixer(tone, this.level));
      this.sink = sink;
      this.director = new AudioDirector(sink);
      if (this.armed !== null) {
        for (const event of GESTURES) this.armed.removeEventListener(event, this.onGesture);
      }
    } catch (error) {
      // A browser that refuses the audio device is a session without sound, not
      // a session that stops.
      console.warn('The sound could not be started.', error);
    } finally {
      this.starting = false;
    }
  }

  /** Tear the graph down: nothing is left running, which is what a mute means here. */
  private stop(): void {
    if (this.sink === null) return;
    this.director.silence();
    this.director = new AudioDirector(SILENT_SINK);
    this.sink.dispose();
    this.sink = null;
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
