/**
 * The quality tiers of spec section 9.2.
 *
 * The game aims at a 16 ms frame on integrated graphics. A machine that cannot
 * hold it is not told to try harder: the frame is made cheaper until it can,
 * and made dearer again when it turns out it could all along. Seven knobs step
 * together, because stepping one at a time takes seven windows to find the tier
 * one window away:
 *
 * - the render scale, which the whole frame and the post chain cost the square
 *   of (`renderer.ts`);
 * - the effects of spec section 10.6, bloom first, then SMAA;
 * - the draw distance, as the two streaming rings of spec section 9.1;
 * - how far the sun's shadow reaches and what it is drawn at (`sky.ts`);
 * - what the water's mirror is rendered at (`water-surface.ts`);
 * - how much of each category's {@link ENTITY_CAPS} a chunk places;
 * - and, through the draw distance, how far the dither fade of `fade.ts`
 *   carries the plants and the street lamps.
 *
 * `QualityMonitor` (`quality-monitor.ts`) is the frame-time monitor that walks
 * the table. It is pure — it is given a frame length and answers a tier — so the
 * policy is tested without a renderer, and everything that applies a tier lives
 * with the thing it changes. `graphics.ts` builds a tier from the player's own
 * choices when Auto is off.
 */
import { FADE_BAND } from '../camera/fade.ts';
import { FULL_QUALITY, type PostQuality } from '../look/post.ts';
import { MIN_RENDER_SCALE } from '../renderer.ts';
import { SHADOW_DISTANCE, SHADOW_MAP_SIZE } from '../environment/sky.ts';
import { REFLECTION_SCALE } from '../environment/water-surface.ts';
import { FAR_RADIUS, NEAR_RADIUS, type ChunkRings } from '../streaming/streaming.ts';
import { CHUNK_SIZE } from '../../world/chunks.ts';

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
  /**
   * The share of the frame the water's mirror is rendered at. The mirror is a
   * second pass over the scene, and the dearest single thing a frame with
   * water in view pays for; a tier that cannot hold the frame renders it
   * smaller rather than not at all, because the reflection is what the sea is.
   * It never renders where no water is in view, whatever the tier.
   */
  mirror: number;
  /** Fraction of {@link ENTITY_CAPS} a chunk places. */
  density: number;
}

/**
 * The tiers, dearest first. The top one is the game at full quality, and the
 * game starts there: a machine that can hold the frame should never see the
 * tiers at all, and one that cannot finds its level in a few seconds.
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
    mirror: REFLECTION_SCALE,
    density: 1,
  },
  {
    name: 'high',
    post: { renderScale: 0.85, bloom: true, smaa: true, grade: true },
    rings: { near: NEAR_RADIUS, far: FAR_RADIUS },
    shadowMapSize: SHADOW_MAP_SIZE,
    mirror: REFLECTION_SCALE,
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
    // The reflection is small on screen and broken up by the waves, so the
    // mirror costs the square of this and still reads the same.
    mirror: 0.2,
    density: 0.45,
  },
  {
    name: 'low',
    post: { renderScale: MIN_RENDER_SCALE, bloom: false, smaa: false, grade: true },
    rings: { near: NEAR_RADIUS - 1, far: FAR_RADIUS - 1 },
    shadowMapSize: SHADOW_MAP_SIZE / 2,
    mirror: 0.2,
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
