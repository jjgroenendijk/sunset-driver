import { hashInts, hashString } from './hash.ts';

/**
 * Subsystem ids used as the third key of every random stream. Adding a new
 * subsystem appends to the end so existing streams never shift.
 */
export const Subsystem = {
  Terrain: 1,
  Roads: 2,
  Parcels: 3,
  Buildings: 4,
  Vegetation: 5,
  Traffic: 6,
  Pedestrians: 7,
  Weather: 8,
  Market: 9,
  Events: 10,
  Police: 11,
  Wildlife: 12,
  Water: 13,
  Districts: 14,
  Props: 15,
  Character: 16,
  Damage: 17,
  Theft: 18,
  Weapons: 19,
  Drops: 20,
  Parking: 21,
  Tram: 22,
  Audio: 23,
  Music: 24,
  Shops: 25,
  ShopStock: 26,
} as const;
export type SubsystemId = (typeof Subsystem)[keyof typeof Subsystem];

/**
 * Small, fast, well-distributed PRNG (sfc32). Seeded from a hash so that the
 * stream is a pure function of its key.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    this.a = hashInts(seed, 1);
    this.b = hashInts(seed, 2);
    this.c = hashInts(seed, 3);
    this.d = hashInts(seed, 4) | 1;
    for (let i = 0; i < 8; i++) this.nextU32();
  }

  /** Uniform 32-bit unsigned integer. */
  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.float();
  }

  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.float() < p;
  }

  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty array');
    return items[Math.floor(this.float() * items.length)] as T;
  }

  /** Approximately normal, mean 0, sd 1 (Box–Muller). */
  gaussian(): number {
    const u = 1 - this.float();
    const v = this.float();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Fisher–Yates shuffle in place, returns the same array. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      const t = items[i] as T;
      items[i] = items[j] as T;
      items[j] = t;
    }
    return items;
  }
}

/**
 * The one way to obtain randomness in generation and simulation code:
 * a stream keyed by `(seed, tick, subsystem, entityId)`.
 */
export function rngFor(seed: number, tick: number, subsystem: SubsystemId, entityId = 0): Rng {
  return new Rng(hashInts(seed, tick, subsystem, entityId));
}

/** World-generation streams are tick-independent: key on tick 0. */
export function genRng(seed: number, subsystem: SubsystemId, entityId = 0): Rng {
  return rngFor(seed, 0, subsystem, entityId);
}

/** Normalise a user-facing seed string to the 32-bit number used everywhere else. */
export function seedFromString(seed: string): number {
  const trimmed = seed.trim();
  if (/^\d{1,10}$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n <= 0xffffffff) return n >>> 0;
  }
  return hashString(trimmed);
}
