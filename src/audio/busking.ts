/**
 * The buskers of spec section 20.1, heard: the notes of a guitar from the
 * corner where one stands.
 *
 * A busker is out on a corner for the hours `sim/corners.ts` gives them, so
 * whether one is playing is a function of the seed and the tick, and so is
 * each note. A note is drawn per tick, over every tick a frame stepped, from a
 * pentatonic scale, so what is played never clashes with itself and two
 * machines on the same tick hear the same tune.
 */
import { rngFor, Subsystem } from '../core/rng.ts';
import type { Cue } from './cue.ts';

/** A busker playing: where they stand, and who they are. */
export interface Busker {
  id: number;
  x: number;
  y: number;
}

/** What the planner needs of the occupied corners. `StreetCorners` is it. */
export interface BuskerSource {
  buskers(x: number, y: number, tick: number, out: Busker[]): Busker[];
}

/** The chance a busker plucks a note on a tick: about three a second. */
export const PLUCK_RATE = 0.05;

/** The most buskers heard at once, nearest first. */
const HEARD = 2;

/** The notes of the scale, as factors of the pluck's own pitch: a major pentatonic over two octaves. */
const SCALE = [0.75, 0.84, 0.94, 1, 1.12, 1.26, 1.5, 1.68];

/** The stream each busker's notes are drawn from, kept off every other entity id of the audio. */
const PLUCK_STREAM = -0x2000;

const found: Busker[] = [];

/** Push the notes the buskers near `x, y` played on the ticks after `was` up to `tick`. */
export function plucks(seed: number, was: number, tick: number, x: number, y: number, source: BuskerSource, cues: Cue[]): void {
  source.buskers(x, y, tick, found);
  found.sort((a, b) => (a.x - x) ** 2 + (a.y - y) ** 2 - ((b.x - x) ** 2 + (b.y - y) ** 2) || a.id - b.id);
  const heard = Math.min(HEARD, found.length);
  for (let t = was + 1; t <= tick; t++) {
    for (let i = 0; i < heard; i++) {
      const busker = found[i] as Busker;
      const rng = rngFor(seed, t, Subsystem.Audio, PLUCK_STREAM - busker.id);
      if (!rng.chance(PLUCK_RATE)) continue;
      const note = SCALE[rng.int(0, SCALE.length - 1)] as number;
      cues.push({ kind: 'pluck', x: busker.x, y: busker.y, strength: rng.range(0.6, 1), pitch: note });
    }
  }
}
