/**
 * What a pedestrian looks like and how they walk (spec sections 5.1, 13.1).
 *
 * The look is drawn from the district the pedestrian was placed in: the core
 * wears office greys and walks briskly, the industrial belt wears work clothes,
 * the suburbs dress bright and stroll. Skin and hair come from the player's own
 * swatches, so the crowd and the character creator agree on what people look
 * like. Every draw comes from the stream it is handed, so a look is a pure
 * function of the seed and the pedestrian.
 */
import type { Rng } from '../core/rng.ts';
import type { Zone } from '../world/types.ts';
import { HAIR_COLOURS, SKIN_TONES } from './character.ts';

/**
 * The walk cycles a pedestrian moves with, and the things they do standing
 * still. The renderer bakes one clip for each, in this order, so the index of
 * a gait is its row of clips, and a new one goes at the end.
 */
export const GAITS = [
  'stroll',
  'brisk',
  'amble',
  'run',
  'stand',
  'aim',
  // A runner out for exercise, and an old person's short, stooped steps.
  'jog',
  'shuffle',
  // Standing: a call, a cigarette, a look in a window, arms folded, talking with the hands.
  'phone',
  'smoke',
  'window',
  'fold',
  'talk',
  // A phone held up at arm's length to film something.
  'film',
  // A walk with an umbrella held up, and one hunched against the rain without.
  'umbrella',
  'hunch',
  // A busker playing a guitar, and somebody shaking a fist at a driver.
  'busk',
  'shout',
] as const;
export type Gait = (typeof GAITS)[number];

/** The slowest and fastest pace of each gait, in metres per second. */
export const GAIT_SPEED: Record<Gait, readonly [number, number]> = {
  stroll: [1.15, 1.4],
  brisk: [1.45, 1.75],
  amble: [0.8, 1.05],
  run: [3.6, 4.4],
  stand: [0, 0],
  // A police officer's gun out in both hands, walking or standing (spec section 14).
  aim: [0, 1.5],
  jog: [2.3, 2.9],
  shuffle: [0.55, 0.8],
  phone: [0, 0],
  smoke: [0, 0],
  window: [0, 0],
  fold: [0, 0],
  talk: [0, 0],
  film: [0, 0],
  umbrella: [1.1, 1.5],
  hunch: [1.3, 1.7],
  busk: [0, 0],
  shout: [0, 0],
};

/** The gaits somebody stands in rather than walks. */
export const STANDING: ReadonlySet<Gait> = new Set<Gait>(['stand', 'phone', 'smoke', 'window', 'fold', 'talk', 'film', 'busk', 'shout']);

/**
 * Metres one whole cycle of a gait covers — two steps — for a person 1.75 m
 * tall. A taller person takes a longer stride in proportion.
 */
export const GAIT_STRIDE: Record<Gait, number> = {
  stroll: 1.4,
  brisk: 1.6,
  amble: 1.05,
  run: 2.6,
  stand: 1,
  aim: 1.5,
  jog: 2.1,
  shuffle: 0.75,
  phone: 1,
  smoke: 1,
  window: 1,
  fold: 1,
  talk: 1,
  film: 1,
  umbrella: 1.35,
  hunch: 1.45,
  busk: 1,
  shout: 1,
};

/**
 * The walking gait a person's own gait is blended towards, a little, so that
 * two people of one gait still walk differently: one swings their arms more,
 * one strides longer. A gait blended with itself is not blended.
 */
export const GAIT_NEIGHBOUR: Partial<Record<Gait, Gait>> = {
  stroll: 'brisk',
  brisk: 'stroll',
  amble: 'stroll',
  jog: 'run',
  shuffle: 'amble',
};

/** The height a stride is measured for. */
export const STRIDE_HEIGHT = 1.75;

/** How the people of a zone dress and walk. */
interface ZoneLook {
  tops: readonly number[];
  legs: readonly number[];
  /** The walking gaits, and how often each comes up. */
  gaits: Partial<Record<Gait, number>>;
}

/** The dress and pace of each zone. */
export const ZONE_LOOKS: Record<Zone, ZoneLook> = {
  // Office wear: charcoal, navy and white shirts, dark trousers, a brisk pace.
  core: {
    tops: [0x2b2f36, 0x1f2a44, 0xe8e6e1, 0x5a6270, 0x7a1f2b, 0x3c4a5c],
    legs: [0x1c1e22, 0x2a2d33, 0x243047, 0x4b4f56],
    gaits: { brisk: 5, stroll: 3, amble: 1 },
  },
  // The mixed inner districts: bright shirts and denim.
  inner: {
    tops: [0xd9483b, 0x2f8f83, 0xe7b43c, 0x6a4c93, 0xf0efe9, 0x2d5fa8, 0xe07aa4],
    legs: [0x2d4a73, 0x1d2b44, 0x3a3a3a, 0x8a7a5c],
    gaits: { stroll: 4, brisk: 3, amble: 1 },
  },
  // The works: hi-vis orange and yellow, boiler suits, work trousers.
  industrial: {
    tops: [0xf2701d, 0xd8e02b, 0x3e5a7a, 0x5b5f4a, 0x9a9c98],
    legs: [0x2e3a4d, 0x3b3f36, 0x1f2328],
    gaits: { brisk: 3, stroll: 3, amble: 2 },
  },
  // The suburbs: pastels and sportswear, in no hurry.
  suburban: {
    tops: [0x9cc9e0, 0xf2b8a2, 0xc6e0a0, 0xf6e7a8, 0xffffff, 0xb59ad6],
    legs: [0x4e6d8f, 0xd8cfb8, 0x2f3b4a, 0x7d8a6a],
    gaits: { stroll: 5, amble: 3, brisk: 1 },
  },
  // Farms and small towns: earth colours, work boots.
  outskirts: {
    tops: [0x7a5a3a, 0x4f6b3a, 0xa33a2c, 0x8c8a7a, 0x3d4f63],
    legs: [0x3b4a5c, 0x5a4a36, 0x2c2c2a],
    gaits: { amble: 4, stroll: 4, brisk: 1 },
  },
  // Walkers and hikers: outdoor jackets.
  wilderness: {
    tops: [0x2f6b4f, 0xd0632b, 0x2b4f8a, 0xc9b23a],
    legs: [0x3a3f3a, 0x4b4436],
    gaits: { stroll: 3, brisk: 2, amble: 2 },
  },
};

/** How a pedestrian looks and how they walk. */
export interface PedestrianLook {
  skin: number;
  hair: number;
  top: number;
  legs: number;
  /** Metres tall. */
  height: number;
  gait: Gait;
  /** Metres per second at their own pace. */
  speed: number;
  /**
   * How far their gait is blended towards its neighbour in
   * {@link GAIT_NEIGHBOUR}, 0 to 0.45: the difference between two people who
   * walk at one gait. None for somebody dressed by hand, such as an officer.
   */
  blend?: number;
  /** Radians their upper body leans forward of upright: a stoop. None stands upright. */
  lean?: number;
  /** 0 to 1: how soon rain puts up their umbrella. Somebody at 1, or with none, carries none. */
  umbrella?: number;
}

/** The look of one pedestrian of a zone, drawn from a stream. */
export function lookOf(zone: Zone, rng: Rng): PedestrianLook {
  const dress = ZONE_LOOKS[zone];
  const skin = (SKIN_TONES[rng.int(0, SKIN_TONES.length - 1)] as { colour: number }).colour;
  // The neon swatch is the player's to choose, not the street's.
  const natural = HAIR_COLOURS.filter((swatch) => swatch.id !== 'neon');
  const hair = (natural[rng.int(0, natural.length - 1)] as { colour: number }).colour;
  const top = dress.tops[rng.int(0, dress.tops.length - 1)] as number;
  const legs = dress.legs[rng.int(0, dress.legs.length - 1)] as number;
  const height = rng.range(1.55, 1.92);
  const gait = pickGait(dress.gaits, rng);
  const [slow, fast] = GAIT_SPEED[gait];
  const speed = rng.range(slow, fast);
  return { skin, hair, top, legs, height, gait, speed };
}

/** Metres one cycle of a gait covers for a person of a height. */
export function strideOf(gait: Gait, height: number): number {
  return (GAIT_STRIDE[gait] * height) / STRIDE_HEIGHT;
}

function pickGait(mix: Partial<Record<Gait, number>>, rng: Rng): Gait {
  let total = 0;
  for (const gait of GAITS) total += mix[gait] ?? 0;
  let pick = rng.float() * total;
  for (const gait of GAITS) {
    pick -= mix[gait] ?? 0;
    if (pick < 0) return gait;
  }
  return 'stroll';
}
