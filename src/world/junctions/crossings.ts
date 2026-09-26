/**
 * Where the roads may bridge the water (spec section 7.2): one shore-to-shore
 * crossing between each pair of neighbouring islands, at the narrowest place
 * of the water between them.
 */
import { atan2, cos, hypot, sin } from '../../core/libm.ts';
import { industryAngle } from '../terrain/districts.ts';
import { GradedLand } from '../carve/graded-land.ts';
import type { Heightfield } from '../terrain/heightfield.ts';
import { coastNoise, islandAt, islandIndexAt, SEA_LEVEL, type CoastNoise, type TerrainLayout } from '../terrain/terrain.ts';
import { TIERS } from '../roads/tiers.ts';
import type { Crossing, Island, Point, Site, WaterDescription } from '../types.ts';

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
  return found.span + CORE_PULL * hypot((found.from.x + found.to.x) / 2, (found.from.y + found.to.y) / 2);
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

/**
 * Shore-to-shore crossings between neighbouring islands. The search runs along
 * the line between a cell of one island and a cell of the other, from the
 * nearest few pairs of cells, and keeps the best chord. An island of one cell
 * has one line to try. Only lines that stay within the two islands' cells
 * qualify.
 */
function findCrossings(hf: Heightfield, layout: TerrainLayout, noise: CoastNoise): Crossing[] {
  const out: Crossing[] = [];
  const islands = layout.islands;
  // The land an arterial can climb to from the core (`graded-land.ts`). A
  // bridge whose head lands outside it stands in a pocket of ground that steep
  // slopes close off, where no arterial runs, and the roads never build it. The
  // flood hops no crossing, because the crossings are what this search finds.
  const graded = new GradedLand(hf, layout.core, TIERS.arterial.maxGrade);
  for (let i = 0; i < islands.length; i++) {
    for (let j = i + 1; j < islands.length; j++) {
      const crossing = crossingBetween(hf, layout, noise, graded, i, j);
      if (crossing !== undefined) out.push(crossing);
    }
  }
  return out;
}

/** The crossing between islands `i` and `j`, or undefined where no chord bridges two islands. */
function crossingBetween(hf: Heightfield, layout: TerrainLayout, noise: CoastNoise, graded: GradedLand, i: number, j: number): Crossing | undefined {
  let best: Found | undefined;
  const search = (pairs: readonly { from: Site; to: Site }[], joining = false): void => {
    for (const pair of pairs) {
      const found = searchLine(hf, layout, noise, graded, i, j, pair.from, pair.to);
      if (found === undefined || (joining && !found.straddles)) continue;
      if (best === undefined || beats(found, best, worth)) best = found;
    }
  };
  search(cellPairs(layout, i, j).slice(0, CELL_PAIRS));
  // The middle of a cell can stand in the sea: a thin island's cell is wider
  // than the land it leaves, and a line to it runs out into the water before
  // it reaches the island. The island's own site stands on its land, so the
  // lines between the two sites and the cells are searched as well before
  // the pair is given up (issue #720, seed 1799071266). Only a chord that
  // joins the two is taken there, so no pair gains a crossing it did not
  // need.
  if (best === undefined) search(sitePairs(layout, i, j), true);
  if (best === undefined) return undefined;
  const { from, to } = best;
  // The islands the chord reached, not the pair it was searched for: where
  // no chord joins that pair, the best one found still links the two shores
  // it does stand on, and a crossing must name them. One that came back to
  // a single island bridges nothing and is dropped.
  const fromIsland = landIdAt(layout, noise, from);
  const toIsland = landIdAt(layout, noise, to);
  if (fromIsland === toIsland) return undefined;
  return { fromIsland, toIsland, from, to };
}

/** Every pair of a cell of island `i` and a cell of island `j`, nearest first, that the search may run between. */
function cellPairs(layout: TerrainLayout, i: number, j: number): { from: Site; to: Site; d: number }[] {
  const a = layout.islands[i] as Island;
  const b = layout.islands[j] as Island;
  const pairs: { from: Site; to: Site; d: number }[] = [];
  for (const from of a.cells ?? [a]) {
    for (const to of b.cells ?? [b]) pairs.push({ from, to, d: hypot(to.x - from.x, to.y - from.y) });
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
  return pairs;
}

/** The pairs of {@link cellPairs} that take the site of one island or of both in place of a cell. */
function sitePairs(layout: TerrainLayout, i: number, j: number): { from: Site; to: Site }[] {
  const a = layout.islands[i] as Island;
  const b = layout.islands[j] as Island;
  const pairs: { from: Site; to: Site }[] = [{ from: a, to: b }];
  for (const to of b.cells ?? []) pairs.push({ from: a, to });
  for (const from of a.cells ?? []) pairs.push({ from, to: b });
  const half = layout.size / 2 - layout.seaMargin;
  return pairs.filter((pair) => Math.abs((pair.from.x + pair.to.x) / 2) < half && Math.abs((pair.from.y + pair.to.y) / 2) < half);
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
  const len = hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  // Sample ownership and wetness along the line; the strait is the wet run around the ownership flip.
  const step = hf.cellSize / 2;
  const count = Math.floor(len / step);
  const sampled = sampleLine(hf, islands, i, j, start, ux, uy, step, count);
  if (sampled === undefined) return undefined;
  const run = wetRun(sampled.wet, sampled.flip, count);
  if (run === undefined) return undefined;
  // Slide along the strait (perpendicular to the site line) looking for its narrowest point.
  const mid = (run.lo + run.hi) / 2;
  const mx = start.x + ux * mid * step;
  const my = start.y + uy * mid * step;
  const reaches = (chord: { from: Point; to: Point }): boolean => joins(layout, noise, a, b, chord);
  const found = (chord: { from: Point; to: Point }): Found | undefined => foundChord(hf, layout, graded, reaches, chord);
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
 * Wetness at every sample along a line of search, and the first sample on
 * island `j`. Undefined where the line leaves the two islands or never
 * reaches `j`.
 */
function sampleLine(
  hf: Heightfield,
  islands: readonly Island[],
  i: number,
  j: number,
  start: Point,
  ux: number,
  uy: number,
  step: number,
  count: number,
): { wet: boolean[]; flip: number } | undefined {
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
  return flip < 0 ? undefined : { wet, flip };
}

/**
 * The run of wet samples around the ownership flip: the strait. Undefined
 * where no wet sample is near, or the run reaches an end of the line.
 */
function wetRun(wet: readonly boolean[], flip: number, count: number): { lo: number; hi: number } | undefined {
  let lo = flip;
  let hi = flip;
  if (!wet[flip]) {
    // The flip landed on land (a wandering shore); find the nearest wet sample.
    const found = nearestWet(wet, flip, count);
    if (found < 0) return undefined;
    lo = found;
    hi = found;
  }
  while (lo > 0 && wet[lo - 1]) lo--;
  while (hi < count && wet[hi + 1]) hi++;
  if (lo === 0 || hi === count) return undefined;
  return { lo, hi };
}

/** The wet sample nearest a dry one, the one before it first on a tie; -1 where none is. */
function nearestWet(wet: readonly boolean[], flip: number, count: number): number {
  for (let d = 1; d < count; d++) {
    if (wet[flip - d]) return flip - d;
    if (wet[flip + d]) return flip + d;
  }
  return -1;
}

/** A chord ranked, or undefined where an end of it is in the water and found no shore to land on. */
function foundChord(
  hf: Heightfield,
  layout: TerrainLayout,
  graded: GradedLand,
  reaches: (chord: { from: Point; to: Point }) => boolean,
  chord: { from: Point; to: Point },
): Found | undefined {
  const landed = hf.sample(chord.from.x, chord.from.y) >= SEA_LEVEL && hf.sample(chord.to.x, chord.to.y) >= SEA_LEVEL;
  if (!landed) return undefined;
  const span = hypot(chord.to.x - chord.from.x, chord.to.y - chord.from.y);
  const short = span < layout.size * GRADED_SPAN;
  return { from: chord.from, to: chord.to, span, straddles: reaches(chord), graded: short && (graded.near(chord.from) || graded.near(chord.to)) };
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
  const base = atan2(uy, ux);
  let best: { from: Point; to: Point; span: number; straddles: boolean } | undefined;
  for (let k = -6; k <= 6; k++) {
    const a = base + (k * Math.PI) / 16;
    const dx = cos(a);
    const dy = sin(a);
    const back = shoreAlong(hf, mx, my, -dx, -dy, step);
    const fore = shoreAlong(hf, mx, my, dx, dy, step);
    if (!back || !fore) continue;
    const span = hypot(fore.x - back.x, fore.y - back.y);
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
