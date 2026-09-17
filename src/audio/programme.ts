/**
 * What a station is broadcasting at a given bar (spec section 15): a song, the
 * station's own ident, or one of the harm-reduction announcements of spec
 * section 19.
 *
 * A station's schedule is a pure function of the bar it has been running for,
 * so nothing has to be remembered between frames, a station carries on while
 * nobody is listening to it, and tuning back to one finds it where it would
 * have been. The seed decides which song and which announcement, so two
 * sessions of the same city hear the same broadcast.
 */
import { hashInts } from '../core/hash.ts';
import { psaAt, type Psa } from './psa.ts';
import { SONG_BARS } from './song.ts';
import { STATIONS, type Station } from './stations.ts';

/** Bars of the break between two songs, where the ident or the announcement goes. */
export const BREAK_BARS = 4;

/** Bars one song and the break after it take together. */
export const BLOCK_BARS = SONG_BARS + BREAK_BARS;

/** How many songs a station gets through between two announcements. */
export const PSA_EVERY = 3;

/** What is going out. */
export type OnAir = 'song' | 'ident' | 'psa';

/** One bar of a station's schedule. */
export interface Broadcast {
  kind: OnAir;
  /** The song the composer should be playing, and the bar within it. */
  song: number;
  /** The bar within the song, or within the break. */
  bar: number;
  /** The line the HUD shows, empty while a song is playing. */
  text: string;
  /** Who the line is from, empty where it is the station itself. */
  from: string;
}

/**
 * What station `dial` is broadcasting on `bar`, counted from the moment the
 * session started.
 *
 * A block is a song and the break after it. The break is the station's ident
 * most of the time and one of the announcements of spec section 19 every
 * {@link PSA_EVERY} songs, so the information comes round often enough to be
 * heard and rarely enough not to be a lecture.
 */
export function broadcastAt(seed: number, dial: number, bar: number): Broadcast {
  const station = STATIONS[dial] as Station;
  const block = Math.floor(bar / BLOCK_BARS);
  const within = bar - block * BLOCK_BARS;
  // The songs of a station are its own: the seed and the dial pick which of the
  // endless number of them this block plays.
  const song = hashInts(seed, dial * 7919 + block) >>> 8;
  if (within < SONG_BARS) return { kind: 'song', song, bar: within, text: '', from: '' };
  if ((block + dial) % PSA_EVERY === PSA_EVERY - 1) {
    const psa: Psa = psaAt(hashInts(seed, block * 31 + dial) >>> 16);
    return { kind: 'psa', song, bar: within - SONG_BARS, text: psa.line, from: psa.from };
  }
  return { kind: 'ident', song, bar: within - SONG_BARS, text: `${station.name} — ${station.slogan}`, from: '' };
}
