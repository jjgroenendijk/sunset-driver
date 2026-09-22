/**
 * The frame-time monitor of spec section 9.2, which walks the tiers of
 * `quality.ts` while the player's Graphics setting is Auto.
 *
 * It is pure: it is given how long each frame took and answers a tier when it
 * changes one, so the policy is tested without a renderer.
 *
 * Two things shape the policy. A tier is dropped only when the frame stays
 * slow for a second and a half, because a chunk landing or a burst of
 * streaming is a hitch, not a machine that cannot hold the frame. And a tier
 * is raised again without the proof of headroom a synced display cannot give:
 * a 60 Hz display that makes every refresh measures 16.7 ms a frame however
 * little of it the game spent. So after ten steady seconds the monitor tries
 * the tier above. A try that misses at once is dropped at once, and the next
 * try at that tier waits twice as long.
 */
import { FRAME_BUDGET_MS, QUALITY_TIERS, type QualityTier } from './quality.ts';

/** A tier the monitor has just moved to, and the frame time that moved it. */
export interface QualityChange {
  from: QualityTier;
  to: QualityTier;
  /** The median frame of the window that decided it, in milliseconds. */
  frameMs: number;
}

/**
 * Milliseconds of frames the monitor judges at once. A window is measured in
 * time rather than in frames, so a 144 Hz display is judged over the same
 * half second as a 60 Hz one.
 */
export const WINDOW_MS = 500;

/** Windows in a row that must miss before a tier is dropped: a second and a half. */
const BAD_WINDOWS = 3;

/**
 * Windows in a row under {@link HEADROOM} of the budget before a tier is
 * raised. This is the path of a display that does not sync to its refresh, or
 * refreshes faster than the budget, where the headroom can be measured.
 */
const GOOD_WINDOWS = 4;

/**
 * Fraction of the budget the median must come in under to count as headroom.
 * The room left over is what the tier above will spend.
 */
const HEADROOM = 0.7;

/**
 * Steady windows — none missed — before the tier above is tried: ten seconds.
 * A synced display never shows headroom, so this is how it finds its way back
 * up after a hitch.
 */
const STEADY_WINDOWS = 20;

/** The longest wait before a try, after tries that failed: eighty seconds. */
const MAX_STEADY_WINDOWS = STEADY_WINDOWS * 8;

/**
 * Windows after a raise in which one miss drops the tier again at once. The
 * tier above was a try, and a try that misses has answered the question.
 */
const TRY_WINDOWS = 4;

/**
 * How far over the budget the median may run before a window counts as missed.
 * A 60 Hz display that makes every refresh measures 16.7 ms, which is over a
 * 16 ms budget, and one refresh missed measures 33 ms. A median between the two
 * is the refresh and its jitter, not a machine that cannot hold the frame.
 */
const MISS = 1.25;

/**
 * A frame longer than this is not counted. A window switching back, a garbage
 * collection or the tab coming back to the front is not a frame rate.
 */
const STALL_MS = 200;

/** Windows thrown away when a session starts: the city is still streaming in. */
const START_WINDOWS = 4;

/**
 * Windows thrown away after a change. The change costs frames of its own: the
 * shadow map is resized, and a new draw distance sets the workers going.
 */
const CHANGE_WINDOWS = 2;

export class QualityMonitor {
  private readonly budgetMs: number;
  /** The interval of the frame cap, which no frame comes in under. 0 while there is none. */
  private capMs = 0;
  private readonly frames: number[] = [];
  private spent = 0;
  private at: number;
  /** Windows still to be thrown away rather than judged. */
  private settling = START_WINDOWS;
  private bad = 0;
  private good = 0;
  private steady = 0;
  /** Windows left in which a miss drops a tier that was just tried. */
  private trying = 0;
  /** Steady windows needed before each tier is tried, by its index. */
  private readonly wait: number[] = QUALITY_TIERS.map(() => STEADY_WINDOWS);

  constructor(budgetMs = FRAME_BUDGET_MS, at = 0) {
    this.budgetMs = budgetMs;
    this.at = clampTier(at);
  }

  /** The tier in force. */
  get tier(): QualityTier {
    return QUALITY_TIERS[this.at] as QualityTier;
  }

  /** Where that tier stands in {@link QUALITY_TIERS}, 0 being the dearest. */
  get index(): number {
    return this.at;
  }

  /**
   * The frame the tiers are held to, in milliseconds. A frame cap slower than
   * the budget raises it to the cap's interval: at 30 fps every frame takes
   * 33 ms, and that is the cap, not a machine that cannot hold the frame.
   */
  get budget(): number {
    return Math.max(this.budgetMs, this.capMs);
  }

  /**
   * Take the interval of the frame cap (`pace.ts`), 0 for none. A new cap
   * changes what a frame measures, so the window being filled is thrown away.
   */
  cap(intervalMs: number): void {
    if (intervalMs === this.capMs) return;
    this.capMs = intervalMs;
    this.settle();
  }

  /** Count one frame, and answer the change it caused if it caused one. */
  sample(frameMs: number): QualityChange | undefined {
    if (!(frameMs > 0) || frameMs > STALL_MS) return undefined;
    this.frames.push(frameMs);
    this.spent += frameMs;
    // Half a millisecond short is a whole window: thirty frames of a 60 Hz
    // display add up to a hair either side of 500 ms.
    if (this.spent < WINDOW_MS - 0.5) return undefined;
    const middle = median(this.frames);
    this.frames.length = 0;
    this.spent = 0;
    if (this.settling > 0) {
      this.settling--;
      return undefined;
    }
    return this.judge(middle);
  }

  /**
   * Throw away the window being filled and the one after it. What the developer
   * free camera of `free-camera.ts` draws is never a performance measurement,
   * so the monitor is settled again when it hands the camera back.
   */
  settle(): void {
    this.frames.length = 0;
    this.spent = 0;
    this.bad = 0;
    this.good = 0;
    this.steady = 0;
    this.trying = 0;
    this.settling = Math.max(this.settling, 1);
  }

  /**
   * Start again from a tier, as a session does. This is what turning Auto on
   * in the Graphics menu does, from the tier nearest the player's own choice.
   */
  restart(at: number): void {
    this.settle();
    this.at = clampTier(at);
    this.settling = START_WINDOWS;
    this.wait.fill(STEADY_WINDOWS);
  }

  private judge(middle: number): QualityChange | undefined {
    if (middle > this.budget * MISS) {
      this.good = 0;
      this.steady = 0;
      if (this.trying > 0) {
        // The tier just tried could not hold the frame: back down at once,
        // and wait twice as long before it is tried again.
        this.wait[this.at] = Math.min(MAX_STEADY_WINDOWS, (this.wait[this.at] as number) * 2);
        return this.step(1, middle);
      }
      this.bad++;
      return this.bad < BAD_WINDOWS ? undefined : this.step(1, middle);
    }
    this.bad = 0;
    if (this.trying > 0 && --this.trying === 0) this.wait[this.at] = STEADY_WINDOWS;
    this.good = middle <= this.budget * HEADROOM ? this.good + 1 : 0;
    this.steady++;
    const above = this.at - 1;
    if (above < 0) return undefined;
    if (this.good >= GOOD_WINDOWS || this.steady >= (this.wait[above] as number)) {
      return this.step(-1, middle);
    }
    return undefined;
  }

  /** Move one tier, or stay where there is nowhere left to go. */
  private step(by: number, frameMs: number): QualityChange | undefined {
    this.bad = 0;
    this.good = 0;
    this.steady = 0;
    this.trying = 0;
    const to = this.at + by;
    if (to < 0 || to >= QUALITY_TIERS.length) return undefined;
    const from = this.tier;
    this.at = to;
    this.settling = CHANGE_WINDOWS;
    if (by < 0) this.trying = TRY_WINDOWS;
    return { from, to: this.tier, frameMs };
  }
}

/** The middle frame of a window, which one dear frame cannot move. */
function median(frames: readonly number[]): number {
  const sorted = [...frames].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}

function clampTier(at: number): number {
  return Math.min(QUALITY_TIERS.length - 1, Math.max(0, Math.round(at)));
}
