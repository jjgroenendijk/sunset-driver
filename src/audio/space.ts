/**
 * Where a sound stands, heard from where the player is (spec section 15).
 *
 * Every sound in the game carries a point on the map, and this is the one place
 * that turns such a point into what the mixer wants: a gain and a pan. Nothing
 * here touches Tone.js or the Web Audio node graph, so the whole of it runs in
 * a test.
 *
 * The camera of spec section 10.7 never yaws — `CAMERA_HEADING` in
 * `render/camera/camera.ts` is a constant — so the screen's right is always the map's
 * `+x` and the pan is the sideways offset alone. A sound a long way ahead and a
 * little to the right belongs near the middle, which is why the offset is
 * measured against a fixed width rather than against the distance.
 */

/** Where the player is listening from: their place on the map. */
export interface Listener {
  x: number;
  y: number;
}

/**
 * Metres within which a sound is at its own full strength. Below this the
 * inverse-distance law would run away: the player's own engine sits at a
 * distance of nothing.
 */
export const NEAR = 5;

/** Metres beyond which a sound is not worth a voice at all. */
export const FAR = 160;

/**
 * Metres to either side that fill the stereo field. It is about the width of
 * what the camera shows, so a sound at the edge of the screen is at the edge of
 * the mix.
 */
export const PAN_WIDTH = 26;

/**
 * The share of the reach over which the tail is faded out. Without it a voice
 * dropped at {@link FAR} would be cut off mid-sound; with it, anything dropped
 * there was already silent.
 */
const FADE = 0.3;

/** How a sound at a point reaches the listener. */
export interface Heard {
  /** 0 to 1 of the sound's own strength. */
  gain: number;
  /** -1 hard left to 1 hard right. */
  pan: number;
  /** Metres from the listener, which is what decides which voices are worth having. */
  distance: number;
}

/** What a sound at `(x, y)` is worth to a listener, and which side of them it is on. */
export function hear(listener: Listener, x: number, y: number, far = FAR): Heard {
  const dx = x - listener.x;
  const dy = y - listener.y;
  const distance = Math.hypot(dx, dy);
  const pan = Math.max(-1, Math.min(1, dx / PAN_WIDTH));
  return { gain: rolloff(distance, far), pan, distance };
}

/**
 * The distance attenuation on its own: inverse distance from {@link NEAR} out,
 * faded to nothing over the last {@link FADE} of the reach.
 */
export function rolloff(distance: number, far = FAR): number {
  if (distance >= far) return 0;
  const near = NEAR / Math.max(NEAR, distance);
  const tail = Math.min(1, (far - distance) / (far * FADE));
  return near * tail;
}
