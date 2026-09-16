/**
 * The music itself: one bar of a station's song, as notes (spec section 15).
 *
 * Every station on the dial plays songs nobody wrote down. A song is a seed and
 * a number of bars; this turns a bar of one into the notes to play, from the
 * station's table in `stations.ts` and nothing else. It is pure and it holds no
 * Tone.js, so what the radio plays is read in a test rather than by ear, and a
 * session's radio is the same radio every time that seed is played.
 *
 * The rules are the ones a band would use: the bass follows the kick and the
 * root of the chord, the chord lands where the bar turns over, and the tune
 * walks the station's own mode, leaning on a note of the chord wherever the
 * beat is strong. What differs between two stations is the table, not this.
 */
import { rngFor, Subsystem } from '../core/rng.ts';
import { chordOf, MODES, STEPS, type Part, type Station } from './stations.ts';

/** One note to play. Times are in steps of a bar; `radio.ts` turns them into seconds. */
export interface Note {
  part: Part;
  /** Where in the bar it starts, in steps. Swing has already been folded in. */
  step: number;
  /** MIDI note. A drum part carries the step's own pitch, which its voice may ignore. */
  note: number;
  /** How long it lasts, in steps. */
  length: number;
  /** How hard it is struck, 0 to 1. */
  velocity: number;
}

/** Bars a song runs for before the programme moves on. */
export const SONG_BARS = 32;

/** Where the bass sits under the key, and where the tune sits over it, in octaves. */
const BASS_OCTAVE = -2;
const LEAD_OCTAVE = 1;

/** The steps of a bar a listener hears as strong, which is where the tune leans on the chord. */
const STRONG = [0, 4, 8, 12];

/** How hard each part is struck, before the station's own dynamics. */
const VELOCITY: Record<Part, number> = { bass: 0.9, chord: 0.5, lead: 0.7, kick: 1, snare: 0.85, hat: 0.35 };

/** The part of a note, as the random streams are keyed. */
const PART_KEY: Record<Part, number> = { bass: 0, chord: 1, lead: 2, kick: 3, snare: 4, hat: 5 };

/**
 * The notes of one bar. `song` numbers the song on that station and `bar` the
 * bar within it, so the same bar of the same song of the same seed is always
 * the same music — which is what makes a station something a player can come
 * to know rather than noise that never repeats.
 */
export function barOf(seed: number, station: Station, song: number, bar: number): Note[] {
  const out: Note[] = [];
  const degree = station.progression[bar % station.progression.length] as number;
  const chord = chordOf(station, degree);
  const root = (chord[0] as number) + station.key;
  drums(station, song, bar, seed, out);
  bass(station, root, out);
  chords(station, chord, out);
  lead(seed, station, song, bar, chord, out);
  return out;
}

/** The kick, the snare and the hat of the station's own feel, with its swing on the off-beats. */
function drums(station: Station, song: number, bar: number, seed: number, out: Note[]): void {
  const feel = station.drums;
  for (const step of feel.kick) out.push(note('kick', swung(step, feel.swing), 36, 1, VELOCITY.kick));
  for (const step of feel.snare) out.push(note('snare', swung(step, feel.swing), 38, 1, VELOCITY.snare));
  if (feel.hat <= 0) return;
  const rng = rngFor(seed, song * 1024 + bar, Subsystem.Music, PART_KEY.hat);
  for (let step = 0; step < STEPS; step += feel.hat) {
    // A hat that is the same every time is a machine. The accent moves.
    const accent = step % 4 === 0 ? 1 : 0.6 + 0.3 * rng.float();
    out.push(note('hat', swung(step, feel.swing), 42, 1, VELOCITY.hat * accent));
  }
}

/** The bass: the root of the bar's chord, struck where the kick is. */
function bass(station: Station, root: number, out: Note[]): void {
  const feel = station.drums;
  const steps = feel.kick.length > 0 ? feel.kick : [0, 8];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as number;
    const next = (steps[i + 1] as number | undefined) ?? STEPS;
    // A busy station jumps the octave on the off-beats, which is what a funk
    // bass does; a quiet one holds the root.
    const octave = station.density > 0.5 && i % 2 === 1 ? 12 : 0;
    out.push(note('bass', swung(step, feel.swing), root + 12 * BASS_OCTAVE + octave, next - step, VELOCITY.bass));
  }
}

/** The chord, held where the bar turns over and again in the middle of it. */
function chords(station: Station, chord: readonly number[], out: Note[]): void {
  for (const step of [0, 8]) {
    for (const offset of chord) {
      out.push(note('chord', step, station.key + offset, 8, VELOCITY.chord));
    }
  }
}

/**
 * The tune: a walk over the station's mode that leans on a note of the chord
 * wherever the beat is strong, so it never argues with what is under it.
 */
function lead(seed: number, station: Station, song: number, bar: number, chord: readonly number[], out: Note[]): void {
  const scale = MODES[station.mode];
  const rng = rngFor(seed, song * 1024 + bar, Subsystem.Music, PART_KEY.lead);
  // Where the tune stands in the mode, carried from the song's own opening
  // rather than from the bar before, so a bar is a pure function of its number.
  let at = rngFor(seed, song * 1024, Subsystem.Music, PART_KEY.lead).int(0, scale.length - 1);
  for (let step = 0; step < STEPS; step++) {
    const strong = STRONG.includes(step);
    if (!strong && !rng.chance(station.density * 0.5)) continue;
    if (strong) {
      // Land on a note of the chord, which is what makes a walk sound like a tune.
      const pick = chord[rng.int(0, chord.length - 1)] as number;
      at = nearestDegree(scale, pick);
    } else {
      at += rng.int(-2, 2);
    }
    const degree = ((at % scale.length) + scale.length) % scale.length;
    const octave = Math.floor(at / scale.length);
    const pitch = station.key + 12 * (LEAD_OCTAVE + octave) + (scale[degree] as number);
    const length = strong ? 2 : 1;
    out.push(note('lead', swung(step, station.drums.swing), pitch, length, VELOCITY.lead * (strong ? 1 : 0.8)));
  }
}

/** The degree of the mode nearest a semitone offset, which is how a chord note is found in it. */
function nearestDegree(scale: readonly number[], offset: number): number {
  const within = ((offset % 12) + 12) % 12;
  let best = 0;
  let gap = 99;
  for (let i = 0; i < scale.length; i++) {
    const distance = Math.abs((scale[i] as number) - within);
    if (distance < gap) {
      gap = distance;
      best = i;
    }
  }
  return best;
}

/** A step pushed late by the station's swing, where it falls off the beat. */
function swung(step: number, swing: number): number {
  return step % 2 === 1 ? step + swing : step;
}

function note(part: Part, step: number, pitch: number, length: number, velocity: number): Note {
  return { part, step, note: pitch, length, velocity };
}
