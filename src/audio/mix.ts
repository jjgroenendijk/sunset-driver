/**
 * The mix of spec section 15: how far a sound carries, where it sits across the
 * stereo field, how far the bed ducks under a key event, and how many voices
 * the mixer will pay for at once.
 *
 * All of it is arithmetic on plain numbers, so the rules are tested headless
 * and the Tone.js half (`tone-sink.ts`) only ever applies what is decided here.
 * The ear is the player: the camera of spec section 10.7 looks straight down at
 * them and never turns, so the map's `x` runs left to right across the screen
 * and is the pan, and the distance on the map is the distance to the ear.
 */

/** Everything the mix places in the world carries one of these labels. */
export type SoundKind =
  | 'engine'
  | 'siren'
  | 'rotor'
  | 'squeal'
  | 'fire'
  | 'horn'
  | 'gunshot'
  | 'melee'
  | 'impact'
  | 'explosion'
  | 'footstep'
  | 'landing'
  | 'bell';

/**
 * Metres each kind carries, past which it is not heard at all and takes no
 * voice. They are what the thing is worth hearing from rather than physics: a
 * siren is the point of a chase, so it reaches across a district, and a
 * footstep belongs to the player alone.
 */
export const REACH: Record<SoundKind, number> = {
  engine: 90,
  siren: 260,
  rotor: 340,
  squeal: 80,
  fire: 70,
  horn: 140,
  gunshot: 240,
  melee: 40,
  impact: 200,
  explosion: 420,
  footstep: 14,
  landing: 25,
  bell: 150,
};

/**
 * Metres within which a sound is at full gain. Inside a car or a few steps
 * away, nothing should fade with a step taken; the fall starts outside it.
 */
export const NEAR = 6;

/**
 * How far the mix pans, 0 for the middle and 1 for one side alone. Pushed all
 * the way over, a sound just off screen is heard in one ear only, which is
 * tiring over a session.
 */
export const PAN_WIDTH = 0.75;

/**
 * What one sound is heard at, 0 to 1, at `distance` metres from the ear.
 *
 * Within {@link NEAR} it is at full gain. Past that it falls off with the
 * distance, as sound does, and is taken to nothing at its reach: a voice that
 * merely became quiet would be paid for for ever, and a sound that stopped
 * dead at its reach would click.
 */
export function attenuation(distance: number, reach: number): number {
  if (distance >= reach) return 0;
  if (distance <= NEAR) return 1;
  const fall = NEAR / distance;
  const edge = 1 - distance / reach;
  return fall * edge;
}

/**
 * Where a sound sits across the stereo field, -1 at the left and 1 at the
 * right. `dx` is how far it stands to the player's right on the map, which is
 * to the right on screen; `distance` is how far away it is in total, so a
 * sound directly above the player on the map stays in the middle.
 */
export function panFor(dx: number, distance: number): number {
  if (distance <= 0) return 0;
  return Math.max(-1, Math.min(1, dx / distance)) * PAN_WIDTH;
}

/** One sound as the mix reads it: what it is, where it is, and how big. */
export interface Placed {
  kind: SoundKind;
  x: number;
  y: number;
  /** How hard the sound was made, 0 to 1. It scales the gain and the voice. */
  strength: number;
}

/** What a placed sound comes to at the ear. */
export interface Mixed {
  gain: number;
  pan: number;
}

/** Where the ear is, on the map. It is the player, or the free camera while it is flying. */
export interface Ear {
  x: number;
  y: number;
}

/** Place one sound at the ear: its gain and its pan together. */
export function mixAt(ear: Ear, sound: Placed): Mixed {
  const dx = sound.x - ear.x;
  const dy = sound.y - ear.y;
  const distance = Math.hypot(dx, dy);
  const gain = attenuation(distance, REACH[sound.kind]) * Math.max(0, Math.min(1, sound.strength));
  return { gain, pan: panFor(dx, distance) };
}

/**
 * How far the bed ducks under what is going on, 0 for not at all and 1 for
 * silence (spec section 15). The radio of spec section 15 and the ambient beds
 * ride this bus, so a blast or a shot next to the player takes the music down
 * and lets it back up.
 *
 * It is the loudest key event, not their sum: two explosions are not twice as
 * loud as one, and a chase should not silence the radio altogether.
 */
export const DUCK_BY_KIND: Partial<Record<SoundKind, number>> = {
  explosion: 0.85,
  gunshot: 0.5,
  impact: 0.55,
  siren: 0.35,
};

/** The deepest duck any of these sounds asks for, at the gain each is heard at. */
export function duckFor(sounds: readonly { kind: SoundKind; gain: number }[]): number {
  let deepest = 0;
  for (const sound of sounds) {
    const share = DUCK_BY_KIND[sound.kind];
    if (share === undefined) continue;
    deepest = Math.max(deepest, share * sound.gain);
  }
  return Math.min(1, deepest);
}

/**
 * Voices the mixer will hold at once, over every kind, and one-shots it will
 * start in a single frame (spec section 15: the mixer stays under a CPU
 * budget). Each voice is a handful of oscillators and a filter, and a browser
 * audio thread that runs out of time drops the whole mix, not one sound, so the
 * cap is what keeps a firefight from taking the engine with it.
 */
export const VOICE_CAP = 12;
export const SHOTS_PER_FRAME = 5;

/**
 * The `cap` loudest of `sounds`, loudest first. What is dropped is what would
 * have been heard least, so a cap is met by losing a siren across the district
 * rather than the gunfire at the player's shoulder.
 */
export function loudest<T extends { gain: number }>(sounds: readonly T[], cap: number): T[] {
  const kept = sounds.filter((sound) => sound.gain > 0);
  kept.sort((a, b) => b.gain - a.gain);
  return kept.slice(0, cap);
}
