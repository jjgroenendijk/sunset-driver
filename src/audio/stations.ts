/**
 * The dial: the radio stations of spec section 15, one per culture of spec
 * section 8.3 and a citywide station over the lot.
 *
 * A station is a table of numbers, not a recording — spec section 1.2 forbids
 * audio files, so every station is what its numbers make `song.ts` play. What
 * makes two stations sound unlike each other is all here: the key and the mode
 * they work in, the tempo, the chords they turn over, the shape of the drums,
 * and which voice carries the tune.
 *
 * Nothing in this file makes a sound and nothing reads the record.
 */
import type { Culture } from '../world/types.ts';

/** The voice a part is played on. `radio.ts` is what builds each one. */
export type Part = 'bass' | 'chord' | 'lead' | 'kick' | 'snare' | 'hat';

/**
 * The scale a station works in, as semitones above the key. Seven notes where
 * the music leans on a mode, five where it leans on a pentatonic, which is what
 * keeps a generated tune from wandering into a wrong note.
 */
export const MODES = Object.freeze({
  /** The minor everything leans on when it wants to sound like a city at night. */
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  /** A minor with a bright sixth: the mode of a lot of soul and a lot of funk. */
  dorian: [0, 2, 3, 5, 7, 9, 10],
  /** A major with a flat seventh, which is most folk music with a fiddle in it. */
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  /** The augmented second is what makes it sound east of here. */
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  /** Five notes, no semitones: nothing played over it can be wrong. */
  pentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
} as const);

export type ModeName = keyof typeof MODES;

/** How the drums of a station are laid out over the sixteen steps of a bar. */
export interface DrumFeel {
  /** Steps the kick lands on. */
  kick: readonly number[];
  /** Steps the snare lands on. The backbeat is 4 and 12. */
  snare: readonly number[];
  /** Every how many steps the hat ticks. 2 is eighths, 1 sixteenths, 0 none. */
  hat: number;
  /**
   * How far the off-beats are pushed late, 0 to 0.5 of a step. Swing is what
   * separates a shuffle from a machine, and a station that has none is square
   * on purpose.
   */
  swing: number;
}

/** One station of the dial. */
export interface Station {
  /** What it is called on the HUD. */
  name: string;
  /** The neighbourhood it belongs to (spec section 8.3), or 'none' for the citywide one. */
  culture: Culture;
  /** A line for the station ident between songs. */
  slogan: string;
  /** Beats a minute. */
  tempo: number;
  mode: ModeName;
  /** The key, as a MIDI note. The bass plays two octaves under it. */
  key: number;
  /**
   * The chords a song turns over, as degrees of the mode counted from 0. Four
   * or eight bars, because that is how long a listener's memory is.
   */
  progression: readonly number[];
  drums: DrumFeel;
  /** The waveform each part is played on, which is most of what a station sounds like. */
  voices: Readonly<Record<'bass' | 'chord' | 'lead', OscillatorType>>;
  /**
   * How busy the lead is, 0 for a station that mostly vamps and 1 for one that
   * never stops. It is the chance a step gets a note.
   */
  density: number;
}

/** The waveforms a part may be played on. Tone.js names them. */
export type OscillatorType = 'sine' | 'triangle' | 'sawtooth' | 'square';

/** Steps one bar is divided into: sixteenths, which every feel here is written in. */
export const STEPS = 16;

/**
 * The dial, in the order the tune key walks it. The citywide station is first,
 * because it is the one a car is tuned to when nobody has touched the dial.
 *
 * Every culture of spec section 8.3 has a station, so a neighbourhood's own
 * music is somewhere on the dial of every car driven through it.
 */
export const STATIONS: readonly Station[] = [
  {
    name: 'Sunset FM',
    culture: 'none',
    slogan: 'the city, all night',
    tempo: 108,
    mode: 'aeolian',
    key: 57,
    progression: [0, 5, 3, 4],
    drums: { kick: [0, 6, 8, 14], snare: [4, 12], hat: 2, swing: 0 },
    voices: { bass: 'square', chord: 'sawtooth', lead: 'triangle' },
    density: 0.4,
  },
  {
    name: 'KSRF Boardwalk',
    culture: 'beach',
    slogan: 'nothing to do and all day to do it',
    tempo: 118,
    mode: 'ionian',
    key: 62,
    progression: [0, 3, 4, 3],
    drums: { kick: [0, 8], snare: [4, 12], hat: 2, swing: 0.12 },
    voices: { bass: 'triangle', chord: 'triangle', lead: 'sawtooth' },
    density: 0.5,
  },
  {
    name: 'Radio Vesuvio',
    culture: 'italian',
    slogan: 'the old songs, the old way',
    tempo: 96,
    mode: 'ionian',
    key: 60,
    progression: [0, 4, 5, 1],
    drums: { kick: [0, 8], snare: [12], hat: 4, swing: 0.2 },
    voices: { bass: 'sine', chord: 'sawtooth', lead: 'triangle' },
    density: 0.35,
  },
  {
    name: 'Jade Harbour Radio',
    culture: 'chinese',
    slogan: 'from the harbour to the hills',
    tempo: 92,
    mode: 'pentatonic',
    key: 64,
    progression: [0, 4, 2, 0],
    drums: { kick: [0, 10], snare: [8], hat: 4, swing: 0 },
    voices: { bass: 'sine', chord: 'sine', lead: 'triangle' },
    density: 0.45,
  },
  {
    name: 'Kolomna Nights',
    culture: 'east-european',
    slogan: 'we came a long way to be here',
    tempo: 132,
    mode: 'harmonicMinor',
    key: 55,
    progression: [0, 0, 5, 4],
    drums: { kick: [0, 4, 8, 12], snare: [4, 12], hat: 1, swing: 0 },
    voices: { bass: 'sawtooth', chord: 'square', lead: 'sawtooth' },
    density: 0.6,
  },
  {
    name: 'La Palma',
    culture: 'latin',
    slogan: 'the street is the dance floor',
    tempo: 104,
    mode: 'dorian',
    key: 59,
    progression: [0, 3, 4, 3],
    drums: { kick: [0, 3, 6, 10], snare: [4, 12], hat: 2, swing: 0.1 },
    voices: { bass: 'square', chord: 'triangle', lead: 'square' },
    density: 0.65,
  },
  {
    name: 'WGRV Groove',
    culture: 'african-american',
    slogan: 'keep it moving',
    tempo: 98,
    mode: 'minorPentatonic',
    key: 53,
    progression: [0, 0, 3, 4],
    drums: { kick: [0, 7, 10], snare: [4, 12], hat: 1, swing: 0.16 },
    voices: { bass: 'square', chord: 'sawtooth', lead: 'square' },
    density: 0.55,
  },
  {
    name: 'Blacktop 66',
    culture: 'outlaw',
    slogan: 'louder than the law',
    tempo: 126,
    mode: 'minorPentatonic',
    key: 52,
    progression: [0, 0, 4, 3],
    drums: { kick: [0, 6, 8, 14], snare: [4, 12], hat: 2, swing: 0 },
    voices: { bass: 'sawtooth', chord: 'sawtooth', lead: 'sawtooth' },
    density: 0.5,
  },
  {
    name: 'Shamrock Line',
    culture: 'irish',
    slogan: 'a long way from the water',
    tempo: 116,
    mode: 'mixolydian',
    key: 62,
    progression: [0, 6, 3, 4],
    drums: { kick: [0, 6, 8], snare: [4, 12], hat: 2, swing: 0.18 },
    voices: { bass: 'triangle', chord: 'square', lead: 'sawtooth' },
    density: 0.7,
  },
];

/** Where a station stands on the dial, or -1 for a culture with no station. */
export function stationOfCulture(culture: Culture): number {
  return STATIONS.findIndex((station) => station.culture === culture);
}

/** The station at a place on the dial. The dial does not wrap here; `radio.ts` does that. */
export function stationAt(dial: number): Station | undefined {
  return STATIONS[dial];
}

/** The notes of a chord of the station's mode, as MIDI offsets from the key. */
export function chordOf(station: Station, degree: number): number[] {
  const scale = MODES[station.mode];
  const size = scale.length;
  const note = (step: number): number => {
    const at = ((step % size) + size) % size;
    return (scale[at] as number) + 12 * Math.floor(step / size);
  };
  // A triad is every other note of the mode, which is what a chord is in any
  // of them: the root, the third above it and the fifth above that.
  return [note(degree), note(degree + 2), note(degree + 4)];
}
