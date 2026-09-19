/**
 * The Graphics menu's settings, and the tier they build (spec section 9.2).
 *
 * With Auto on, the monitor of `quality-monitor.ts` walks the tiers of
 * `quality.ts`. With Auto off, the player sets each knob of a tier by hand, and
 * {@link tierOf} builds the tier the game draws at. A preset sets every knob
 * to one of the automatic tiers at once.
 */
import { MIN_RENDER_SCALE } from './renderer.ts';
import { SHADOW_MAP_SIZE } from './sky.ts';
import { REFLECTION_SCALE } from './water-surface.ts';
import { FAR_RADIUS, NEAR_RADIUS } from './streaming.ts';
import { QUALITY_TIERS, type QualityTier } from './quality.ts';

/** One step of a knob: what it is called in the menu, and the value it stands for. */
export interface Step<T> {
  label: string;
  value: T;
}

/** The share of the display's pixels the frame is drawn at. */
export const RESOLUTIONS: readonly Step<number>[] = [
  { label: '100%', value: 1 },
  { label: '85%', value: 0.85 },
  { label: '75%', value: 0.75 },
  { label: '50%', value: MIN_RENDER_SCALE },
];

/** How far the city is streamed: the near ring gives way before the far one. */
export const DISTANCES: readonly Step<{ near: number; far: number }>[] = [
  { label: 'Far', value: { near: NEAR_RADIUS, far: FAR_RADIUS } },
  { label: 'Medium', value: { near: NEAR_RADIUS - 1, far: FAR_RADIUS } },
  { label: 'Near', value: { near: NEAR_RADIUS - 1, far: FAR_RADIUS - 1 } },
];

/** Pixels each way of one cascade of the sun's shadow map. */
export const SHADOWS: readonly Step<number>[] = [
  { label: 'High', value: SHADOW_MAP_SIZE },
  { label: 'Low', value: SHADOW_MAP_SIZE / 2 },
];

/** The share of the frame the water's mirror is drawn at. */
export const REFLECTIONS: readonly Step<number>[] = [
  { label: 'High', value: REFLECTION_SCALE },
  { label: 'Low', value: 0.2 },
];

/** How much of each chunk's plants and lamps is placed. */
export const DETAILS: readonly Step<number>[] = [
  { label: '100%', value: 1 },
  { label: '70%', value: 0.7 },
  { label: '45%', value: 0.45 },
  { label: '25%', value: 0.25 },
];

/**
 * What the player chose in the Graphics menu. A knob is kept as the index of
 * its step, so a table that changes its values between builds still reads.
 */
export interface GraphicsChoice {
  /** True while the monitor picks the tier from the frame time. */
  auto: boolean;
  resolution: number;
  bloom: boolean;
  smaa: boolean;
  distance: number;
  shadows: number;
  reflections: number;
  detail: number;
}

/** The knobs that are a step in a table, and the table each reads. */
export const STEPPED = {
  resolution: RESOLUTIONS,
  distance: DISTANCES,
  shadows: SHADOWS,
  reflections: REFLECTIONS,
  detail: DETAILS,
} as const;

export type SteppedKnob = keyof typeof STEPPED;

/** Auto on, with the knobs of the full tier behind it for when it is turned off. */
export const DEFAULT_GRAPHICS: GraphicsChoice = { ...choiceOf(QUALITY_TIERS[0] as QualityTier), auto: true };

/** The tier the knobs of a choice build. It carries a preset's name where it matches one. */
export function tierOf(choice: GraphicsChoice): QualityTier {
  const tier: QualityTier = {
    name: 'custom',
    post: {
      renderScale: step(RESOLUTIONS, choice.resolution),
      bloom: choice.bloom,
      smaa: choice.smaa,
      grade: true,
    },
    rings: { ...step(DISTANCES, choice.distance) },
    shadowMapSize: step(SHADOWS, choice.shadows),
    mirror: step(REFLECTIONS, choice.reflections),
    density: step(DETAILS, choice.detail),
  };
  const preset = presetOf(choice);
  return preset === undefined ? tier : (QUALITY_TIERS[preset] as QualityTier);
}

/** The knobs of a tier, with Auto off. A knob between two steps takes the nearer. */
export function choiceOf(tier: QualityTier): GraphicsChoice {
  return {
    auto: false,
    resolution: nearest(RESOLUTIONS, (v) => v - tier.post.renderScale),
    bloom: tier.post.bloom,
    smaa: tier.post.smaa,
    distance: nearest(DISTANCES, (v) => v.near + v.far - tier.rings.near - tier.rings.far),
    shadows: nearest(SHADOWS, (v) => v - tier.shadowMapSize),
    reflections: nearest(REFLECTIONS, (v) => v - tier.mirror),
    detail: nearest(DETAILS, (v) => v - tier.density),
  };
}

/** The index in {@link QUALITY_TIERS} of the tier a choice's knobs match, if they match one. */
export function presetOf(choice: GraphicsChoice): number | undefined {
  const at = QUALITY_TIERS.findIndex((tier) => sameKnobs(choiceOf(tier), choice));
  return at < 0 ? undefined : at;
}

/**
 * The automatic tier nearest a choice, by resolution, which is the knob that
 * costs most. Auto starts there when it is turned on.
 */
export function nearestTier(choice: GraphicsChoice): number {
  const scale = step(RESOLUTIONS, choice.resolution);
  let best = 0;
  QUALITY_TIERS.forEach((tier, i) => {
    const off = Math.abs(tier.post.renderScale - scale);
    if (off < Math.abs((QUALITY_TIERS[best] as QualityTier).post.renderScale - scale)) best = i;
  });
  return best;
}

/** A choice read back from storage, with the default for anything not understood. */
export function readGraphics(raw: unknown): GraphicsChoice {
  const held = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const flag = (key: 'auto' | 'bloom' | 'smaa'): boolean =>
    typeof held[key] === 'boolean' ? (held[key] as boolean) : DEFAULT_GRAPHICS[key];
  const index = (key: SteppedKnob): number => {
    const value = held[key];
    const ok = Number.isInteger(value) && (value as number) >= 0 && (value as number) < STEPPED[key].length;
    return ok ? (value as number) : DEFAULT_GRAPHICS[key];
  };
  return {
    auto: flag('auto'),
    resolution: index('resolution'),
    bloom: flag('bloom'),
    smaa: flag('smaa'),
    distance: index('distance'),
    shadows: index('shadows'),
    reflections: index('reflections'),
    detail: index('detail'),
  };
}

function sameKnobs(a: GraphicsChoice, b: GraphicsChoice): boolean {
  return (
    a.resolution === b.resolution &&
    a.bloom === b.bloom &&
    a.smaa === b.smaa &&
    a.distance === b.distance &&
    a.shadows === b.shadows &&
    a.reflections === b.reflections &&
    a.detail === b.detail
  );
}

function step<T>(table: readonly Step<T>[], at: number): T {
  return (table[at] ?? table[0] as Step<T>).value;
}

function nearest<T>(table: readonly Step<T>[], off: (value: T) => number): number {
  let best = 0;
  table.forEach((entry, i) => {
    if (Math.abs(off(entry.value)) < Math.abs(off((table[best] as Step<T>).value))) best = i;
  });
  return best;
}
