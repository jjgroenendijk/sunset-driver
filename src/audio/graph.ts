/**
 * The half of the audio that needs Tone.js, loaded by `game-audio.ts` with a
 * dynamic `import()` once the first gesture has unlocked the page's audio. The
 * page's first download holds no Tone.js, and a game that stays muted never
 * fetches it.
 */
import { setContext } from 'tone';
import { Mixer } from './mixer.ts';

/** The context Tone.js was last handed, so it is handed each one once. */
let adopted: AudioContext | null = null;

/**
 * A new node graph on `context`, which the gesture created and resumed before
 * Tone.js was loaded. Tone.js plays through it rather than through one of its
 * own, since a context made outside a gesture may stay suspended. Tone.js makes
 * a context of its own as its module loads; handing it this one closes that.
 */
export function mixerOn(context: AudioContext): Mixer {
  if (adopted !== context) {
    setContext(context, true);
    adopted = context;
  }
  return new Mixer();
}
