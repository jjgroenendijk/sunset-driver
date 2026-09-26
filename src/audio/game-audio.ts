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
import { getContext, start } from 'tone';
import type { InputFrame } from '../sim/input.ts';
import type { SimState } from '../sim/simulation.ts';
import type { SiteSource } from './ambience.ts';
import type { BuskerSource } from './busking.ts';
import type { HonkSource } from './honks.ts';
import { Mixer } from './mixer.ts';
import { AudioPlanner, type BellSource } from './plan.ts';
import type { Listener } from './space.ts';

/**
 * Milliseconds a hushed mix is left running before its context is suspended.
 * The notes ramp down in a fraction of that, so nothing is cut off.
 */
const REST_AFTER_MS = 500;

/** The events that count as the first user gesture. */
const GESTURES = ['pointerdown', 'keydown'] as const;

/** What the HUD shows of the radio: the station, and the line on air over it. */
export interface OnAirLine {
  name: string;
  /** The ident or the announcement being read, or empty while a song is playing. */
  text: string;
  /** Who the announcement is from, empty on an ident. */
  from: string;
}

export class GameAudio {
  private readonly planner = new AudioPlanner();
  private mixer: Mixer | null = null;
  /** True once the browser has handed over a running audio context. */
  private running = false;
  private silent: boolean;
  private target: Window | null = null;
  /** The trams of spec section 13.2, whose bells are not in the record. */
  private trams: BellSource | null = null;
  /** What the radio is putting out, for the HUD, or null while nothing is. */
  private air: OnAirLine | null = null;
  /** The world the ambient beds are read from, or null before a session has one. */
  private sites: SiteSource | null = null;
  /** The occupied corners of spec section 20.1, whose buskers play; null before a session has them. */
  private corners: BuskerSource | null = null;
  /** The traffic of spec section 13.1, whose drivers honk; null before a session has it. */
  private traffic: HonkSource | null = null;
  /** When the mix was first hushed, in page milliseconds, or null while it plays. */
  private hushedAt: number | null = null;
  /** True once a hush has lasted {@link REST_AFTER_MS}, until the next frame that plays. */
  private resting = false;
  /** True while the page is hidden. */
  private hidden = false;
  /** Whether the context was last asked to suspend, so each change is asked for once. */
  private suspended = false;

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
    target.document.addEventListener('visibilitychange', this.onVisibility);
  }

  /**
   * Take the session's tram line, so the bells of spec section 13.2 are rung.
   * A session without one simply has no trams to ring.
   */
  watch(trams: BellSource): void {
    this.trams = trams;
  }

  /**
   * Take the session's world, so the ambient beds of spec section 15 know what
   * the player is standing in. Without one the beds stay silent and the rest of
   * the mix is unchanged, which is what a session before its world sounds like.
   */
  survey(sites: SiteSource): void {
    this.sites = sites;
  }

  /** Take the session's traffic, so its drivers are heard honking (spec section 20.2). */
  hearTraffic(traffic: HonkSource): void {
    this.traffic = traffic;
  }

  /** Take the session's occupied corners, so the buskers of spec section 20.1 are heard. */
  hearBuskers(corners: BuskerSource): void {
    this.corners = corners;
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

  /**
   * What the radio is playing (spec section 15), for the HUD: the station and
   * the line of an ident or an announcement. Null while the game is muted, the
   * dial is at Off or the player is out of the car — a radio is a thing in a
   * car, and nothing is on air when nothing is playing it.
   */
  get onAir(): OnAirLine | null {
    return this.air;
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
    if (this.silent || !this.running) {
      this.air = null;
      return;
    }
    this.hushedAt = null;
    this.resting = false;
    this.wake();
    if (this.mixer === null) {
      this.mixer = new Mixer();
      this.mixer.start();
      this.planner.resync(state);
    }
    const plan = this.planner.plan(
      state,
      input,
      listener,
      this.trams ?? undefined,
      this.sites ?? undefined,
      this.corners ?? undefined,
      this.traffic ?? undefined,
    );
    this.mixer.apply(plan, listener);
    const radio = plan.radio;
    this.air = radio.station === null ? null : { name: radio.name, text: radio.text, from: radio.from };
  }

  /**
   * Take every held note off. A paused session does this. Once the notes have
   * died away the context is suspended, so an oscillator that is heard by
   * nobody costs no CPU; the next frame that plays wakes it again.
   */
  hush(): void {
    this.mixer?.hush();
    this.air = null;
    if (this.mixer === null) return;
    const at = performance.now();
    this.hushedAt ??= at;
    if (at - this.hushedAt < REST_AFTER_MS) return;
    this.resting = true;
    this.wake();
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
      this.target.document.removeEventListener('visibilitychange', this.onVisibility);
      this.target = null;
    }
  }

  /**
   * Suspend the context while it is resting or the page is hidden, and resume
   * it otherwise. A hidden page draws no frames, so without this the notes
   * held when it was hidden would play on behind another tab.
   */
  private wake(): void {
    const suspend = this.running && (this.resting || this.hidden);
    if (suspend === this.suspended || !this.running) return;
    this.suspended = suspend;
    const context = getContext().rawContext;
    // Only a realtime context can be suspended without a time to do it at.
    if (!('close' in context)) return;
    const done = suspend ? context.suspend() : context.resume();
    done.catch((error: unknown) => console.warn('The browser would not change the audio state.', error));
  }

  private readonly onVisibility = (): void => {
    this.hidden = this.target?.document.visibilityState === 'hidden';
    this.wake();
  };

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
