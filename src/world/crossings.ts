/**
 * Where the roads may bridge the water (spec section 7.2): one shore-to-shore
 * crossing between each pair of neighbouring islands, at the narrowest place
 * of the water between them.
 */
import { industryAngle } from './districts.ts';
import type { Heightfield } from './heightfield.ts';
import { DRY_MARGIN } from './road-ground.ts';
import { coastNoise, islandAt, islandIndexAt, SEA_LEVEL, type CoastNoise, type TerrainLayout } from './terrain.ts';
import { TIERS } from './tiers.ts';
import type { Crossing, Island, Point, Site, WaterDescription } from './types.ts';

/** Metres of land a bridge head needs behind it, so a crossing never lands on a rock in the strait. */
const LANDFALL = 120;

/** The id of the island whose land a point stands on. */
function landIdAt(layout: TerrainLayout, noise: CoastNoise, p: Point): number {
  return (layout.islands[islandAt(layout.islands, layout.size, noise, p.x, p.y)] as Island).id;
}

/**
 * True when a chord runs from one of the two islands to the other, which is
 * what makes it their crossing. A chord that comes back to its own shore
 * bridges nothing, and one that reaches a third island is some other pair's
 * crossing, not this one's.
 */
function joins(layout: TerrainLayout, noise: CoastNoise, a: Island, b: Island, chord: { from: Point; to: Point }): boolean {
  const from = landIdAt(layout, noise, chord.from);
  const to = landIdAt(layout, noise, chord.to);
  return (from === a.id && to === b.id) || (from === b.id && to === a.id);
}

/** How many pairs of cells, nearest first, the crossing between two islands is searched from. */
const CELL_PAIRS = 6;

/**
 * Metres of span a crossing is worth trading for each metre it stands nearer the
 * core, when two lines of search find two chords. A bridge far out on the map
 * lands where no road runs yet, so the roads never build it.
 */
const CORE_PULL = 0.25;

/** How a chord ranks against another between the same two islands: less is better. */
function worth(found: Found): number {
  return found.span + CORE_PULL * Math.hypot((found.from.x + found.to.x) / 2, (found.from.y + found.to.y) / 2);
}

/**
 * A chord and what it is worth: shorter is better, one that lands on graded
 * ground beats any that does not, and one that joins the pair beats both.
 */
interface Found {
  from: Point;
  to: Point;
  span: number;
  straddles: boolean;
  graded: boolean;
}

/** True when chord `a` beats chord `b` on what joins and what lands, with `value` to break the tie: less is better. */
function beats(a: Found, b: Found, value: (f: Found) => number): boolean {
  if (a.straddles !== b.straddles) return a.straddles;
  if (a.graded !== b.graded) return a.graded;
  return value(a) < value(b);
}

/**
 * The longest span, as a fraction of the map side, that lands on graded ground
 * to the ranking. A longer chord is a long bridge, and a short one into a
 * pocket of steep ground is the better trade.
 */
const GRADED_SPAN = 0.115;

/** Grid steps around a bridge head searched for the graded ground it stands on. */
const HEAD_REACH = 3;

/**
 * The land an arterial can climb to from the core: every grid node joined to
 * the core by straight steps over dry ground no steeper than the arterial's
 * grade. A bridge whose head lands outside it lands in a pocket of ground
 * that steep slopes close off, where no arterial runs, and the roads never
 * build it.
 */
class GradedLand {
  private readonly hf: Heightfield;
  private readonly reached: Uint8Array;

  constructor(hf: Heightfield, core: Point) {
    this.hf = hf;
    const n = hf.gridSize;
    const rise = TIERS.arterial.maxGrade * hf.cellSize;
    const dry = SEA_LEVEL + DRY_MARGIN;
    const reached = new Uint8Array(n * n);
    const queue = new Int32Array(n * n);
    const cx = Math.round((core.x - hf.originX) / hf.cellSize);
    const cy = Math.round((core.y - hf.originY) / hf.cellSize);
    let tail = 0;
    if (cx >= 0 && cy >= 0 && cx < n && cy < n) {
      reached[cy * n + cx] = 1;
      queue[tail++] = cy * n + cx;
    }
    for (let head = 0; head < tail; head++) {
      const at = queue[head] as number;
      const ix = at % n;
      const iy = (at - ix) / n;
      const h = hf.heights[at] as number;
      for (let k = 0; k < 4; k++) {
        const jx = ix + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const jy = iy + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (jx < 0 || jy < 0 || jx >= n || jy >= n) continue;
        const to = jy * n + jx;
        const g = hf.heights[to] as number;
        if (reached[to] === 1 || g < dry || Math.abs(g - h) > rise) continue;
        reached[to] = 1;
        queue[tail++] = to;
      }
    }
    this.reached = reached;
  }

  /** True when a graded node stands within a few grid steps of a point. */
  near(p: Point): boolean {
    const hf = this.hf;
    const n = hf.gridSize;
    const cx = Math.round((p.x - hf.originX) / hf.cellSize);
    const cy = Math.round((p.y - hf.originY) / hf.cellSize);
    for (let iy = Math.max(0, cy - HEAD_REACH); iy <= Math.min(n - 1, cy + HEAD_REACH); iy++) {
      for (let ix = Math.max(0, cx - HEAD_REACH); ix <= Math.min(n - 1, cx + HEAD_REACH); ix++) {
        if (this.reached[iy * n + ix] === 1) return true;
      }
    }
    return false;
  }
}

/**
 * Shore-to-shore crossings between neighbouring islands. The search runs along
 * the line between a cell of one island and a cell of the other, from the
 * nearest few pairs of cells, and keeps the best chord. An island of one cell
 * has one line to try. Only lines that stay within the two islands' cells
 * qualify.
 */
export function findCrossings(hf: Heightfield, layout: TerrainLayout, noise: CoastNoise): Crossing[] {
  const out: Crossing[] = [];
  const islands = layout.islands;
  const graded = new GradedLand(hf, layout.core);
  for (let i = 0; i < islands.length; i++) {
    for (let j = i + 1; j < islands.length; j++) {
      const a = islands[i] as Island;
      const b = islands[j] as Island;
      const pairs: { from: Site; to: Site; d: number }[] = [];
      for (const from of a.cells ?? [a]) {
        for (const to of b.cells ?? [b]) pairs.push({ from, to, d: Math.hypot(to.x - from.x, to.y - from.y) });
      }
      // A pair whose line crosses outside the map searches the sea margin, where no shore stands.
      const half = layout.size / 2 - layout.seaMargin;
      pairs.sort((p, q) => p.d - q.d);
      for (let k = pairs.length - 1; k >= 0; k--) {
        const pair = pairs[k] as { from: Site; to: Site };
        const mx = (pair.from.x + pair.to.x) / 2;
        const my = (pair.from.y + pair.to.y) / 2;
        if (Math.abs(mx) >= half || Math.abs(my) >= half) pairs.splice(k, 1);
      }
      let best: Found | undefined;
      for (const pair of pairs.slice(0, CELL_PAIRS)) {
        const found = searchLine(hf, layout, noise, graded, i, j, pair.from, pair.to);
        if (found === undefined) continue;
        if (best === undefined || beats(found, best, worth)) best = found;
      }
      if (best === undefined) continue;
      const { from, to } = best;
      // The islands the chord reached, not the pair it was searched for: where
      // no chord joins that pair, the best one found still links the two shores
      // it does stand on, and a crossing must name them. One that came back to
      // a single island bridges nothing and is dropped.
      const fromIsland = landIdAt(layout, noise, from);
      const toIsland = landIdAt(layout, noise, to);
      if (fromIsland === toIsland) continue;
      out.push({ fromIsland, toIsland, from, to });
    }
  }
  return out;
}

/** The best chord across the water between islands `i` and `j`, searched along the line from one site to the other. */
function searchLine(
  hf: Heightfield,
  layout: TerrainLayout,
  noise: CoastNoise,
  graded: GradedLand,
  i: number,
  j: number,
  start: Point,
  end: Point,
): Found | undefined {
  const islands = layout.islands;
  const a = islands[i] as Island;
  const b = islands[j] as Island;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  // Sample ownership and wetness along the line; the strait is the wet run around the ownership flip.
  const step = hf.cellSize / 2;
  const count = Math.floor(len / step);
  let flip = -1;
  const wet: boolean[] = [];
  for (let k = 0; k <= count; k++) {
    const x = start.x + ux * k * step;
    const y = start.y + uy * k * step;
    const owner = islandIndexAt(islands, x, y);
    if (owner !== i && owner !== j) return undefined;
    if (owner === j && flip < 0) flip = k;
    wet.push(hf.sample(x, y) < SEA_LEVEL);
  }
  if (flip < 0) return undefined;
  let lo = flip;
  let hi = flip;
  if (!wet[flip]) {
    // The flip landed on land (a wandering shore); find the nearest wet sample.
    let found = -1;
    for (let d = 1; d < count && found < 0; d++) {
      if (wet[flip - d]) found = flip - d;
      else if (wet[flip + d]) found = flip + d;
    }
    if (found < 0) return undefined;
    lo = hi = found;
  }
  while (lo > 0 && wet[lo - 1]) lo--;
  while (hi < count && wet[hi + 1]) hi++;
  if (lo === 0 || hi === count) return undefined;
  // Slide along the strait (perpendicular to the site line) looking for its narrowest point.
  const mid = (lo + hi) / 2;
  const mx = start.x + ux * mid * step;
  const my = start.y + uy * mid * step;
  const reaches = (chord: { from: Point; to: Point }): boolean => joins(layout, noise, a, b, chord);
  // A chord with an end in the water found no shore to land on.
  const landed = (chord: { from: Point; to: Point }): boolean =>
    hf.sample(chord.from.x, chord.from.y) >= SEA_LEVEL && hf.sample(chord.to.x, chord.to.y) >= SEA_LEVEL;
  const found = (chord: { from: Point; to: Point }): Found | undefined => {
    if (!landed(chord)) return undefined;
    const span = Math.hypot(chord.to.x - chord.from.x, chord.to.y - chord.from.y);
    const short = span < layout.size * GRADED_SPAN;
    return { from: chord.from, to: chord.to, span, straddles: reaches(chord), graded: short && (graded.near(chord.from) || graded.near(chord.to)) };
  };
  const spanOf = (f: Found): number => f.span;
  let best = found(narrowestChord(hf, mx, my, ux, uy, reaches));
  for (const sign of [-1, 1]) {
    for (let d = 40; d <= layout.size * 0.15; d += 40) {
      const px = mx - uy * d * sign;
      const py = my + ux * d * sign;
      if (hf.sample(px, py) >= SEA_LEVEL) break;
      const candidate = found(narrowestChord(hf, px, py, ux, uy, reaches));
      // Sliding along a strait can wander into a bay of one island, where the
      // narrowest chord lands on that island twice and bridges nothing, or
      // out to a third island. A chord that reaches the far island always
      // beats one that does not.
      if (candidate !== undefined && (best === undefined || beats(candidate, best, spanOf))) best = candidate;
    }
  }
  return best;
}

/**
 * From a point in a strait, the shortest shore-to-shore chord through it, tried
 * over a fan of directions. A chord that reaches the far island wins over a
 * shorter one that comes back to the near island's own shore.
 */
function narrowestChord(
  hf: Heightfield,
  mx: number,
  my: number,
  ux: number,
  uy: number,
  reaches: (chord: { from: Point; to: Point }) => boolean,
): { from: Point; to: Point } {
  const step = hf.cellSize / 2;
  const base = Math.atan2(uy, ux);
  let best: { from: Point; to: Point; span: number; straddles: boolean } | undefined;
  for (let k = -6; k <= 6; k++) {
    const a = base + (k * Math.PI) / 16;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const back = shoreAlong(hf, mx, my, -dx, -dy, step);
    const fore = shoreAlong(hf, mx, my, dx, dy, step);
    if (!back || !fore) continue;
    const span = Math.hypot(fore.x - back.x, fore.y - back.y);
    const straddling = reaches({ from: back, to: fore });
    if (best === undefined || (straddling === best.straddles ? span < best.span : straddling)) {
      best = { from: back, to: fore, span, straddles: straddling };
    }
  }
  return best ?? { from: { x: mx - ux * step, y: my - uy * step }, to: { x: mx + ux * step, y: my + uy * step } };
}

/**
 * Walking out from a point in the water, the first shore a bridge can land on.
 * Land that stops again within {@link LANDFALL} metres is a rock in the strait,
 * not a shore, and the walk goes on past it.
 */
function shoreAlong(hf: Heightfield, x: number, y: number, dx: number, dy: number, step: number): Point | undefined {
  const limit = hf.extent;
  for (let s = 0; s < limit; s += step) {
    const px = x + dx * s;
    const py = y + dy * s;
    if (Math.abs(px) > hf.extent / 2 || Math.abs(py) > hf.extent / 2) return undefined;
    if (hf.sample(px, py) < SEA_LEVEL) continue;
    let solid = true;
    for (let t = step; t <= LANDFALL && solid; t += step) {
      if (hf.sample(px + dx * t, py + dy * t) < SEA_LEVEL) solid = false;
    }
    if (!solid) continue;
    const inland = { x: px + dx * step, y: py + dy * step };
    return hf.sample(inland.x, inland.y) >= SEA_LEVEL ? inland : { x: px, y: py };
  }
  return undefined;
}

export function describeWater(seed: number, hf: Heightfield, layout: TerrainLayout): WaterDescription {
  return {
    seaLevel: SEA_LEVEL,
    islands: layout.islands,
    crossings: findCrossings(hf, layout, coastNoise(seed)),
    rivers: layout.rivers,
    harbour: layout.harbour,
    industry: industryAngle(hf, layout.size, layout.core, layout.harbour),
  };
}
