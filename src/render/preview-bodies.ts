/**
 * The casualties `--bodies` lays into a preview (spec section 11.6): one of
 * each thing a person who has been hit can be doing, in the road ahead of the
 * player. Each record is written as `casualty.ts` would have written it, with
 * its hit dated back so the moment of the picture falls in the phase wanted.
 */
import { FALL_TICKS, RISE_TICKS, type Casualty } from '../sim/casualty-motion.ts';
import type { SimState } from '../sim/simulation.ts';

/** One body to lay: where, ahead of and beside the player, and what it is doing. */
interface Lay {
  ahead: number;
  beside: number;
  /** Ticks since the hit. */
  age: number;
  health: number;
  /** The push, against the way the player faces: 0 pushes them towards the player. */
  turn: number;
  down: number;
  push?: number;
  lift?: number;
  cash?: number;
}

/** Dead on the back, dead on the front, falling, rising, crawling, limping and thrown. */
const LAYS: readonly Lay[] = [
  { ahead: 7, beside: 1.5, age: 600, health: 0, turn: 0, down: -1, cash: 20 },
  { ahead: 10, beside: -1.8, age: 600, health: 0, turn: Math.PI + 0.4, down: -1 },
  { ahead: 5, beside: 3, age: FALL_TICKS / 2, health: 50, turn: 0.3, down: 600 },
  { ahead: 12, beside: 2.5, age: FALL_TICKS + 60 + RISE_TICKS / 2, health: 45, turn: 1.2, down: 60 },
  { ahead: 13, beside: -3.5, age: FALL_TICKS + 60 + 120, health: 10, turn: -1.6, down: 60 },
  { ahead: 4, beside: -3, age: FALL_TICKS + 60 + RISE_TICKS + 90, health: 40, turn: 2, down: 60 },
  { ahead: 16, beside: 0, age: 20, health: 0, turn: Math.PI, down: -1, push: 8, lift: 4 },
];

/** Lay the bodies into the record, before a place facing `heading`. */
export function layBodies(
  record: SimState,
  x: number,
  y: number,
  heading: number,
  heightAt: (x: number, y: number) => number,
  tick: number,
): void {
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  record.pedestrians.casualties = LAYS.map((lay, id): Casualty => {
    const px = x + cos * lay.ahead - sin * lay.beside;
    const py = y + sin * lay.ahead + cos * lay.beside;
    const ground = heightAt(px, py);
    return {
      id,
      since: tick - lay.age,
      first: tick - lay.age,
      cause: lay.lift === undefined ? 'shot' : 'car',
      health: lay.health,
      x: px,
      y: py,
      height: ground,
      rest: ground,
      heading: heading + Math.PI,
      dir: heading + lay.turn,
      push: lay.push ?? 0,
      lift: lay.lift ?? 0,
      reach: 100,
      down: lay.down,
      side: id % 2 === 0 ? 1 : -1,
      cash: lay.cash ?? 0,
      gone: false,
      bumped: -1,
      ragdoll: null,
    };
  });
}
