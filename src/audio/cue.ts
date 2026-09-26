/**
 * The one-shot sounds of spec section 15 — collisions, gunfire, explosions,
 * footsteps, the swing of a melee weapon and the police radio — and the recipe each one is
 * synthesised from.
 *
 * Spec section 1.2 forbids audio files, so every one of these is a shape rather
 * than a sample: a tone that falls, a band of noise that closes, an envelope
 * over both. The recipe is plain numbers here so the table can be read, tested
 * and argued about without a Web Audio context; `one-shots.ts` is the only file
 * that turns one into sound.
 */

import { rngFor, Subsystem } from '../core/rng.ts';
import type { HitSurface } from '../sim/weapons/melee.ts';

/** The one-shots the game fires. Nothing else should name them. */
export type CueKind =
  | 'impact'
  | 'explosion'
  | 'gunshot'
  | 'shotgun'
  | 'rifle'
  | 'magnum'
  | 'suppressed'
  | 'flame'
  | 'launch'
  | 'thunk'
  | 'glass'
  | 'hiss'
  | 'swing'
  | 'thud'
  | 'clang'
  | 'knock'
  | 'thump'
  | 'crunch'
  | 'flesh'
  | 'landing'
  | 'footstep'
  | 'bell'
  | 'bird'
  | 'gull'
  | 'squelch'
  | 'pluck'
  | 'honk';

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
  gunshot: { tone: 420, toneEnd: 120, noise: 1, cutoff: 7200, cutoffEnd: 700, attack: 0.001, decay: 0.16, gain: 1, ducks: true },
  // A shotgun's boom: lower and longer than a pistol's crack, with a heavy
  // body that rolls off after it.
  shotgun: { tone: 180, toneEnd: 55, noise: 1, cutoff: 4200, cutoffEnd: 260, attack: 0.001, decay: 0.42, gain: 1, ducks: true },
  // A rifle round: a hard, bright crack with more tail than a pistol's.
  rifle: { tone: 320, toneEnd: 90, noise: 1, cutoff: 8000, cutoffEnd: 500, attack: 0.001, decay: 0.26, gain: 1, ducks: true },
  // A magnum, a .308 or a .50: the deepest crack, which rolls on longest.
  magnum: { tone: 150, toneEnd: 40, noise: 1, cutoff: 6000, cutoffEnd: 180, attack: 0.001, decay: 0.62, gain: 1, ducks: true },
  // A suppressed shot: a short dry cough, noise alone, with no crack in it.
  suppressed: { tone: 0, toneEnd: 0, noise: 1, cutoff: 2600, cutoffEnd: 300, attack: 0.001, decay: 0.08, gain: 0.5, ducks: false },
  // A flamethrower's roar: a low rumble under a soft band of noise. One comes
  // with every tongue of the stream, and they overlap into one sound.
  flame: { tone: 70, toneEnd: 55, noise: 1, cutoff: 1500, cutoffEnd: 420, attack: 0.05, decay: 0.22, gain: 0.55, ducks: false },
  // A rocket leaving the tube: a rushing whoosh that falls as it goes.
  launch: { tone: 900, toneEnd: 180, noise: 1, cutoff: 3000, cutoffEnd: 600, attack: 0.01, decay: 0.7, gain: 0.9, ducks: true },
  // The hollow bloop of a grenade launcher.
  thunk: { tone: 160, toneEnd: 70, noise: 0.5, cutoff: 900, cutoffEnd: 200, attack: 0.002, decay: 0.15, gain: 0.8, ducks: false },
  // A bottle breaking: high, bright and short, which is how a Molotov lands.
  glass: { tone: 2600, toneEnd: 1900, noise: 0.9, cutoff: 9000, cutoffEnd: 3000, attack: 0.001, decay: 0.25, gain: 0.6, ducks: false },
  // A canister of smoke or gas letting go: a long hiss of high noise.
  hiss: { tone: 0, toneEnd: 0, noise: 1, cutoff: 7000, cutoffEnd: 3500, attack: 0.08, decay: 1.6, gain: 0.4, ducks: false },
  // Air moved by a bat or a blade: noise alone, opening and closing.
  swing: { tone: 0, toneEnd: 0, noise: 1, cutoff: 1800, cutoffEnd: 260, attack: 0.03, decay: 0.16, gain: 0.35, ducks: false },
  // A blow landing on somebody (spec section 11.6): low, soft and dead, with
  // no ring in it at all. It is the body rather than the weapon.
  thud: { tone: 180, toneEnd: 58, noise: 0.85, cutoff: 900, cutoffEnd: 150, attack: 0.003, decay: 0.24, gain: 0.7, ducks: false },
  // The same blow on a body panel: struck metal, so it rings on after the hit.
  clang: { tone: 620, toneEnd: 290, noise: 0.5, cutoff: 6000, cutoffEnd: 900, attack: 0.001, decay: 0.5, gain: 0.7, ducks: false },
  // And on the hard world of kerbs, posts and walls: a short dry knock.
  knock: { tone: 300, toneEnd: 110, noise: 0.7, cutoff: 2600, cutoffEnd: 300, attack: 0.001, decay: 0.18, gain: 0.6, ducks: false },
  // A car striking somebody (spec section 13.1): a heavy, low blow with the
  // weight of a whole body in it, well under a fist's thud.
  thump: { tone: 120, toneEnd: 42, noise: 0.7, cutoff: 750, cutoffEnd: 110, attack: 0.002, decay: 0.32, gain: 0.95, ducks: true },
  // What the same strike does to the front of the car: bumper plastic and a
  // panel giving way. A short, buzzy crack that is over before the thump is.
  crunch: { tone: 540, toneEnd: 170, noise: 1, cutoff: 5200, cutoffEnd: 700, attack: 0.001, decay: 0.14, gain: 0.5, ducks: false },
  // A round going into somebody: a wet, dull slap. Mostly noise, through a
  // low-pass that shuts almost at once, over a low knock with no ring in it.
  flesh: { tone: 110, toneEnd: 48, noise: 1, cutoff: 2600, cutoffEnd: 160, attack: 0.001, decay: 0.09, gain: 0.8, ducks: false },
  // A body meeting the ground after a throw or a fall: dull and low, a sack
  // dropped rather than a blow struck.
  landing: { tone: 95, toneEnd: 38, noise: 0.9, cutoff: 620, cutoffEnd: 90, attack: 0.004, decay: 0.28, gain: 1, ducks: false },
  // A heel on pavement: quiet, dry and over at once.
  footstep: { tone: 150, toneEnd: 60, noise: 0.7, cutoff: 3000, cutoffEnd: 300, attack: 0.001, decay: 0.09, gain: 0.22, ducks: false },
  // A tram's bell (spec section 13.2): struck metal, so the note barely falls
  // and rings on. The noise is the strike itself and nothing after it.
  bell: { tone: 1046, toneEnd: 988, noise: 0.15, cutoff: 6400, cutoffEnd: 2400, attack: 0.001, decay: 0.85, gain: 0.5, ducks: false },
  // A songbird (spec section 15): a short high note that falls away, with a
  // breath of noise in it so it is a bird rather than a beep.
  bird: { tone: 2400, toneEnd: 1850, noise: 0.12, cutoff: 5200, cutoffEnd: 2600, attack: 0.012, decay: 0.13, gain: 0.3, ducks: false },
  // A gull: lower, harsher and longer, and mostly the cry rather than the note.
  gull: { tone: 1250, toneEnd: 820, noise: 0.45, cutoff: 3800, cutoffEnd: 1100, attack: 0.03, decay: 0.42, gain: 0.34, ducks: false },
  // The police radio keyed before a call (spec section 14): a short hiss of
  // static over a thin beep, cut off rather than let go.
  squelch: { tone: 1350, toneEnd: 1300, noise: 0.8, cutoff: 5200, cutoffEnd: 2800, attack: 0.002, decay: 0.12, gain: 0.32, ducks: false },
  // A busker's guitar string (spec section 20.1): a note that holds its pitch
  // and dies away, with a little noise for the pick.
  pluck: { tone: 330, toneEnd: 328, noise: 0.08, cutoff: 3200, cutoffEnd: 700, attack: 0.002, decay: 0.6, gain: 0.3, ducks: false },
  // A car's horn in the traffic (spec section 20.2): a held note that barely
  // falls, with a buzz of noise, fired twice a minor third apart.
  honk: { tone: 370, toneEnd: 362, noise: 0.18, cutoff: 2600, cutoffEnd: 1800, attack: 0.012, decay: 0.38, gain: 0.45, ducks: false },
});

/**
 * The cue a blow of a melee weapon makes, by what it landed on (spec section
 * 11.6). `src/sim/weapons/melee.ts` says which is which; nothing else should map them.
 */
export const HIT_CUES: Readonly<Record<HitSurface, CueKind>> = Object.freeze({
  person: 'thud',
  vehicle: 'clang',
  hard: 'knock',
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

/**
 * A cue at a place, with the jitter of the seed's own stream folded into its
 * pitch. `id` picks the stream, so two cues of one tick land on two notes.
 */
export function cueAt(seed: number, tick: number, kind: CueKind, x: number, y: number, strength: number, id: number): Cue {
  const rng = rngFor(seed, tick, Subsystem.Audio, id);
  return { kind, x, y, strength, pitch: rng.range(0.92, 1.08) };
}
