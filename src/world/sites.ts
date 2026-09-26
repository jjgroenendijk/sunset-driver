/**
 * The sites of the power diagram the land is cut from, one placement rule per
 * `SitePattern` of spec section 7.2.
 *
 * A land site belongs to one island, and an island may hold several: no
 * channel runs between two cells of one island, so a landmass takes any shape
 * a union of convex cells can take. A sea site is a cell of open water. Its
 * cell is not land whatever island stands next to it, which is how a bay, a
 * strait and a lagoon are cut. Every pattern keeps the core at the origin, on
 * a cell of the main island.
 */
import type { Rng } from '../core/rng.ts';
import { atan2, cos, hypot, sin } from '../core/libm.ts';
import type { SiteProfile, TerrainArchetype } from './archetype.ts';
import type { Island, Point, Site } from './types.ts';

export interface SiteLayout {
  islands: Island[];
  /** Cells of open water. */
  seas: Site[];
  /** The ridge line the relief of a `spine` archetype climbs towards. */
  spine: { from: Point; to: Point } | undefined;
  /** A point in the water the core faces: the harbour of a `waterfront` archetype looks this way. */
  waterfront: Point;
}

/** Place the sites of an archetype. `size` is the side of the map in metres. */
export function placeSites(archetype: TerrainArchetype, rng: Rng, size: number): SiteLayout {
  const sites = archetype.sites;
  switch (sites.pattern) {
    case 'scatter':
      return scatter(sites, rng, size);
    case 'bay':
      return bay(sites, rng, size);
    case 'strait':
      return strait(sites, rng, size);
    case 'delta':
      return delta(sites, rng, size);
    case 'ridge':
      return ridge(sites, rng, size);
    case 'lagoon':
      return lagoon(sites, rng, size);
  }
}

/** Places given as fractions of the map along a direction `u` and across it, turned into metres. */
class Frame {
  private readonly cos: number;
  private readonly sin: number;
  private readonly size: number;

  constructor(angle: number, size: number) {
    this.cos = cos(angle);
    this.sin = sin(angle);
    this.size = size;
  }

  /** The point `along` of the way down `u` and `across` of the way to its left, in metres. */
  at(along: number, across: number): Point {
    return {
      x: (along * this.cos - across * this.sin) * this.size,
      y: (along * this.sin + across * this.cos) * this.size,
    };
  }

  /** The direction, in world terms, of a step `along` and `across`. */
  angleOf(along: number, across: number): number {
    const p = this.at(along, across);
    return atan2(p.y, p.x);
  }

  site(along: number, across: number, radius: number): Site {
    const p = this.at(along, across);
    return { x: p.x, y: p.y, radius: radius * this.size };
  }
}

/**
 * An island of one or more cells; its own site is the first. `nominal` is the
 * size the zones read it at, in metres (`districts.ts`); by default the weight
 * of its first cell.
 */
function island(id: number, cells: Site[], main: boolean, nominal?: number): Island {
  const first = cells[0] as Site;
  const out: Island = { id, x: first.x, y: first.y, radius: nominal ?? first.radius, main };
  if (cells.length > 1 || out.radius !== first.radius) out.cells = cells;
  return out;
}

const span = (rng: Rng, s: { min: number; max: number }): number => rng.range(s.min, s.max);

/** A few islands scattered round the core and relaxed, so each sits deep inside its cell. The archipelago. */
function scatter(sites: SiteProfile, rng: Rng, size: number): SiteLayout {
  const islands: Island[] = [];
  islands.push({ id: 0, x: 0, y: 0, radius: size * span(rng, sites.mainRadius), main: true });
  const count = rng.int(sites.outerCount.min, sites.outerCount.max);
  const minSpacing = size * sites.minSpacing;
  for (let i = 1; i <= count; i++) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const x = rng.range(-sites.spread, sites.spread) * size;
      const y = rng.range(-sites.spread, sites.spread) * size;
      let ok = hypot(x, y) >= minSpacing;
      for (const other of islands) if (hypot(other.x - x, other.y - y) < minSpacing) ok = false;
      if (!ok) continue;
      islands.push({ id: i, x, y, radius: size * span(rng, sites.outerRadius), main: false });
      break;
    }
  }
  relaxSites(islands, size, sites.relaxRounds);
  return { islands, seas: [], spine: undefined, waterfront: { x: 0, y: 0 } };
}

/** Lloyd relaxation of the outer sites (the main site stays at the core) so each sits deep inside its cell. */
function relaxSites(islands: Island[], size: number, rounds: number): void {
  const n = 40;
  for (let iter = 0; iter < rounds; iter++) {
    const sx = new Float64Array(islands.length);
    const sy = new Float64Array(islands.length);
    const cnt = new Float64Array(islands.length);
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const x = ((ix + 0.5) / n - 0.5) * size;
        const y = ((iy + 0.5) / n - 0.5) * size;
        const k = nearestSite(islands, x, y);
        sx[k] = (sx[k] as number) + x;
        sy[k] = (sy[k] as number) + y;
        cnt[k] = (cnt[k] as number) + 1;
      }
    }
    for (let k = 1; k < islands.length; k++) {
      const c = cnt[k] as number;
      if (c === 0) continue;
      const isl = islands[k] as Island;
      isl.x = (sx[k] as number) / c;
      isl.y = (sy[k] as number) / c;
    }
  }
}

/** The island whose power cell holds a place: the least squared distance less squared radius, the first on a tie. */
function nearestSite(islands: readonly Island[], x: number, y: number): number {
  let k = 0;
  let best = Infinity;
  for (let i = 0; i < islands.length; i++) {
    const isl = islands[i] as Island;
    const p = (x - isl.x) ** 2 + (y - isl.y) ** 2 - isl.radius * isl.radius;
    if (p < best) {
      best = p;
      k = i;
    }
  }
  return k;
}

/** The main island as one cell at the core and a ring of cells round it at `reach`, skipping the arc about `gap`. */
function ringAround(frame: Frame, main: number, reach: number, gap: number, gapHalf: number, rng: Rng): Site[] {
  const cells: Site[] = [frame.site(0, 0, main)];
  const steps = 8;
  for (let k = 0; k < steps; k++) {
    const angle = (k / steps) * Math.PI * 2 + rng.range(-0.15, 0.15);
    const off = atan2(sin(angle - gap), cos(angle - gap));
    if (Math.abs(off) < gapHalf) continue;
    const r = reach + rng.range(-0.03, 0.03);
    cells.push(frame.site(cos(angle) * r, sin(angle) * r, main * 0.8));
  }
  return cells;
}


/**
 * An island near a shore, with sea sites on the sides of it that face open
 * water. On the side with no sea site its cell meets the land, so only a
 * channel parts the two and the crossing to it stays short. All lengths are in
 * metres: `weight` is the weight of the sea sites and `reach` their distance
 * from the island's site. `open` lists the directions of the sea sites.
 */
function islet(id: number, at: Point, weight: number, reach: number, open: readonly number[]): { island: Island; seas: Site[] } {
  const seas: Site[] = open.map((a) => ({ x: at.x + cos(a) * reach, y: at.y + sin(a) * reach, radius: weight }));
  const site: Site = { x: at.x, y: at.y, radius: weight + reach * 0.3 };
  return { island: island(id, [site], false, reach / 2), seas };
}

/** Directions in an arc of `half` either side of `facing`, `count` of them. */
function arc(facing: number, half: number, count: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(facing - half + (2 * half * k) / (count - 1));
  return out;
}

/**
 * One landmass with a bay reaching in towards the core down a random direction,
 * and an island inside it. The sea sites run in a line from past the map edge
 * to the head of the bay.
 */
function bay(sites: SiteProfile, rng: Rng, size: number): SiteLayout {
  const frame = new Frame(rng.range(-Math.PI, Math.PI), size);
  const main = span(rng, sites.mainRadius);
  const cells = ringAround(frame, main, 0.3, 0, 0.5, rng);
  const head = rng.range(0.32, 0.36);
  const step = 0.2;
  // The bay widens towards its mouth.
  const wet = (along: number): number => main * (0.7 + (along - head) * 1.2);
  const count = rng.int(sites.outerCount.min, sites.outerCount.max);
  const islands = [island(0, cells, true)];
  const seas: Site[] = [];
  const side = rng.chance(0.5) ? 1 : -1;
  for (let k = 0; head + k * step < 0.8; k++) {
    const along = head + k * step;
    if (k === 0 || k > count) {
      seas.push(frame.site(along, rng.range(-0.02, 0.02), wet(along)));
      continue;
    }
    // An island takes the place of a sea site, off to one side of the bay, with the bay's water on its other sides.
    seas.push(frame.site(along, -side * 0.06, wet(along)));
    const off = side * rng.range(0.08, 0.11);
    const made = islet(k, frame.at(head + rng.range(0.06, 0.1), off), wet(along) * size, span(rng, sites.outerRadius) * size, arc(frame.angleOf(0, -side), 1.6, 5));
    islands.push(made.island);
    seas.push(...made.seas);
  }
  return { islands, seas, spine: undefined, waterfront: frame.at(head, 0) };
}

/**
 * Two banks split by one wide channel a short way from the core. Both banks'
 * sites stand on lines parallel to the channel, so the bisector between them
 * is the channel itself. The far bank is one island, or is cut across into two.
 */
function strait(sites: SiteProfile, rng: Rng, size: number): SiteLayout {
  const frame = new Frame(rng.range(-Math.PI, Math.PI), size);
  const main = span(rng, sites.mainRadius);
  const offset = rng.range(0.13, 0.18);
  const across = [-0.6, -0.3, 0, 0.3, 0.6];
  const near: Site[] = [frame.site(0, 0, main)];
  for (const b of across) if (b !== 0) near.push(frame.site(rng.range(-0.02, 0.02), b + rng.range(-0.04, 0.04), main));
  const islands = [island(0, near, true)];
  const count = rng.int(sites.outerCount.min, sites.outerCount.max);
  // Where the far bank is cut, as an index into `across`.
  const cuts = count === 1 ? [] : [rng.int(2, 3)];
  let from = 0;
  for (let i = 0; i < count; i++) {
    const to = i < cuts.length ? (cuts[i] as number) : across.length;
    const far: Site[] = [];
    for (let k = from; k < to; k++) {
      far.push(frame.site(2 * offset + rng.range(-0.02, 0.02), (across[k] as number) + rng.range(-0.04, 0.04), main));
    }
    // The site nearest the middle of the map stands for the island.
    far.sort((a, b) => hypot(a.x, a.y) - hypot(b.x, b.y));
    islands.push(island(i + 1, far, false, span(rng, sites.outerRadius) * size));
    from = to;
  }
  return { islands, seas: [], spine: undefined, waterfront: frame.at(offset, 0) };
}

/**
 * Low land that breaks up into a fan of islets towards the sea. The main island
 * holds the core and the ground behind it; the islets stand in a wedge that
 * opens from the head of the delta, just past the core, to the coast.
 */
function delta(sites: SiteProfile, rng: Rng, size: number): SiteLayout {
  const frame = new Frame(rng.range(-Math.PI, Math.PI), size);
  const main = span(rng, sites.mainRadius);
  const cells: Site[] = [frame.site(0, 0, main)];
  for (const b of [-0.34, 0, 0.34]) cells.push(frame.site(-0.3 + rng.range(-0.03, 0.03), b + rng.range(-0.04, 0.04), main));
  for (const b of [-0.3, 0.3]) cells.push(frame.site(rng.range(-0.03, 0.03), b + rng.range(-0.04, 0.04), main * 0.8));
  const islands = [island(0, cells, true)];
  const head = rng.range(0.12, 0.15);
  const count = rng.int(sites.outerCount.min, sites.outerCount.max);
  const placed: Point[] = [{ x: 0, y: 0 }];
  for (let i = 1; i <= count; i++) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const along = rng.range(head + 0.08, 0.4);
      const wide = 0.06 + 0.7 * (along - head);
      const p = frame.at(along, rng.range(-wide, wide));
      if (placed.some((q) => hypot(q.x - p.x, q.y - p.y) < sites.minSpacing * size)) continue;
      placed.push(p);
      // An islet is small to the zones, whatever its weight, so the suburb it may carry stays clear of the core.
      const site: Site = { x: p.x, y: p.y, radius: span(rng, sites.outerRadius) * size };
      islands.push(island(i, [site], false, size * 0.05));
      break;
    }
  }
  // The sea fronts the fan and wraps round both sides of it, so the delta pushes out into the water.
  const seas: Site[] = [];
  const wet = main * 0.8;
  for (let b = -0.6; b <= 0.6; b += 0.2) seas.push(frame.site(0.56 + Math.abs(b) * 0.05, b, wet));
  for (const b of [-1, 1]) {
    seas.push(frame.site(0.26, b * 0.56, wet));
    seas.push(frame.site(0.42, b * 0.5, wet));
  }
  return { islands, seas, spine: undefined, waterfront: frame.at(head, 0) };
}

/**
 * A straight coast a short way from the core with open sea past it, and a
 * spine of high ground on the far side of the core. The sea sites stand on a
 * line parallel to the coast, the land sites on lines behind it. An island
 * lies off the coast.
 */
function ridge(sites: SiteProfile, rng: Rng, size: number): SiteLayout {
  const frame = new Frame(rng.range(-Math.PI, Math.PI), size);
  const main = span(rng, sites.mainRadius);
  const coast = rng.range(0.14, 0.2);
  const cells: Site[] = [frame.site(0, 0, main)];
  const seas: Site[] = [];
  for (let b = -0.75; b <= 0.75; b += 0.25) {
    if (b !== 0) cells.push(frame.site(rng.range(-0.02, 0.02), b + rng.range(-0.03, 0.03), main));
    cells.push(frame.site(-0.32 + rng.range(-0.03, 0.03), b + 0.125, main));
    seas.push(frame.site(2 * coast + rng.range(-0.02, 0.02), b + rng.range(-0.03, 0.03), main));
  }
  const islands = [island(0, cells, true)];
  const count = rng.int(sites.outerCount.min, sites.outerCount.max);
  for (let i = 1; i <= count; i++) {
    // Off to one side of the core, so the island's cell never reaches it.
    const at = frame.at(coast + rng.range(0.03, 0.05), (rng.chance(0.5) ? 1 : -1) * rng.range(0.2, 0.32));
    const made = islet(i, at, main * size, span(rng, sites.outerRadius) * size, arc(frame.angleOf(1, 0), 1.4, 5));
    islands.push(made.island);
    seas.push(...made.seas);
  }
  const back = -rng.range(0.36, 0.42);
  const spine = { from: frame.at(back, -1), to: frame.at(back, 1) };
  return { islands, seas, spine, waterfront: frame.at(coast, 0) };
}

/**
 * A ring of land round a lagoon, broken by an inlet to the open sea on the far
 * side, with an island in the inlet. The core is the cell of the ring nearest
 * the middle of the map, so the lagoon lies in front of it and the open sea
 * behind.
 */
function lagoon(sites: SiteProfile, rng: Rng, size: number): SiteLayout {
  const toLagoon = rng.range(-Math.PI, Math.PI);
  const reach = rng.range(0.2, 0.24);
  const main = span(rng, sites.mainRadius);
  // `local` measures from the middle of the lagoon; the core is `reach` behind it.
  const frame = new Frame(toLagoon, size);
  const centre = frame.at(reach, 0);
  const local = (along: number, across: number, radius: number): Site => {
    const p = frame.site(along, across, radius);
    return { x: p.x + centre.x, y: p.y + centre.y, radius: p.radius };
  };
  const inlet = rng.range(-0.7, 0.7);
  const cells: Site[] = [{ x: 0, y: 0, radius: main * size }];
  const seas: Site[] = [local(0, 0, main * rng.range(1, 1.1))];
  const steps = 8;
  for (let k = 1; k < steps; k++) {
    const angle = Math.PI + (k / steps) * Math.PI * 2 + rng.range(-0.12, 0.12);
    const off = atan2(sin(angle - inlet), cos(angle - inlet));
    const r = reach + rng.range(-0.02, 0.02);
    const site = local(cos(angle) * r, sin(angle) * r, main);
    if (Math.abs(off) >= 0.45) cells.push(site);
  }
  const outer = reach + rng.range(0.56, 0.62);
  for (let k = 0; k < 14; k++) {
    const angle = (k / 14) * Math.PI * 2;
    seas.push(local(cos(angle) * outer, sin(angle) * outer, main));
  }
  const islands = [island(0, cells, true)];
  const count = rng.int(sites.outerCount.min, sites.outerCount.max);
  for (let i = 1; i <= count; i++) {
    // In the inlet, between the two horns of the ring: water towards the lagoon and towards the sea.
    const r = reach * rng.range(0.95, 1.05);
    const at = local(cos(inlet) * r, sin(inlet) * r, 0);
    const out = frame.angleOf(cos(inlet), sin(inlet));
    const made = islet(i, at, main * size, span(rng, sites.outerRadius) * size, [...arc(out, 0.5, 3), ...arc(out + Math.PI, 0.5, 3)]);
    islands.push(made.island);
    seas.push(...made.seas);
  }
  return { islands, seas, spine: undefined, waterfront: centre };
}
