/**
 * How often the page draws a frame, below the display's own refresh.
 *
 * The browser asks for a frame at the display's refresh, which is 120 Hz and
 * more on many laptops. The simulation steps at 60 Hz (spec section 2.1), so a
 * frame over 60 draws a blend of the same two ticks again and shows nothing
 * new. A frame that is not due is skipped whole: no step, no draw, no mix.
 *
 * A paused session and the title screen hold a picture that barely moves, and
 * are drawn slower still.
 */

/** The frame rates the Options column offers, in the order it cycles them. 0 is no cap. */
export const FRAME_CAPS: readonly { label: string; value: number }[] = [
  { label: '60 fps', value: 60 },
  { label: '30 fps', value: 30 },
  { label: 'No cap', value: 0 },
];

/** The cap a new player starts with: the rate of the simulation. */
export const DEFAULT_FRAME_CAP = 60;

/** Frames a second behind the pause menu. The city stands still; the menu is the DOM's. */
export const PAUSED_FPS = 10;

/** Frames a second behind the title screen, whose car turns slowly. */
export const TITLE_FPS = 30;

/**
 * Milliseconds early a frame may come and still count as due. A display's
 * refresh jitters, and a 60 Hz one asked for 60 fps must not skip every other
 * frame because one came in at 16.5 ms.
 */
const SLACK_MS = 2;

/** The cap a stored value stands for, or the default for one this build does not offer. */
export function frameCapOf(raw: unknown): number {
  return FRAME_CAPS.some((cap) => cap.value === raw) ? (raw as number) : DEFAULT_FRAME_CAP;
}

/** What the Options column calls a cap. */
export function frameCapLabel(fps: number): string {
  return (FRAME_CAPS[capIndex(fps)] as { label: string }).label;
}

/** The cap one step along the Options column's cycle from `fps`, round at either end. */
export function nextFrameCap(fps: number, by: 1 | -1): number {
  const length = FRAME_CAPS.length;
  return (FRAME_CAPS[(capIndex(fps) + by + length) % length] as { value: number }).value;
}

function capIndex(fps: number): number {
  return Math.max(0, FRAME_CAPS.findIndex((cap) => cap.value === fps));
}

/** Milliseconds between the frames of a rate, or 0 for no cap. */
export function intervalOf(fps: number): number {
  return fps > 0 ? 1000 / fps : 0;
}

/**
 * Decides which of the browser's frames are drawn. It keeps the time each
 * frame was due rather than the time it came, so a 144 Hz display asked for 60
 * averages 60 though no refresh falls on a sixtieth of a second.
 */
export class FramePacer {
  /** When the last drawn frame was due, or null before the first. */
  private due: number | null = null;

  /**
   * Whether the frame at `now` is drawn, at most one every `interval`
   * milliseconds. An interval of 0 draws every frame.
   */
  ready(now: number, interval: number): boolean {
    if (this.due === null || interval <= 0) {
      this.due = now;
      return true;
    }
    if (now - this.due < interval - SLACK_MS) return false;
    // A frame that came a refresh late lets the next one come a refresh early,
    // which keeps the average. After a long wait at most one frame is owed.
    this.due = Math.max(this.due + interval, now - interval);
    return true;
  }
}
