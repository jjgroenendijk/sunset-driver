import { pointInRing, ringArea } from '../src/core/geom.ts';
import { hashInts } from '../src/core/hash.ts';
import { Rng } from '../src/core/rng.ts';
import { EMPTY_INPUT, type InputFrame } from '../src/sim/input.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import type { Point, WorldDescription } from '../src/world/types.ts';

export { pointInRing, ringArea };

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

/**
 * True when two closed rings share any ground: an edge of one meets an edge of
 * the other, or one stands wholly inside the other.
 */
export function ringsOverlap(a: readonly Point[], b: readonly Point[]): boolean {
  const boxA = ringBounds(a);
  const boxB = ringBounds(b);
  if (boxA.maxX < boxB.minX || boxB.maxX < boxA.minX) return false;
  if (boxA.maxY < boxB.minY || boxB.maxY < boxA.minY) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as Point;
    const q = a[(i + 1) % a.length] as Point;
    for (let j = 0; j < b.length; j++) {
      if (segmentsMeet(p, q, b[j] as Point, b[(j + 1) % b.length] as Point)) return true;
    }
  }
  return pointInRing(a[0] as Point, b) || pointInRing(b[0] as Point, a);
}

function ringBounds(ring: readonly Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of ring) {
    box.minX = Math.min(box.minX, p.x);
    box.minY = Math.min(box.minY, p.y);
    box.maxX = Math.max(box.maxX, p.x);
    box.maxY = Math.max(box.maxY, p.y);
  }
  return box;
}

/** Which side of the line through two points a third one falls. */
function side(a: Point, b: Point, c: Point): number {
  return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

/** True when a point that stands on the line through a segment stands on the segment itself. */
function within(a: Point, b: Point, c: Point): boolean {
  return c.x >= Math.min(a.x, b.x) && c.x <= Math.max(a.x, b.x) && c.y >= Math.min(a.y, b.y) && c.y <= Math.max(a.y, b.y);
}

function segmentsMeet(a: Point, b: Point, c: Point, d: Point): boolean {
  const s1 = side(a, b, c);
  const s2 = side(a, b, d);
  const s3 = side(c, d, a);
  const s4 = side(c, d, b);
  if (s1 * s2 < 0 && s3 * s4 < 0) return true;
  // One end on the other segment. Two segments on one line are only touching
  // where an end of one of them stands between the ends of the other.
  if (s1 === 0 && within(a, b, c)) return true;
  if (s2 === 0 && within(a, b, d)) return true;
  if (s3 === 0 && within(c, d, a)) return true;
  return s4 === 0 && within(c, d, b);
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

/**
 * `count` dry points spread over a world's map, the same ones every run.
 * `stream` picks an independent set for the same world.
 */
export function landPoints(world: WorldDescription, count: number, stream: number): Point[] {
  const hf = new Heightfield(world.terrain);
  const rng = new Rng(world.seed ^ stream);
  const out: Point[] = [];
  for (let i = 0; i < count * 40 && out.length < count; i++) {
    const x = rng.range(-0.45, 0.45) * world.size;
    const y = rng.range(-0.45, 0.45) * world.size;
    if (hf.sample(x, y) >= world.water.seaLevel) out.push({ x, y });
  }
  return out;
}
