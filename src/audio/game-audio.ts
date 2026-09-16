/**
 * The door onto the audio of spec section 15: `main.ts` holds one of these and
 * hands it the record once a frame.
 *
 * Two rules from the spec shape the whole class. A browser gives no audio
 * context until the player has touched the page, so the graph is not built at
 * all until a gesture has arrived; and nothing synthesises while the game is
 * muted, which is honoured by disposing of the graph rather than by turning a
 * gain down. A muted session holds no oscillator and costs no CPU.
 *
 * Everything below the door is split in two: `plan.ts` decides what to play,
 * from the record alone and with no Tone.js anywhere in it, and `mixer.ts`
 * plays it. That is what lets the rules be tested headless.
 */
import { start } from 'tone';
import type { InputFrame } from '../sim/input.ts';
import type { SimState } from '../sim/simulation.ts';
import { Mixer } from './mixer.ts';
import { AudioPlanner } from './plan.ts';
import type { Listener } from './space.ts';

/** The events that count as the first user gesture. */
const GESTURES = ['pointerdown', 'keydown'] as const;

export class GameAudio {
  private readonly planner = new AudioPlanner();
  private mixer: Mixer | null = null;
  /** True once the browser has handed over a running audio context. */
  private running = false;
  private silent: boolean;
  private target: Window | null = null;

  constructor(muted = false) {
    this.silent = muted;
  }

  /**
   * Wait for the first gesture on `target` and take the audio context from it.
   * The listener stays until a gesture actually starts the context, so a player
   * who begins muted still gets sound the first time they touch the page after
   * unmuting.
   */
  arm(target: Window): void {
    this.target = target;
    for (const event of GESTURES) target.addEventListener(event, this.onGesture);
  }

  get muted(): boolean {
    return this.silent;
  }

  /** Muting throws the graph away; unmuting builds it again on the next frame. */
  set muted(value: boolean) {
    if (value === this.silent) return;
    this.silent = value;
    if (value) this.close();
  }

  /** Cues dropped for want of a voice, or 0 while there is no graph. */
  get dropped(): number {
    return this.mixer?.dropped ?? 0;
  }

  /**
   * Play one frame. `listener` is where the player is on the map, which is the
   * drawn position rather than the last tick's: the mix follows what is on
   * screen.
   */
  update(state: SimState, input: InputFrame, listener: Listener): void {
    if (this.silent || !this.running) return;
    if (this.mixer === null) {
      this.mixer = new Mixer();
      this.mixer.start();
      this.planner.resync(state);
    }
    this.mixer.apply(this.planner.plan(state, input, listener), listener);
  }

  /** Take every held note off. A paused session and a detached camera both do this. */
  hush(): void {
    this.mixer?.hush();
  }

  /**
   * Take up the record where it now stands without making a sound of it. A
   * load, a respawn and a metro trip all move the player and their vehicle, and
   * the difference between two records is not a crash.
   */
  resync(state: SimState): void {
    this.planner.resync(state);
  }

  dispose(): void {
    this.close();
    if (this.target !== null) {
      for (const event of GESTURES) this.target.removeEventListener(event, this.onGesture);
      this.target = null;
    }
  }

  private close(): void {
    this.mixer?.dispose();
    this.mixer = null;
  }

  /**
   * `start` has to be called from the gesture itself, so it is called here and
   * the promise is only used to record that the context came up.
   */
  private readonly onGesture = (): void => {
    if (this.running || this.silent) return;
    void start().then(
      () => {
        this.running = true;
        if (this.target === null) return;
        for (const event of GESTURES) this.target.removeEventListener(event, this.onGesture);
      },
      (error: unknown) => console.warn('The browser would not start the audio.', error),
    );
  };
}
