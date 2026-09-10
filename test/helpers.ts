import { hashInts } from '../src/core/hash.ts';
import { EMPTY_INPUT, type InputFrame } from '../src/sim/input.ts';

/** Fixed list of seeds for the sweeps; deterministic and spread across the space. */
export function sweepSeeds(count: number): number[] {
  const seeds: number[] = [];
  for (let i = 0; i < count; i++) seeds.push(hashInts(0x5eed, i));
  return seeds;
}

/** A deterministic recorded input stream for a seed. */
export function inputStream(seed: number, ticks: number): InputFrame[] {
  const frames: InputFrame[] = [];
  let x = seed >>> 0;
  for (let i = 0; i < ticks; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    frames.push({
      ...EMPTY_INPUT,
      throttle: ((x >>> 8) & 3) === 0 ? -1 : ((x >>> 8) & 3) === 1 ? 0 : 1,
      steer: ((x >>> 12) % 3) - 1,
      sprint: ((x >>> 16) & 1) === 1,
      handbrake: ((x >>> 20) & 7) === 0,
    });
  }
  return frames;
}

/**
 * Milliseconds of the fastest of `runs` repetitions. Timing on a shared runner
 * only ever gets slower than the truth, so the best run is the honest one.
 */
export function bestOf(runs: number, body: () => void): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    body();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)) {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = o[k];
      return out;
    }
    if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
    return v;
  });
}
