/**
 * What a finger means, without a browser.
 *
 * The game is played with a keyboard and a mouse (spec section 2.1). A phone
 * has neither, so it is given the one thing a phone is good for: flying the
 * free camera of `docs/dev-tooling.md` over the city and looking at it. This
 * file is the arithmetic of that — whether the browser is a touch one, where a
 * dragged thumb puts a virtual stick, and what a pinch asks of the speed — so
 * it is tested without a DOM. `touch-fly.ts` is the pad it drives and
 * `touch-bar.ts` the buttons beside it.
 */

/** What the browser is asked about itself. `readTouchProbe` reads it. */
export interface TouchProbe {
  /** Fingers the screen reports. A mouse-only machine reports none. */
  maxTouchPoints: number;
  /** True where `(pointer: coarse)` matches: the primary pointer is a finger. */
  coarse: boolean;
}

/**
 * Whether the game should offer the touch controls rather than the keys.
 *
 * Both halves are needed. A touchscreen laptop reports fingers and still has a
 * mouse, and its primary pointer is fine, so it is played with the keys; an
 * iPad claims to be a desktop in every other way and is caught by the fingers.
 */
export function isTouchDevice(probe: TouchProbe): boolean {
  return probe.maxTouchPoints > 0 && probe.coarse;
}

/** Ask the browser the two questions {@link isTouchDevice} answers from. */
export function readTouchProbe(win: Window): TouchProbe {
  return {
    maxTouchPoints: win.navigator.maxTouchPoints ?? 0,
    coarse: win.matchMedia('(pointer: coarse)').matches,
  };
}

/**
 * How far the thumb may carry the stick from where it went down, in CSS
 * pixels. Past this the stick is held at full and the thumb may wander: a
 * thumb on a phone is not accurate, and a stick that stops answering because
 * the finger slid a centimetre reads as the game having lost the touch.
 */
export const STICK_RADIUS = 48;

/**
 * The share of the radius that counts as no movement at all. A thumb resting
 * on the glass drifts by a pixel or two, and without this the camera creeps.
 */
export const STICK_DEAD = 0.18;

/** A stick, as the free camera reads one: -1 to 1 each way, `y` up the screen. */
export interface StickVector {
  x: number;
  y: number;
}

/**
 * Where a thumb `dx`, `dy` pixels from where it went down puts the stick.
 *
 * The dead zone is taken out of the length rather than out of each axis, or a
 * stick pushed straight up would answer while one pushed diagonally by the
 * same distance did not. What is left is stretched back over the whole range,
 * so the first pixel past the dead zone is the slowest movement rather than a
 * jump to a fifth of the speed.
 *
 * `y` is turned over on the way out: the screen counts pixels downwards and
 * the camera counts forward as up.
 */
export function stickVector(dx: number, dy: number, radius = STICK_RADIUS): StickVector {
  const length = Math.hypot(dx, dy);
  if (length <= radius * STICK_DEAD) return { x: 0, y: 0 };
  const pushed = Math.min(1, (length / radius - STICK_DEAD) / (1 - STICK_DEAD));
  const scale = pushed / length;
  return { x: dx * scale, y: -dy * scale };
}

/**
 * How much faster a drag turns the view than a mouse under pointer lock does.
 *
 * A mouse may be picked up and put down again, so a slow one still crosses the
 * whole view. A thumb has the screen and nothing more, and half of that is the
 * stick, so its pixels have to be worth more.
 */
export const TOUCH_LOOK_GAIN = 1.8;

/**
 * The wheel notches a pinch from `from` pixels apart to `to` asks the camera's
 * speed for. Fingers spreading is faster, which is the way a map zooms in.
 *
 * `SPEED_STEP` in `render/camera/free-camera.ts` is what a notch multiplies by, so
 * this is the logarithm in that base: a pinch that doubles the gap asks for as
 * many notches as it takes to double the speed, whatever the step is set to.
 */
export function pinchNotches(from: number, to: number, step: number): number {
  // A NaN gap is no pinch either, so it is asked for before the sizes.
  if (Number.isNaN(from) || Number.isNaN(to) || from <= 0 || to <= 0 || step <= 1) return 0;
  return Math.log(to / from) / Math.log(step);
}
