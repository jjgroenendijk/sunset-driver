/**
 * The one-shot sounds of spec section 15 — collisions, gunfire, explosions,
 * footsteps and the swing of a melee weapon — and the recipe each one is
 * synthesised from.
 *
 * Spec section 1.2 forbids audio files, so every one of these is a shape rather
 * than a sample: a tone that falls, a band of noise that closes, an envelope
 * over both. The recipe is plain numbers here so the table can be read, tested
 * and argued about without a Web Audio context; `one-shots.ts` is the only file
 * that turns one into sound.
 */

/** The one-shots the game fires. Nothing else should name them. */
export type CueKind = 'impact' | 'explosion' | 'gunshot' | 'swing' | 'footstep' | 'bell';

/** What one cue is made of: a falling tone, a band of noise, and the envelope over both. */
export interface CueVoice {
  /** Hertz the tone starts at and falls to. Zero on a cue that is noise alone. */
  tone: number;
  toneEnd: number;
  /** How much of the cue is filtered noise, 0 to 1. */
  noise: number;
  /** Hertz the noise's low-pass opens at and closes to. */
  cutoff: number;
  cutoffEnd: number;
  /** Seconds of the attack and of the decay after it. */
  attack: number;
  decay: number;
  /** What the cue is worth at full strength, 0 to 1. */
  gain: number;
  /** True where the cue pulls the music bus down under it (spec section 15). */
  ducks: boolean;
}

/**
 * The recipe of each cue. The numbers are the shape of the sound and nothing
 * else: how loud it ends up is the cue's own strength and how far away it is.
 */
export const CUES: Readonly<Record<CueKind, CueVoice>> = Object.freeze({
  // Metal on metal: a short bright crack over a body that drops away fast.
  impact: { tone: 240, toneEnd: 70, noise: 0.8, cutoff: 5200, cutoffEnd: 420, attack: 0.002, decay: 0.34, gain: 0.9, ducks: true },
  // A long, dark roll. The tone barely moves; the noise is what carries it.
  explosion: { tone: 110, toneEnd: 32, noise: 1, cutoff: 2600, cutoffEnd: 90, attack: 0.004, decay: 1.5, gain: 1, ducks: true },
  // The crack of a round leaving the barrel, all attack and no body.
  gunshot: { tone: 420, toneEnd: 120, noise: 1, cutoff: 7200, cutoffEnd: 700, attack: 0.001, decay: 0.16, gain: 0.8, ducks: true },
  // Air moved by a bat or a blade: noise alone, opening and closing.
  swing: { tone: 0, toneEnd: 0, noise: 1, cutoff: 1800, cutoffEnd: 260, attack: 0.03, decay: 0.16, gain: 0.35, ducks: false },
  // A heel on pavement: quiet, dry and over at once.
  footstep: { tone: 150, toneEnd: 60, noise: 0.7, cutoff: 3000, cutoffEnd: 300, attack: 0.001, decay: 0.09, gain: 0.22, ducks: false },
  // A tram's bell (spec section 13.2): struck metal, so the note barely falls
  // and rings on. The noise is the strike itself and nothing after it.
  bell: { tone: 1046, toneEnd: 988, noise: 0.15, cutoff: 6400, cutoffEnd: 2400, attack: 0.001, decay: 0.85, gain: 0.5, ducks: false },
});

/** One sound to make, once, at a place on the map. */
export interface Cue {
  kind: CueKind;
  /** Where it happens, in map metres. */
  x: number;
  y: number;
  /** 0 to 1 of the recipe's own gain: how hard the hit was, how big the gun is. */
  strength: number;
  /**
   * Shifts the whole recipe in pitch, as a factor either side of 1. A heavy
   * calibre is dark and a light one bright, and the jitter of the seed's own
   * stream is folded in so two of the same cue never land on the same note.
   */
  pitch: number;
}
