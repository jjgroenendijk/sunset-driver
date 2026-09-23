/**
 * A cheap fractal noise for the surfaces that cover most of the screen.
 *
 * `fractalNoise` is MaterialX's Perlin noise. Each octave hashes the eight
 * corners of its cell with integer mixing and takes a gradient at each, so it
 * is about a hundred operations. Two fields of it, grain and patch, were
 * 2.2 ms of the scene pass on an Apple M1 at 1600x900, all on the blocks
 * (issue #639).
 *
 * This is value noise: one number per corner from a short hash of fractions,
 * blended with the same smooth curve. It is several times cheaper and reads
 * the same as a grain, which is all a wall or a roof asks of it. It is not
 * Perlin noise, so a field has its values on the lattice corners rather than
 * zero there, and its contrast is a little lower.
 *
 * The hash is Dave Hoskins' "hash without sine": no `sin`, so it does not
 * lose its pattern far from the origin the way `fract(sin(x))` does on a GPU.
 */
import { mix, vec3, type TslNode } from './tsl.ts';

/** How far apart the octaves start, so no two share a lattice corner. */
const OCTAVE_SHIFT = [0, 17.3, 41.9, 73.1] as const;

/**
 * Fractal value noise at `place`, in 0..1, of `octaves` octaves: each twice
 * the frequency and half the weight of the one before it.
 */
export function valueNoise01(place: TslNode, octaves: number): TslNode {
  let sum: TslNode = undefined;
  let weight = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const shift = OCTAVE_SHIFT[octave % OCTAVE_SHIFT.length] as number;
    const layer = octaveNoise(place.mul(2 ** octave).add(shift)).mul(weight);
    sum = sum === undefined ? layer : sum.add(layer);
    total += weight;
    weight /= 2;
  }
  return sum.div(total);
}

/** One octave: the eight corners of the cell `place` is in, blended smoothly. */
function octaveNoise(place: TslNode): TslNode {
  const cell = place.floor();
  const f = place.fract();
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const corner = (x: number, y: number, z: number): TslNode => hash(cell.add(vec3(x, y, z)));
  const near = mix(mix(corner(0, 0, 0), corner(1, 0, 0), u.x), mix(corner(0, 1, 0), corner(1, 1, 0), u.x), u.y);
  const far = mix(mix(corner(0, 0, 1), corner(1, 0, 1), u.x), mix(corner(0, 1, 1), corner(1, 1, 1), u.x), u.y);
  return mix(near, far, u.z);
}

/** A number in 0..1 for a lattice corner, the same for the same corner. */
function hash(cell: TslNode): TslNode {
  const p = cell.mul(0.1031).fract();
  const q = p.add(p.dot(p.zyx.add(31.32)));
  return q.x.add(q.y).mul(q.z).fract();
}
