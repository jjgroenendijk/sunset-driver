/**
 * The rivers and the harbour of a terrain layout (spec section 7.2), and the
 * valleys they cut into the heightfield. How many rivers there are, where they
 * run and where the harbour goes are the archetype's (`archetype.ts`).
 */
import { clamp, lerp, smoothstep } from '../core/math.ts';
import { Noise2D } from '../core/noise.ts';
import type { Rng } from '../core/rng.ts';
import type { TerrainArchetype } from './archetype.ts';
import type { Heightfield } from './heightfield.ts';
import type { SiteLayout } from './sites.ts';
import type { Point, RiverDescription } from './types.ts';

/** Signed distance to the coast: negative inland, positive at sea. */
export type CoastAt = (x: number, y: number) => number;

export interface Harbour {
  x: number;
  y: number;
  radius: number;
}

/** Metres a walk towards the shore moves between two readings of the coast. */
const WALK = 20;

/** The rivers of a layout, then its harbour. The draws follow the layout's own, from the same stream. */
export function planWater(
  seed: number,
  archetype: TerrainArchetype,
  sites: SiteLayout,
  rng: Rng,
  size: number,
  coast: CoastAt,
): { rivers: RiverDescription[]; harbour: Harbour } {
  const radius = size * 0.035;
  const profile = archetype.rivers;
  const count = profile.count.min === profile.count.max ? profile.count.min : rng.int(profile.count.min, profile.count.max);
  const waterfront = (): Harbour => {
    const toward = Math.atan2(sites.waterfront.y, sites.waterfront.x);
    const at = shoreToward(coast, { x: 0, y: 0 }, toward, size);
    // The basin is dug nine metres down and blends back into the ground over
    // {@link HARBOUR_REACH}. Where the core faces water closer than the basin is
    // wide — the inner shore of a lagoon — a basin dug at the shore leaves the
    // core on the rim of the bowl, and the core stands on gentle ground (spec
    // section 7.2). So the basin is pushed out into the water until it clears
    // the core, blend and all. It still faces the shore the core faces, which is
    // what the archetype asks for, and one seed in 500 is far enough in to move.
    const want = radius + HARBOUR_REACH;
    if (Math.hypot(at.x, at.y) >= want) return { x: at.x, y: at.y, radius };
    return { x: Math.cos(toward) * want, y: Math.sin(toward) * want, radius };
  };
  // A harbour on the waterfront is placed first, and the rivers keep clear of the water it carves.
  const placed = archetype.harbour === 'waterfront' ? waterfront() : undefined;
  const wet: CoastAt =
    placed === undefined
      ? coast
      : (x, y) => Math.max(coast(x, y), placed.radius + HARBOUR_REACH - Math.hypot(x - placed.x, y - placed.y));
  const clear = placed === undefined ? CORE_CLEAR : RING_CLEAR;
  const rivers: RiverDescription[] = [];
  if (count > 0) {
    if (profile.kind === 'source-to-mouth') rivers.push(...sourceToMouth(seed, rng, size, wet, clear));
    else if (profile.kind === 'delta') rivers.push(...deltaTrunk(seed, sites, rng, size, wet, clear));
    else rivers.push(...spineRivers(seed, sites, rng, size, wet, count, clear));
  }
  const first = rivers[0];
  if (placed !== undefined) return { rivers, harbour: placed };
  if (first === undefined) return { rivers, harbour: waterfront() };
  const mouth = first.path[first.path.length - 1] as Point;
  return { rivers, harbour: { x: mouth.x, y: mouth.y, radius } };
}

/** Walking out from a point in a direction, the last dry place before the water. */
function shoreToward(coast: CoastAt, from: Point, angle: number, size: number): Point {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let reach = 0;
  for (let s = 0; s < size; s += WALK) {
    if (coast(from.x + dx * s, from.y + dy * s) > 0) break;
    reach = s;
  }
  return { x: from.x + dx * reach, y: from.y + dy * reach };
}

/** How far along its walk to the shore a source may stand: the near fractions for most rivers, the far ones for a river kept off the ring. */
const NEAR_SOURCE = [0.6, 0.3] as const;
const FAR_SOURCE = [0.85, 0.6] as const;

/** A source deep inland along `angle` from the core, where the land allows one. */
function sourceAlong(coast: CoastAt, angle: number, size: number, within: readonly [number, number] = NEAR_SOURCE): Point {
  let sourceReach = 0;
  for (let s = 0; s < size; s += WALK) {
    if (coast(Math.cos(angle) * s, Math.sin(angle) * s) > -80) break;
    sourceReach = s;
  }
  const [top, bottom] = within;
  let source: Point = { x: Math.cos(angle) * sourceReach * bottom, y: Math.sin(angle) * sourceReach * bottom };
  for (let f = top; f >= bottom; f -= 0.05) {
    const candidate = { x: Math.cos(angle) * sourceReach * f, y: Math.sin(angle) * sourceReach * f };
    if (coast(candidate.x, candidate.y) < -200) {
      source = candidate;
      break;
    }
  }
  return source;
}

/**
 * From the main island's interior to its shore. The mouth faces the widest
 * stretch of the main island's own coast, found by walking outward from the core.
 */
function sourceToMouth(seed: number, rng: Rng, size: number, coast: CoastAt, clear: number): RiverDescription[] {
  const mouthAngle = rng.range(-Math.PI, Math.PI);
  let mouth: Point = { x: 0, y: 0 };
  let bestReach = -Infinity;
  for (let k = 0; k < 16; k++) {
    const a = mouthAngle + (k / 16) * Math.PI * 2;
    const shore = shoreToward(coast, { x: 0, y: 0 }, a, size);
    const reach = Math.hypot(shore.x, shore.y);
    if (reach > bestReach) {
      bestReach = reach;
      mouth = shore;
    }
  }
  const mouthDir = Math.atan2(mouth.y, mouth.x);
  const sign = rng.chance(0.5) ? 1 : -1;
  const turn = rng.range(0.6, 1.3);
  if (clear === RING_CLEAR) {
    // Kept off the ring: the source stands far out, a quarter turn or so from the mouth, so the river runs round the city.
    return inlandRiver(coast, size, clear, [sign, -sign], [1.1, 1.4, 1.7], (s, t) =>
      traceRiver(seed, 0, sourceAlong(coast, mouthDir + s * t, size, FAR_SOURCE), mouth, size, 1),
    );
  }
  return inlandRiver(coast, size, clear, [sign, -sign], [turn, 0.9, 0.6], (s, t) =>
    traceRiver(seed, 0, sourceAlong(coast, mouthDir + Math.PI + s * t, size), mouth, size, 1),
  );
}

/** Share of a river's length, from the mouth up, that may run close to a shore. */
const MOUTH_SHARE = 0.2;
/** Metres past its own bank a river keeps from every shore above its mouth. */
const INLAND = 120;
/** How far every river keeps from the core, past its own bank, as a fraction of the map. */
const CORE_CLEAR = 0.03;
/**
 * How far a river keeps from the core where the harbour stands on the
 * waterfront. That harbour already cuts the ring of highways round the core
 * (`highways.ts`), and a river across the ring as well leaves no arc of it long
 * enough to lay.
 */
const RING_CLEAR = 0.2;

/**
 * True when a river stays inland from its source down to near its mouth. A
 * river whose upper course touches the water cuts the land it runs across in
 * two, and no road crosses a river.
 */
function staysInland(coast: CoastAt, river: RiverDescription, size: number, clear: number): boolean {
  const last = Math.floor(river.path.length * (1 - MOUTH_SHARE));
  for (let i = 0; i < river.path.length; i++) {
    const p = river.path[i] as Point;
    const bank = river.halfWidths[i] as number;
    if (i < last && coast(p.x, p.y) > -(bank + INLAND)) return false;
    // The core stands on dry, gentle ground, so no river runs through it.
    if (Math.hypot(p.x, p.y) < size * clear + bank) return false;
  }
  return true;
}

/**
 * The first river of a list of tries, over both signs and then each turn, that
 * stays inland. Where none does, there is no river: a map with one fewer river
 * is a fair map, and a map cut in two is not. The exception is a harbour at the
 * river mouth, the one harbour whose rivers keep only {@link CORE_CLEAR} from
 * the core. It needs its river, so there the first try stands.
 */
function inlandRiver(
  coast: CoastAt,
  size: number,
  clear: number,
  signs: readonly number[],
  turns: readonly number[],
  trace: (sign: number, turn: number) => RiverDescription,
): RiverDescription[] {
  let first: RiverDescription | undefined;
  for (const turn of turns) {
    for (const sign of signs) {
      const river = trace(sign, turn);
      first ??= river;
      if (staysInland(coast, river, size, clear)) return [river];
    }
  }
  return clear === CORE_CLEAR && first !== undefined ? [first] : [];
}

/** From inland to the head of the delta, a little to one side of the core. The islets' channels carry it on. */
function deltaTrunk(seed: number, sites: SiteLayout, rng: Rng, size: number, coast: CoastAt, clear: number): RiverDescription[] {
  const seaward = Math.atan2(sites.waterfront.y, sites.waterfront.x);
  const mouth = shoreToward(coast, { x: 0, y: 0 }, seaward + (rng.chance(0.5) ? 1 : -1) * rng.range(0.3, 0.6), size);
  const mouthDir = Math.atan2(mouth.y, mouth.x);
  const sign = rng.chance(0.5) ? 1 : -1;
  const turn = rng.range(0.6, 1.1);
  return inlandRiver(coast, size, clear, [sign, -sign], [turn, 0.9, 0.6], (s, t) =>
    traceRiver(seed, 0, sourceAlong(coast, mouthDir + Math.PI + s * t, size), mouth, size, 1.3),
  );
}

/**
 * Metres inland a spine river's source stands at least. The shore the coast
 * reading measures from is the plan's; the drawn shore wanders from it, and a
 * source close to it cuts through to the sea behind.
 */
const SPINE_SOURCE = 300;

/** Across the spine, where the short rivers start: fractions of the map either side of the core. */
const SPINE_PLACES = [-0.34, -0.26, 0.26, 0.34];

/** Short, narrow rivers from the flank of the spine straight down to the sea, clear of the core. */
function spineRivers(
  seed: number,
  sites: SiteLayout,
  rng: Rng,
  size: number,
  coast: CoastAt,
  count: number,
  clear: number,
): RiverDescription[] {
  const spine = sites.spine;
  if (spine === undefined) return [];
  const along = Math.atan2(spine.to.y - spine.from.y, spine.to.x - spine.from.x);
  // The direction from the spine to the sea: across the spine, on the side the waterfront lies.
  let seaward = along + Math.PI / 2;
  const mid = { x: (spine.from.x + spine.to.x) / 2, y: (spine.from.y + spine.to.y) / 2 };
  if (Math.cos(seaward) * (sites.waterfront.x - mid.x) + Math.sin(seaward) * (sites.waterfront.y - mid.y) < 0) seaward += Math.PI;
  const places = rng.shuffle([...SPINE_PLACES]);
  const out: RiverDescription[] = [];
  for (let k = 0; k < places.length && out.length < count; k++) {
    const b = ((places[k] as number) + rng.range(-0.03, 0.03)) * size;
    const foot = { x: mid.x + Math.cos(along) * b, y: mid.y + Math.sin(along) * b };
    const start = size * rng.range(0.06, 0.1);
    const source = { x: foot.x + Math.cos(seaward) * start, y: foot.y + Math.sin(seaward) * start };
    if (coast(source.x, source.y) > -SPINE_SOURCE) continue;
    const mouth = shoreToward(coast, source, seaward, size);
    if (Math.hypot(mouth.x - source.x, mouth.y - source.y) < size * 0.1) continue;
    const river = traceRiver(seed, k, source, mouth, size, 0.6);
    if (staysInland(coast, river, size, clear)) out.push(river);
  }
  return out;
}

/** A meandering river from source to mouth. `k` keeps two rivers of one map from meandering alike. */
function traceRiver(seed: number, k: number, source: Point, mouth: Point, size: number, width: number): RiverDescription {
  const noise = new Noise2D(seed ^ 0x51e4);
  const steps = 96;
  const path: Point[] = [];
  const halfWidths: number[] = [];
  const dx = mouth.x - source.x;
  const dy = mouth.y - source.y;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Meander fades to zero at both ends so the source and mouth stay put.
    const envelope = Math.sin(t * Math.PI);
    const meander = noise.fbm(t * 3.2 + 3.1, 0.7 + k * 5.3, 2, 2, 0.35) * size * 0.05 * envelope;
    path.push({ x: source.x + dx * t + nx * meander, y: source.y + dy * t + ny * meander });
    halfWidths.push(lerp(size * 0.003, size * 0.009, smoothstep(0, 1, t)) * width);
  }
  return { path, halfWidths };
}

/** Cut the river valley: bed below sea level, banks blending into the hillside. */
export function carveRiver(hf: Heightfield, river: RiverDescription): void {
  const bed = -4;
  const bank = 70;
  const path = river.path;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i] as Point;
    const b = path[i + 1] as Point;
    const hw = river.halfWidths[i] as number;
    const reach = hw + bank;
    const minX = Math.min(a.x, b.x) - reach;
    const maxX = Math.max(a.x, b.x) + reach;
    const minY = Math.min(a.y, b.y) - reach;
    const maxY = Math.max(a.y, b.y) + reach;
    const ix0 = clamp(Math.floor((minX - hf.originX) / hf.cellSize), 0, hf.gridSize - 1);
    const ix1 = clamp(Math.ceil((maxX - hf.originX) / hf.cellSize), 0, hf.gridSize - 1);
    const iy0 = clamp(Math.floor((minY - hf.originY) / hf.cellSize), 0, hf.gridSize - 1);
    const iy1 = clamp(Math.ceil((maxY - hf.originY) / hf.cellSize), 0, hf.gridSize - 1);
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = hf.worldX(ix);
        const y = hf.worldY(iy);
        const d = segmentDistance(x, y, a, b);
        if (d > reach) continue;
        const h = hf.at(ix, iy);
        const target = d < hw ? bed : lerp(bed, h, smoothstep(hw, reach, d));
        if (target < h) hf.set(ix, iy, target);
      }
    }
  }
}

/** Metres past its radius the harbour's basin blends back into the ground. */
const HARBOUR_REACH = 60;

export function carveHarbour(hf: Heightfield, harbour: Harbour): void {
  const depth = -9;
  const reach = harbour.radius + HARBOUR_REACH;
  const ix0 = clamp(Math.floor((harbour.x - reach - hf.originX) / hf.cellSize), 0, hf.gridSize - 1);
  const ix1 = clamp(Math.ceil((harbour.x + reach - hf.originX) / hf.cellSize), 0, hf.gridSize - 1);
  const iy0 = clamp(Math.floor((harbour.y - reach - hf.originY) / hf.cellSize), 0, hf.gridSize - 1);
  const iy1 = clamp(Math.ceil((harbour.y + reach - hf.originY) / hf.cellSize), 0, hf.gridSize - 1);
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const d = Math.hypot(hf.worldX(ix) - harbour.x, hf.worldY(iy) - harbour.y);
      if (d > reach) continue;
      const h = hf.at(ix, iy);
      const target = d < harbour.radius ? depth : lerp(depth, h, smoothstep(harbour.radius, reach, d));
      if (target < h) hf.set(ix, iy, target);
    }
  }
}

export function segmentDistance(px: number, py: number, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? ((px - a.x) * vx + (py - a.y) * vy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (a.x + vx * t), py - (a.y + vy * t));
}
