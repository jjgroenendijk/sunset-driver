/**
 * The half of the audio that needs Tone.js, loaded by `game-audio.ts` with a
 * dynamic `import()` once the first gesture has unlocked the page's audio. The
 * page's first download holds no Tone.js, and a game that stays muted never
 * fetches it.
 */
import type { IAudioContext } from 'standardized-audio-context';
import { setContext } from 'tone';
import { Mixer } from './mixer.ts';

/** The context Tone.js was last handed, so it is handed each one once. */
let adopted: IAudioContext | null = null;

/**
 * A new node graph on `context`, which the gesture created and resumed before
 * Tone.js was loaded. Tone.js plays through it rather than through one of its
 * own, since a context made outside a gesture may stay suspended. Tone.js makes
 * a context of its own as its module loads; handing it this one closes that.
 * The context must come from `standardized-audio-context`, as `game-audio.ts`
 * says: a native one breaks Tone.js on Firefox.
 */
export function mixerOn(context: IAudioContext): Mixer {
  if (adopted !== context) {
    // Tone.js types a context as the DOM's, though it wraps its own in this
    // library as well.
    setContext(context as unknown as AudioContext, true);
    adopted = context;
  }
  return new Mixer();
}
