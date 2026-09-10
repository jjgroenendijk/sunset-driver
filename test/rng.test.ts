import { describe, expect, it } from 'vitest';
import { hashInts, hashString } from '../src/core/hash.ts';
import { Rng, rngFor, seedFromString, Subsystem } from '../src/core/rng.ts';

describe('hash', () => {
  it('is stable across runs', () => {
    expect(hashInts(1, 2, 3)).toBe(hashInts(1, 2, 3));
    expect(hashString('sunset')).toBe(hashString('sunset'));
  });
  it('separates arguments by position', () => {
    expect(hashInts(1, 2)).not.toBe(hashInts(2, 1));
    expect(hashInts(0)).not.toBe(hashInts(0, 0));
  });
});

describe('rng', () => {
  it('reproduces a stream from the same key', () => {
    const a = rngFor(42, 100, Subsystem.Traffic, 7);
    const b = rngFor(42, 100, Subsystem.Traffic, 7);
    for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });
  it('differs across tick, subsystem and entity', () => {
    const base = rngFor(42, 100, Subsystem.Traffic, 7).nextU32();
    expect(rngFor(42, 101, Subsystem.Traffic, 7).nextU32()).not.toBe(base);
    expect(rngFor(42, 100, Subsystem.Police, 7).nextU32()).not.toBe(base);
    expect(rngFor(42, 100, Subsystem.Traffic, 8).nextU32()).not.toBe(base);
  });
  it('is roughly uniform', () => {
    const r = new Rng(9);
    const buckets = new Array<number>(16).fill(0);
    const n = 160_000;
    for (let i = 0; i < n; i++) buckets[Math.floor(r.float() * 16)]!++;
    for (const b of buckets) expect(Math.abs(b - n / 16) / (n / 16)).toBeLessThan(0.03);
  });
  it('int() covers both bounds', () => {
    const r = new Rng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(r.int(2, 5));
    expect([...seen].sort()).toEqual([2, 3, 4, 5]);
  });
});

describe('seedFromString', () => {
  it('keeps small numeric seeds literal and hashes text', () => {
    expect(seedFromString('12345')).toBe(12345);
    expect(seedFromString('sunset')).toBe(hashString('sunset'));
    expect(seedFromString(' sunset ')).toBe(seedFromString('sunset'));
  });
});
