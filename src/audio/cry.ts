/**
 * The human cries of spec section 15: the scream of somebody hit, the short
 * cry of the dying, the moan of the wounded and the panic of a crowd.
 *
 * Spec section 1.2 forbids audio files, so a cry is a voice built from parts,
 * the way speech synthesis builds one. A buzzing source at the pitch of the
 * voice goes through three band-pass filters at the formants of a vowel, with
 * a breath of noise over it. What makes it a cry rather than a note is here:
 * the pitch strained well above speech, the glide up and down, the vibrato,
 * the small unsteady wobble, and the vowel opening from 'a' to 'o'.
 *
 * This file is pure. It says what a cry is and answers its pitch curve as
 * plain numbers, so a test can read it with no Web Audio context;
 * `cries.ts` is the only file that turns one into sound.
 */
import { hashInts } from '../core/hash.ts';
import { rngFor, Subsystem } from '../core/rng.ts';
import { FAR } from './space.ts';

/** The cries a person makes. Nothing else should name them. */
export type CryKind = 'scream' | 'pain' | 'death' | 'moan' | 'panic';

/** The vowels a cry is shaped from. */
export type Vowel = 'a' | 'o';

/**
 * The first three formants of each vowel, in hertz, for an adult male voice.
 * A higher voice scales them up by its own `formant`.
 */
export const VOWELS: Readonly<Record<Vowel, readonly [number, number, number]>> = Object.freeze({
  a: [800, 1150, 2900],
  o: [450, 800, 2830],
});

/** What each formant is worth against the first. The higher ones are quieter, as in speech. */
export const FORMANT_GAIN: readonly [number, number, number] = [1, 0.55, 0.28];

/**
 * The width of each formant's band, in hertz. A filter's Q is its frequency
 * over this. A cry is rough, so the bands are wider than a sung vowel's.
 */
export const FORMANT_WIDTH: readonly [number, number, number] = [110, 130, 190];

/** How one kind of cry goes: its length, its envelope, its pitch contour and its vowels. */
export interface CryShape {
  /** Seconds, for a voice whose own `length` is 1. */
  length: number;
  /** Seconds of the attack, and of the fade at the end. */
  attack: number;
  release: number;
  /** True for a cry that is cut off rather than let go: the fade is a few milliseconds. */
  cut: boolean;
  /** The pitch at the start, at the peak and at the end, as factors of the speaking voice. */
  start: number;
  peak: number;
  end: number;
  /** Where in the cry the pitch peaks, 0 to 1. */
  peakAt: number;
  /** The vowel it opens on and the one it closes on. */
  from: Vowel;
  to: Vowel;
  /** What the cry is worth at full strength, 0 to 1. */
  gain: number;
  /** How much breath is in it, against the voice's own. */
  breath: number;
  /** 0 to 1: how much of the treble the distance has already taken off. 1 is none. */
  clear: number;
}

/**
 * The shape of each cry. A scream is strained to more than twice the speaking
 * pitch, which is what it is in life; a moan hardly leaves speech.
 */
export const CRIES: Readonly<Record<CryKind, CryShape>> = Object.freeze({
  // The long cry at a hit that puts somebody down: up fast, held, falling
  // away, and closing from 'a' to 'o' as the breath runs out.
  scream: { length: 1.35, attack: 0.05, release: 0.4, cut: false, start: 2, peak: 2.7, end: 1.85, peakAt: 0.18, from: 'a', to: 'o', gain: 1, breath: 1, clear: 1 },
  // A short cry of pain at a blow that does not put them down: "ah!".
  pain: { length: 0.38, attack: 0.02, release: 0.2, cut: false, start: 1.9, peak: 2.25, end: 1.35, peakAt: 0.14, from: 'a', to: 'o', gain: 0.8, breath: 0.8, clear: 1 },
  // The dying make one short cry, and it stops.
  death: { length: 0.3, attack: 0.015, release: 0.025, cut: true, start: 1.8, peak: 2.35, end: 2.05, peakAt: 0.35, from: 'a', to: 'a', gain: 0.9, breath: 0.6, clear: 1 },
  // The wounded on the ground: low, slow and mostly breath.
  moan: { length: 0.85, attack: 0.14, release: 0.4, cut: false, start: 1.15, peak: 1.32, end: 0.92, peakAt: 0.3, from: 'o', to: 'o', gain: 0.45, breath: 1.6, clear: 0.8 },
  // A person of a fleeing crowd: high and short, and heard from further off.
  panic: { length: 0.7, attack: 0.04, release: 0.25, cut: false, start: 2.1, peak: 2.6, end: 2.2, peakAt: 0.3, from: 'a', to: 'a', gain: 0.9, breath: 0.9, clear: 0.6 },
});

/** One person's voice, which every cry they make is played in. */
export interface CryVoice {
  /** Hertz of their speaking voice. A cry strains it by its shape's factors. */
  base: number;
  /** What their formants are scaled by: above 1 for a higher, smaller voice. */
  formant: number;
  /** Hertz of the vibrato, and how deep it is as a share of the pitch. */
  vibrato: number;
  depth: number;
  /** What every cry of theirs is stretched by. */
  length: number;
  /** How breathy the voice is, 0 to 1. */
  breath: number;
}

/** One cry to make, once, at a place on the map. */
export interface Cry {
  kind: CryKind;
  /** Where it happens, in map metres. */
  x: number;
  y: number;
  /** 0 to 1 of the shape's own gain. */
  strength: number;
  /** Seconds after the frame the cry starts at, so a crowd does not cry as one. */
  delay: number;
  voice: CryVoice;
  /** The stream the cry's wobble is drawn from, so a replay wobbles the same way. */
  take: number;
}

/** Points per second of the pitch curve. Enough to draw a vibrato of seven hertz smoothly. */
export const CURVE_RATE = 100;

/** Seconds between two points of the wobble, and how far it strays, as a share of the pitch. */
const WOBBLE_STEP = 0.05;
const WOBBLE = 0.018;

/** Seconds the vibrato takes to come in: a cry starts steady and shakes as it is held. */
const VIBRATO_ONSET = 0.2;

/** The keys of the streams a voice and a take are drawn from. */
const VOICE_STREAM = 0x0c41;
const TAKE_STREAM = 0x0c42;

/**
 * The voice of person `id`, the same every time they cry. Half the crowd has a
 * low voice and half a high one, and each has its own pitch, vibrato and
 * length inside that.
 */
export function voiceOf(seed: number, id: number): CryVoice {
  const rng = rngFor(seed, 0, Subsystem.Audio, hashInts(VOICE_STREAM, id));
  const high = rng.chance(0.5);
  return {
    base: high ? rng.range(175, 255) : rng.range(95, 150),
    formant: high ? rng.range(1.1, 1.22) : rng.range(0.94, 1.04),
    vibrato: rng.range(4.5, 7.2),
    depth: rng.range(0.015, 0.05),
    length: rng.range(0.8, 1.25),
    breath: rng.range(0.08, 0.3),
  };
}

/** The stream of one cry of person `id` on `tick`. */
export function takeOf(seed: number, tick: number, id: number): number {
  return hashInts(seed, tick, TAKE_STREAM, id);
}

/** A cry of person `id`, heard at a place. */
export function cryOf(
  seed: number,
  tick: number,
  kind: CryKind,
  id: number,
  x: number,
  y: number,
  strength: number,
  delay = 0,
): Cry {
  return { kind, x, y, strength, delay, voice: voiceOf(seed, id), take: takeOf(seed, tick, id) };
}

/** Seconds a cry lasts, from its start to the end of its fade. */
export function cryLength(cry: Cry): number {
  return CRIES[cry.kind].length * cry.voice.length;
}

/**
 * The pitch contour at `u`, 0 to 1 through the cry, as a factor of the
 * speaking voice: up to the peak quickly, then down to the end more slowly.
 */
export function contourAt(shape: CryShape, u: number): number {
  if (u <= shape.peakAt) {
    const v = shape.peakAt > 0 ? u / shape.peakAt : 1;
    return shape.start + (shape.peak - shape.start) * (1 - (1 - v) * (1 - v));
  }
  const v = (u - shape.peakAt) / Math.max(1e-6, 1 - shape.peakAt);
  return shape.peak + (shape.end - shape.peak) * v * Math.sqrt(v);
}

/**
 * The pitch of a cry over its length, in hertz, {@link CURVE_RATE} points a
 * second: the contour of its shape, a vibrato that comes in as it is held, and
 * a wobble drawn from the cry's own stream. The wobble is what keeps it from
 * sounding like a siren: a voice under strain never holds a note straight.
 */
export function cryCurve(cry: Cry): number[] {
  const shape = CRIES[cry.kind];
  const length = cryLength(cry);
  const steps = Math.max(2, Math.ceil(length * CURVE_RATE) + 1);
  const rng = rngFor(cry.take, 0, Subsystem.Audio, 0);
  const knots: number[] = [];
  for (let k = 0; k <= Math.ceil(length / WOBBLE_STEP) + 1; k++) knots.push(rng.range(-WOBBLE, WOBBLE));
  const voice = cry.voice;
  const curve: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / (steps - 1)) * length;
    const at = t / WOBBLE_STEP;
    const k = Math.floor(at);
    const a = knots[k] ?? 0;
    const b = knots[k + 1] ?? a;
    const wobble = a + (b - a) * (at - k);
    const vibrato = voice.depth * Math.min(1, t / VIBRATO_ONSET) * Math.sin(2 * Math.PI * voice.vibrato * t);
    curve.push(voice.base * contourAt(shape, t / length) * (1 + vibrato + wobble));
  }
  return curve;
}

/** The formants of a vowel in a voice, in hertz. */
export function formantsOf(vowel: Vowel, voice: CryVoice): [number, number, number] {
  const f = VOWELS[vowel];
  return [f[0] * voice.formant, f[1] * voice.formant, f[2] * voice.formant];
}

/**
 * Hertz of the low-pass a cry is heard through at a distance. Air takes the
 * treble off first, so a scream across the street is duller as well as quieter.
 */
export function muffleOf(distance: number, clear = 1): number {
  const far = Math.min(1, Math.max(0, distance) / FAR);
  return Math.max(900, 9000 * (1 - 0.75 * far) * clear);
}
