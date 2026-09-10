import { Rng } from './rng.ts';

/**
 * Seeded 2D simplex noise. Deterministic for a given seed; the permutation
 * table is drawn from the keyed RNG rather than a fixed constant so different
 * seeds give different landscapes.
 */
export class Noise2D {
  private readonly perm = new Uint8Array(512);

  constructor(seed: number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const rng = new Rng(seed);
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i);
      const t = p[i] as number;
      p[i] = p[j] as number;
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255] as number;
  }

  /** Noise in roughly [-1, 1]. */
  sample(x: number, y: number): number {
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    const perm = this.perm;
    const g0 = (perm[ii + (perm[jj] as number)] as number) % 12;
    const g1 = (perm[ii + i1 + (perm[jj + j1] as number)] as number) % 12;
    const g2 = (perm[ii + 1 + (perm[jj + 1] as number)] as number) % 12;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      t0 *= t0;
      n += t0 * t0 * grad(g0, x0, y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      t1 *= t1;
      n += t1 * t1 * grad(g1, x1, y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      t2 *= t2;
      n += t2 * t2 * grad(g2, x2, y2);
    }
    return 70 * n;
  }

  /** Fractal Brownian motion in roughly [-1, 1]. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let fx = x;
    let fy = y;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.sample(fx, fy);
      norm += amp;
      amp *= gain;
      fx *= lacunarity;
      fy *= lacunarity;
    }
    return sum / norm;
  }
}

const GRAD: readonly (readonly [number, number])[] = [
  [1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1],
];

function grad(g: number, x: number, y: number): number {
  const v = GRAD[g] as readonly [number, number];
  return v[0] * x + v[1] * y;
}
