import { genRng, Subsystem } from '../core/rng.ts';

export const MIN_WORLD_SIZE = 3000;
export const MAX_WORLD_SIZE = 6000;

/** Side length in metres, drawn from the seed and rounded to whole cells. */
export function worldSizeFor(seed: number, cellSize: number): number {
  const rng = genRng(seed, Subsystem.Terrain, 0);
  const raw = rng.range(MIN_WORLD_SIZE, MAX_WORLD_SIZE);
  return Math.round(raw / cellSize) * cellSize;
}
