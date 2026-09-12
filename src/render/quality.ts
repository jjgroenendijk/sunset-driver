/**
 * The quality tiers of spec section 9.2.
 *
 * The game aims at a 16 ms frame on integrated graphics. A machine that cannot
 * hold it is not told to try harder: the frame is made cheaper until it can,
 * and made dearer again when it turns out it could all along. Six knobs step
 * together, because stepping one at a time takes six windows to find the tier
 * one window away:
 *
 * - the render scale, which the whole frame and the post chain cost the square
 *   of (`renderer.ts`);
 * - the effects of spec section 10.6, bloom first, then SMAA;
 * - the draw distance, as the two streaming rings of spec section 9.1;
 * - how far the sun's shadow reaches and what it is drawn at (`sky.ts`);
 * - how much of each category's {@link ENTITY_CAPS} a chunk places;
 * - and, through the draw distance, how far the dither fade of `fade.ts`
 *   carries the plants and the street lamps.
 *
 * {@link QualityMonitor} is the frame-time monitor that walks the table. It is
 * pure — it is given a frame length and answers a tier — so the policy is
 * tested without a renderer, and everything that applies a tier lives with the
 * thing it changes.
 */
import { FADE_BAND } from './fade.ts';
import { FULL_QUALITY, type PostQuality } from './post.ts';
import { MIN_RENDER_SCALE } from './renderer.ts';
import { SHADOW_DISTANCE, SHADOW_MAP_SIZE } from './sky.ts';
import { FAR_RADIUS, NEAR_RADIUS, type ChunkRings } from './streaming.ts';
import { CHUNK_SIZE } from '../world/chunks.ts';

/**
 * The frame the tiers are measured against, in milliseconds. This is the 60 fps
 * frame of spec section 2.4, whole: the monitor watches what a frame actually
 * took, not what one system inside it spent.
 */
export const FRAME_BUDGET_MS = 16;

/** What a tier draws, and how much of the world it draws (spec section 9.2). */
export interface QualityTier {
  /** What the tier is called, in the HUD and in the log. */
  name: string;
  /** The frame and the effects over it (spec sections 9.2, 10.6). */
  post: PostQuality;
  /** How far the two streaming rings of spec section 9.1 reach. */
  rings: ChunkRings;
  /** Pixels each way of one cascade of the sun's shadow map. */
  shadowMapSize: number;
  /** Fraction of {@link ENTITY_CAPS} a chunk places. */
  density: number;
}

/**
 * The tiers, dearest first. The top one is the game at full quality, and the
 * game starts there: a machine that can hold the frame should never see the
 * tiers at all, and one that cannot finds its level inside a second.
 *
 * The colour grade stays on at every tier. It is one lookup in a table the
 * frame is already paying to sample, and it is the whole look of spec section
 * 10.6; turning it off would save a fraction of a millisecond and cost the
 * game its identity. Bloom goes first instead, then SMAA, which the falling
 * render scale is already blurring the edges of.
 */
export const QUALITY_TIERS: readonly QualityTier[] = [
  {
    name: 'full',
    post: FULL_QUALITY,
    rings: { near: NEAR_RADIUS, far: FAR_RADIUS },
    shadowMapSize: SHADOW_MAP_SIZE,
    density: 1,
  },
  {
    name: 'high',
    post: { renderScale: 0.85, bloom: true, smaa: true, grade: true },
    rings: { near: NEAR_RADIUS, far: FAR_RADIUS },
    shadowMapSize: SHADOW_MAP_SIZE,
    density: 0.7,
  },
  {
    name: 'medium',
    post: { renderScale: 0.75, bloom: false, smaa: true, grade: true },
    // The near ring gives way before the far one does. A city that ends
    // nearer is seen to end; a city drawn more simply from 250 m out, where
    // the camera of spec section 10.7 already reads it as massing, is not.
    rings: { near: NEAR_RADIUS - 1, far: FAR_RADIUS },
    shadowMapSize: SHADOW_MAP_SIZE / 2,
    density: 0.45,
  },
  {
    name: 'low',
    post: { renderScale: MIN_RENDER_SCALE, bloom: false, smaa: false, grade: true },
    rings: { near: NEAR_RADIUS - 1, far: FAR_RADIUS - 1 },
    shadowMapSize: SHADOW_MAP_SIZE / 2,
    density: 0.25,
  },
];

/** The game at full quality, which is where a session starts. */
export const FULL_TIER = QUALITY_TIERS[0] as QualityTier;

/** The categories a cap is kept per (spec section 9.2). */
export type EntityCategory = 'plants' | 'lamps';

/**
 * Entities of a category one chunk may place, at full density.
 *
 * A cap is a ceiling rather than a target: at the top tier the densest chunk a
 * seed produces comes in under it or a little over, and the thinning is not
 * seen. What the tiers move is the density, which takes the same chunk down in
 * steps. Both are enforced where a chunk is put into the scene, so a category
 * the caps do not name yet — the traffic, the parked cars and the crowds of
 * spec section 13.1 — brings its own entry when it lands.
 *
 * Measured over the chunks around the core of several seeds: the densest holds
 * about 650 plants and about 100 street lamps.
 */
export const ENTITY_CAPS: Record<EntityCategory, number> = {
  plants: 512,
  lamps: 128,
};

/** Metres the plants and the street lamps of a tier are drawn to. */
export function entityDistance(tier: QualityTier): number {
  // The near ring is a square of chunks and the fade is a circle inside it.
  // Wherever in their own chunk the player stands, every chunk within this of
  // them is one the near ring holds, so nothing fades that was never built.
  return tier.rings.near * CHUNK_SIZE;
}

/**
 * Metres the sun's shadow follows the view for at a tier (spec section 9.2).
 *
 * It never reaches past where the plants and the lamps start fading. The
 * shadow pass cannot follow the dither of `fade.ts` — it draws the whole scene
 * through one override material that reads neither the opacity nor the alpha
 * test — so a plant inside the band would keep a whole shadow standing on
 * empty ground. Stopping the shadow before the band starts is what keeps the
 * two in step, and it makes a lower tier cheaper rather than dearer.
 */
export function shadowDistance(tier: QualityTier): number {
  return Math.min(SHADOW_DISTANCE, entityDistance(tier) - FADE_BAND);
}

/** How many of `count` entities of a category a chunk places at a tier. */
export function entityBudget(tier: QualityTier, category: EntityCategory, count: number): number {
  const cap = Math.max(1, Math.round(ENTITY_CAPS[category] * tier.density));
  return Math.min(count, cap);
}

/**
 * Where the `i`-th of `kept` entities is taken from a list of `count`.
 *
 * The kept entities are spread evenly over the list rather than taken off the
 * front, because a chunk's entities come in the order they were laid out: a
 * prefix of a chunk's plants is one corner of it planted and the rest bare.
 */
export function keptAt(i: number, count: number, kept: number): number {
  return Math.floor((i * count) / kept);
}

/** A list cut down to `limit` entities, spread evenly over the whole of it. */
export function thinned<T>(entities: readonly T[], limit: number): readonly T[] {
  const count = entities.length;
  const kept = Math.min(count, limit);
  if (kept === count) return entities;
  const out: T[] = [];
  for (let k = 0; k < kept; k++) out.push(entities[keptAt(k, count, kept)] as T);
  return out;
}

/** A tier the monitor has just moved to, and the frame time that moved it. */
export interface QualityChange {
  from: QualityTier;
  to: QualityTier;
  /** The median frame of the window that decided it, in milliseconds. */
  frameMs: number;
}

/** Frames the monitor judges a tier on. Half a second at 60 fps. */
const WINDOW = 30;

/**
 * Windows in a row under {@link HEADROOM} of the budget before a tier is
 * raised. A tier is dropped on one bad window and raised only after four good
 * ones: a tier that was dropped was dropped for a reason, and a frame rate that
 * walks up and down the table is worse to look at than the lower tier.
 */
const GOOD_WINDOWS = 4;

/**
 * Fraction of the budget the median must come in under before a tier is raised.
 * The room left over is what the tier above will spend, so a tier raised is not
 * dropped again on the window after it.
 */
const HEADROOM = 0.7;

/**
 * How far over the budget the median may run before a window counts as missed.
 *
 * A frame is timed from one animation frame to the next, and those land on the
 * display's refresh. A 60 Hz display that makes every refresh measures 16.7 ms,
 * which is over a 16 ms budget, and one refresh missed measures 33 ms. A median
 * between the two is the refresh and its jitter, not a machine that cannot hold
 * the frame; judged without this, every 60 Hz display walked down to the lowest
 * tier.
 */
const MISS = 1.25;

/**
 * A frame longer than this is not counted. Nothing the tiers can change makes a
 * frame a fifth of a second long: a window switching back, a garbage collection
 * or the tab coming back to the front is not a frame rate, and stepping the
 * whole city down for one is the hitch the player would notice.
 */
const STALL_MS = 200;

/**
 * The frame-time monitor of spec section 9.2.
 *
 * It is given how long each frame took and answers a tier when it changes one,
 * and nothing at all the rest of the time. The judgement is the median of a
 * window rather than the mean, so one dear frame — a tower copied into its
 * batch, a chunk landing — cannot step the city down by itself. The window
 * after a change is thrown away, because the change costs a frame or two of
 * its own: the post chain is rebuilt, the shadow map is resized, and a new
 * draw distance sets the workers going.
 */
export class QualityMonitor {
  private readonly budgetMs: number;
  private readonly frames: number[] = [];
  private at: number;
  private good = 0;
  /** True while the window being filled is not to be judged on. */
  private settling = true;

  constructor(budgetMs = FRAME_BUDGET_MS, at = 0) {
    this.budgetMs = budgetMs;
    this.at = clampTier(at);
  }

  /** The tier in force. */
  get tier(): QualityTier {
    return QUALITY_TIERS[this.at] as QualityTier;
  }

  /** Where that tier stands in {@link QUALITY_TIERS}, 0 being the dearest. */
  get index(): number {
    return this.at;
  }

  /** The frame the tiers are held to, in milliseconds. */
  get budget(): number {
    return this.budgetMs;
  }

  /**
   * Count one frame, and answer the change it caused if it caused one. The
   * first window of a session is thrown away like the window after a change:
   * the city is still streaming in, and the frames it takes to arrive say
   * nothing about the machine.
   */
  sample(frameMs: number): QualityChange | undefined {
    if (!(frameMs > 0) || frameMs > STALL_MS) return undefined;
    this.frames.push(frameMs);
    if (this.frames.length < WINDOW) return undefined;
    const middle = median(this.frames);
    this.frames.length = 0;
    if (this.settling) {
      this.settling = false;
      return undefined;
    }
    if (middle > this.budgetMs * MISS) return this.step(1, middle);
    if (middle > this.budgetMs * HEADROOM) {
      this.good = 0;
      return undefined;
    }
    this.good++;
    if (this.good < GOOD_WINDOWS) return undefined;
    return this.step(-1, middle);
  }

  /**
   * Throw away the window being filled and judge nothing on the next one. What
   * the developer free camera of `free-camera.ts` draws is never a performance
   * measurement, so the monitor is settled again when it hands the camera back.
   */
  settle(): void {
    this.frames.length = 0;
    this.good = 0;
    this.settling = true;
  }

  /** Move one tier, or stay where there is nowhere left to go. */
  private step(by: number, frameMs: number): QualityChange | undefined {
    this.good = 0;
    const to = this.at + by;
    if (to < 0 || to >= QUALITY_TIERS.length) return undefined;
    const from = this.tier;
    this.at = to;
    this.settling = true;
    return { from, to: this.tier, frameMs };
  }
}

/** The middle frame of a window, which one dear frame cannot move. */
function median(frames: readonly number[]): number {
  const sorted = [...frames].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}

function clampTier(at: number): number {
  return Math.min(QUALITY_TIERS.length - 1, Math.max(0, Math.round(at)));
}

/**
 * The frame budget a session was started with, off the page's query string.
 *
 * `?budget=6` holds the game to a 6 ms frame, which no machine makes at full
 * quality, so the tiers step down while it is watched. That is how spec section
 * 9.2 is checked by eye rather than only in a test. Anything unreadable, and
 * anything outside a frame the tiers could ever serve, is ignored.
 */
export function frameBudgetFrom(search: string): number {
  const asked = Number(new URLSearchParams(search).get('budget'));
  if (!Number.isFinite(asked) || asked <= 0 || asked > 1000) return FRAME_BUDGET_MS;
  return asked;
}
