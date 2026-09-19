import { describe, expect, it } from 'vitest';
import { acos, asin, atan, atan2, cos, exp, hypot, log, sin, tan } from '../src/core/libm.ts';

/**
 * How far apart two doubles are, counted in the last place. `Math` is itself
 * only about that accurate, so this says how far the two agree rather than how
 * right either one is. Two values that are not both finite agree only when
 * they are the same value.
 */
function ulps(a: number, b: number): number {
  if (Object.is(a, b)) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  const view = new DataView(new ArrayBuffer(8));
  const ordinal = (v: number): bigint => {
    view.setFloat64(0, v);
    const raw = (BigInt(view.getUint32(0)) << 32n) | BigInt(view.getUint32(4));
    return v < 0 || Object.is(v, -0) ? -(raw - 0x8000000000000000n) : raw;
  };
  const d = ordinal(a) - ordinal(b);
  return Number(d < 0n ? -d : d);
}

/** The widest gap from `Math`'s answer over a range, in the last place. */
function worstOver(from: number, to: number, mine: (x: number) => number, theirs: (x: number) => number): number {
  let worst = 0;
  for (let i = 0; i <= 20_000; i++) {
    const x = from + ((to - from) * i) / 20_000;
    worst = Math.max(worst, ulps(mine(x), theirs(x)));
  }
  return worst;
}

describe('the Math functions computed the same way on every engine', () => {
  it('agrees with Math where Math is trustworthy', () => {
    // Each row is a function, a range, and how far it may sit from `Math`'s
    // answer. One unit in the last place is `Math`'s own accuracy; the few
    // rows above it are the functions taken through another one, which costs
    // a bit, and no call site of them reads a last-place bit.
    const rows: [string, (x: number) => number, (x: number) => number, number, number, number][] = [
      ['sin', sin, Math.sin, -7, 7, 1],
      ['sin far out', sin, Math.sin, -1e6, 1e6, 1],
      ['cos', cos, Math.cos, -7, 7, 1],
      ['cos far out', cos, Math.cos, -1e6, 1e6, 1],
      ['tan', tan, Math.tan, -7, 7, 3],
      ['tan far out', tan, Math.tan, -1e5, 1e5, 3],
      ['atan', atan, Math.atan, -20, 20, 1],
      ['atan far out', atan, Math.atan, -1e9, 1e9, 1],
      ['asin', asin, Math.asin, -1, 1, 3],
      ['acos', acos, Math.acos, -1, 1, 3],
      ['acos at the top', acos, Math.acos, 0.999999, 1, 3],
      ['log', log, Math.log, 1e-12, 10, 1],
      ['log over every size', log, Math.log, 1e-300, 1e30, 1],
      ['exp', exp, Math.exp, -700, 700, 1],
      ['atan2 right of the axis', (x) => atan2(x, 7.125), (x) => Math.atan2(x, 7.125), -50, 50, 1],
      ['atan2 left of it', (x) => atan2(x, -7.125), (x) => Math.atan2(x, -7.125), -50, 50, 1],
      ['hypot', (x) => hypot(x, 3.25), (x) => Math.hypot(x, 3.25), -1e5, 1e5, 1],
      ['hypot of three sides', (x) => hypot(x, 3.25, 2.5), (x) => Math.hypot(x, 3.25, 2.5), -1e5, 1e5, 2],
    ];
    for (const [name, mine, theirs, from, to, allowed] of rows) {
      expect(worstOver(from, to, mine, theirs), name).toBeLessThanOrEqual(allowed);
    }
  });

  it('is exact where the answer is exact', () => {
    expect(sin(0)).toBe(0);
    expect(Object.is(sin(-0), -0)).toBe(true);
    expect(cos(0)).toBe(1);
    expect(sin(Math.PI / 2)).toBe(1);
    expect(cos(Math.PI)).toBe(-1);
    expect(tan(0)).toBe(0);
    expect(atan(0)).toBe(0);
    expect(log(1)).toBe(0);
    expect(log(0)).toBe(-Infinity);
    expect(exp(0)).toBe(1);
    expect(acos(1)).toBe(0);
    expect(acos(-1)).toBe(Math.PI);
    expect(acos(0)).toBe(Math.PI / 2);
    expect(asin(1)).toBe(Math.PI / 2);
    expect(hypot(3, 4)).toBe(5);
    expect(hypot(0, 0)).toBe(0);
  });

  it('answers the quadrants and the axes the way Math.atan2 does', () => {
    const pairs: [number, number][] = [
      [0, 1],
      [-0, 1],
      [0, -1],
      [-0, -1],
      [1, 0],
      [-1, 0],
      [1, Infinity],
      [1, -Infinity],
      [Infinity, 1],
      [-Infinity, 1],
      [Infinity, Infinity],
      [-Infinity, -Infinity],
      [Infinity, -Infinity],
      [-Infinity, Infinity],
    ];
    for (const [y, x] of pairs) {
      expect(atan2(y, x), `atan2(${y}, ${x})`).toBe(Math.atan2(y, x));
    }
  });

  it('survives the ends of the range a double holds', () => {
    expect(hypot(1e308, 1e308)).toBe(Math.hypot(1e308, 1e308));
    expect(hypot(5e-324, 5e-324)).toBe(Math.hypot(5e-324, 5e-324));
    // An infinite side wins beside a NaN one, as Math.hypot has it.
    expect(hypot(Infinity, NaN)).toBe(Infinity);
    expect(hypot(NaN, 1)).toBeNaN();
    expect(log(5e-324)).toBe(Math.log(5e-324));
    // The exponential's power of two goes into the exponent, so a result this
    // near the top is still a number rather than an overflow.
    expect(exp(709.7)).toBe(Math.exp(709.7));
    expect(exp(710)).toBe(Infinity);
    expect(exp(-745)).toBe(Math.exp(-745));
    expect(exp(-746)).toBe(0);
  });

  it('answers NaN for an argument that is not a number', () => {
    for (const f of [sin, cos, tan, atan, log, exp, asin, acos]) {
      expect(f(NaN)).toBeNaN();
    }
    expect(sin(Infinity)).toBeNaN();
    expect(cos(-Infinity)).toBeNaN();
    expect(asin(1.5)).toBeNaN();
    expect(acos(-1.5)).toBeNaN();
    expect(log(-1)).toBeNaN();
    expect(atan2(NaN, 1)).toBeNaN();
    expect(atan(Infinity)).toBeCloseTo(Math.PI / 2, 15);
    expect(exp(Infinity)).toBe(Infinity);
    expect(exp(-Infinity)).toBe(0);
  });

  /**
   * The whole point of this module is that the bits never move: every engine,
   * and every version of this file, must answer the same or the seed builds
   * another city. A change that shifts one result fails here, which is the
   * prompt to think about whether every seed in the world is meant to change.
   */
  it('gives the same bits it has always given', () => {
    let hash = 0x811c9dc5;
    const eat = (value: number): void => {
      const text = String(value);
      for (let k = 0; k < text.length; k++) {
        hash ^= text.charCodeAt(k);
        hash = Math.imul(hash, 0x01000193);
      }
    };
    for (let i = 0; i < 4096; i++) {
      const x = (i - 2048) * 0.37;
      const unit = Math.max(-1, Math.min(1, x / 800));
      eat(sin(x));
      eat(cos(x));
      eat(tan(x));
      eat(atan(x));
      eat(atan2(x, 7.125));
      eat(atan2(x, -3.5));
      eat(asin(unit));
      eat(acos(unit));
      eat(hypot(x, 3.25));
      eat(hypot(x, 3.25, 2.5));
      eat(log(Math.abs(x) + 0.5));
      eat(exp(x / 100));
    }
    expect((hash >>> 0).toString(16)).toBe('5633375');
  });
});
