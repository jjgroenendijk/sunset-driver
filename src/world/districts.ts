import { dist2 } from '../core/math.ts';
import { genRng, Subsystem, type Rng } from '../core/rng.ts';
import type { Beach, Culture, District, Island, Point, WaterDescription, Zone } from './types.ts';
import type { Heightfield } from './heightfield.ts';
import { LandMasses } from './landmass.ts';
import { SEA_LEVEL } from './terrain.ts';

/** Metres above the sea a district site needs; the waterline itself is not buildable. */
const DRY = SEA_LEVEL + 1;

/** Zone ring radii as fractions of the world side length. */
export const ZONE_RADII: Record<Exclude<Zone, 'wilderness' | 'industrial'>, number> = {
  core: 0.06,
  inner: 0.13,
  suburban: 0.22,
  outskirts: 0.32,
};

export interface ZoneLayout {
  size: number;
  core: Point;
  /** Direction from the core toward the harbour; the industrial wedge lies along it. */
  industrialAngle: number;
  industrialHalfAngle: number;
  industrialInner: number;
  industrialOuter: number;
  /** The outer island that is developed as a suburb (the Docklands Mob's island district). */
  suburbIsland: Island | undefined;
}

export function layoutZones(size: number, core: Point, water: WaterDescription): ZoneLayout {
  const outer = water.islands.filter((i) => !i.main);
  outer.sort((a, b) => dist2(a.x, a.y, water.harbour.x, water.harbour.y) - dist2(b.x, b.y, water.harbour.x, water.harbour.y));
  return {
    size,
    core,
    industrialAngle: Math.atan2(water.harbour.y - core.y, water.harbour.x - core.x),
    industrialHalfAngle: (26 * Math.PI) / 180,
    industrialInner: size * 0.09,
    industrialOuter: size * 0.2,
    suburbIsland: outer[0],
  };
}

/** Which zone ring a point falls in, ignoring water. */
export function zoneAt(layout: ZoneLayout, x: number, y: number): Zone {
  const dx = x - layout.core.x;
  const dy = y - layout.core.y;
  const r = Math.hypot(dx, dy);
  const s = layout.size;
  const isl = layout.suburbIsland;
  if (isl && Math.hypot(x - isl.x, y - isl.y) < isl.radius * 1.2) return 'suburban';
  if (r >= layout.industrialInner && r <= layout.industrialOuter) {
    let a = Math.atan2(dy, dx) - layout.industrialAngle;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    if (Math.abs(a) <= layout.industrialHalfAngle) return 'industrial';
  }
  if (r < ZONE_RADII.core * s) return 'core';
  if (r < ZONE_RADII.inner * s) return 'inner';
  if (r < ZONE_RADII.suburban * s) return 'suburban';
  if (r < ZONE_RADII.outskirts * s) return 'outskirts';
  return 'wilderness';
}

const NAMED_INNER: { name: string; culture: Culture }[] = [
  { name: 'Little Italy', culture: 'italian' },
  { name: 'Chinatown', culture: 'chinese' },
  { name: 'The Blocks', culture: 'african-american' },
];

const GENERIC_NAMES: Record<Zone, string[]> = {
  core: ['Downtown', 'Midtown', 'Financial District', 'Old Town'],
  inner: ['Eastside', 'Westgate', 'Riverside', 'Hillcrest', 'Northgate', 'Southbank', 'Kingsway', 'Union Hill'],
  industrial: ['Foundry Row', 'Canal Works', 'Tannery Flats', 'Gasworks'],
  suburban: ['Maple Heights', 'Oakridge', 'Sunnyvale', 'Bayview', 'Pinehurst', 'Fairfield', 'Glenmoor', 'Willow Park', 'Cedar Grove', 'Lakeside'],
  outskirts: ['Route 9', 'Dusty Fork', 'Millbrook', 'Coyote Flats', 'Ridgeway', 'Last Chance'],
  wilderness: ['The Backwoods', 'High Ridge', 'Fox Hollow', 'Bear Creek', 'The Barrens', 'Eagle Pass'],
};

interface SiteSpec {
  zone: Zone;
  count: number;
  density: [number, number];
  wealth: [number, number];
}

const SITE_SPECS: SiteSpec[] = [
  { zone: 'core', count: 3, density: [0.85, 1], wealth: [0.5, 0.95] },
  { zone: 'inner', count: 9, density: [0.55, 0.85], wealth: [0.15, 0.85] },
  { zone: 'industrial', count: 3, density: [0.35, 0.55], wealth: [0.1, 0.35] },
  { zone: 'suburban', count: 10, density: [0.2, 0.45], wealth: [0.3, 0.9] },
  { zone: 'outskirts', count: 6, density: [0.05, 0.2], wealth: [0.1, 0.5] },
  { zone: 'wilderness', count: 6, density: [0, 0.05], wealth: [0.05, 0.4] },
];

/**
 * A site for one district: dry land of the zone, on ground a road can reach.
 * Land that carries no island of the water description is a rock in the sea
 * that no crossing leads to, so a district there could never be built.
 */
function sampleSiteInZone(rng: Rng, layout: ZoneLayout, zone: Zone, hf: Heightfield, land: LandMasses): Point {
  const s = layout.size;
  const rMax: Record<Zone, [number, number]> = {
    core: [0, ZONE_RADII.core],
    inner: [ZONE_RADII.core, ZONE_RADII.inner],
    industrial: [layout.industrialInner / s, layout.industrialOuter / s],
    suburban: [ZONE_RADII.inner, ZONE_RADII.suburban],
    outskirts: [ZONE_RADII.suburban, ZONE_RADII.outskirts],
    wilderness: [ZONE_RADII.outskirts, 0.7],
  };
  const [r0, r1] = rMax[zone];
  for (let attempt = 0; attempt < 200; attempt++) {
    const r = Math.sqrt(rng.range(r0 * r0, r1 * r1)) * s;
    const a = rng.range(-Math.PI, Math.PI);
    const x = layout.core.x + Math.cos(a) * r;
    const y = layout.core.y + Math.sin(a) * r;
    if (Math.abs(x) > s / 2 || Math.abs(y) > s / 2) continue;
    if (zoneAt(layout, x, y) !== zone) continue;
    if (hf.sample(x, y) < DRY) continue;
    if (!land.carriesIsland(x, y)) continue;
    return { x, y };
  }
  // Deterministic fallback: the first dry cell of the zone in grid order.
  for (let iy = 0; iy < hf.gridSize; iy += 2) {
    for (let ix = 0; ix < hf.gridSize; ix += 2) {
      const x = hf.worldX(ix);
      const y = hf.worldY(iy);
      if (zoneAt(layout, x, y) !== zone || hf.at(ix, iy) < DRY) continue;
      if (land.carriesIsland(x, y)) return { x, y };
    }
  }
  return { x: layout.core.x, y: layout.core.y };
}

/**
 * Metres from the sand within which a district site is on the beach. About one
 * suburban block: a district this close to the sand is the one whose streets
 * run down to it.
 */
const BEACH_REACH = 220;

/** Place district sites and hand out names, cultures and stats. */
export function generateDistricts(seed: number, layout: ZoneLayout, hf: Heightfield, water: WaterDescription): District[] {
  const rng = genRng(seed, Subsystem.Districts, 1);
  const land = new LandMasses(hf, water.islands, DRY);
  const districts: District[] = [];
  const pools: Partial<Record<Zone, string[]>> = {};
  let id = 0;

  const pushDistrict = (zone: Zone, p: Point, name: string, culture: Culture, spec: SiteSpec): void => {
    districts.push({
      id: id++,
      name,
      zone,
      x: p.x,
      y: p.y,
      density: rng.range(spec.density[0], spec.density[1]),
      wealth: rng.range(spec.wealth[0], spec.wealth[1]),
      culture,
    });
  };

  const nameFor = (zone: Zone): string => {
    let pool = pools[zone];
    if (!pool) {
      pool = rng.shuffle([...GENERIC_NAMES[zone]]);
      pools[zone] = pool;
    }
    const name = pool.pop();
    return name ?? `${GENERIC_NAMES[zone][0] as string} ${id}`;
  };

  for (const spec of SITE_SPECS) {
    for (let i = 0; i < spec.count; i++) {
      const p = sampleSiteInZone(rng, layout, spec.zone, hf, land);
      pushDistrict(spec.zone, p, nameFor(spec.zone), 'none', spec);
    }
  }

  // Named neighbourhoods overwrite generic inner districts, the closest matches by role.
  const inner = districts.filter((d) => d.zone === 'inner');
  const industrialAngle = layout.industrialAngle;
  const sortedByAngleToIndustrial = [...inner].sort((a, b) => angularDistance(layout, a, industrialAngle) - angularDistance(layout, b, industrialAngle));
  const barrio = sortedByAngleToIndustrial[0];
  if (barrio) {
    barrio.name = 'The Barrio';
    barrio.culture = 'latin';
  }
  const remaining = inner.filter((d) => d !== barrio).sort((a, b) => dist2(a.x, a.y, layout.core.x, layout.core.y) - dist2(b.x, b.y, layout.core.x, layout.core.y));
  for (let i = 0; i < NAMED_INNER.length && i < remaining.length; i++) {
    const d = remaining[i] as District;
    const spec = NAMED_INNER[i] as { name: string; culture: Culture };
    d.name = spec.name;
    d.culture = spec.culture;
  }

  // The freight yards belong to the Bratva; the industrial site nearest the harbour is the docks.
  const industrial = districts.filter((d) => d.zone === 'industrial').sort((a, b) => dist2(a.x, a.y, water.harbour.x, water.harbour.y) - dist2(b.x, b.y, water.harbour.x, water.harbour.y));
  const docks = industrial[0];
  if (docks) {
    docks.name = 'The Docks';
    docks.culture = 'irish';
  }
  const yards = industrial[1] ?? industrial[0];
  if (yards && yards !== docks) {
    yards.name = 'Freight Yards';
    yards.culture = 'east-european';
  }

  // Island district, always its own place: the developed outer island.
  const suburbIsland = layout.suburbIsland;
  if (suburbIsland) {
    const p = sampleSiteInZone(rng, { ...layout, core: { x: suburbIsland.x, y: suburbIsland.y } }, 'core', hf, land);
    districts.push({
      id: id++,
      name: 'Gull Island',
      zone: 'suburban',
      x: p.x,
      y: p.y,
      density: 0.35,
      wealth: 0.55,
      culture: 'irish',
    });
  }

  // Outlaw MC roadhouses in the outskirts.
  const outskirts = districts.filter((d) => d.zone === 'outskirts');
  const saints = outskirts.sort((a, b) => a.wealth - b.wealth)[0];
  if (saints) {
    saints.name = 'Roadhouse Strip';
    saints.culture = 'outlaw';
  }

  districts.sort((a, b) => a.id - b.id);
  return districts;
}

/**
 * Name the beach neighbourhood of spec section 8.3: the districts that stand on
 * the main beach, the one that carries the boardwalk and the pier. A district
 * that already has a culture keeps it, so this never takes Chinatown or the
 * docks. The nearest one is the Boardwalk itself, however far off it stands, so
 * every seed has a beach neighbourhood.
 *
 * Called after the beaches are described, because a beach is described from the
 * district sites. It changes the districts it is given.
 */
export function nameBeachNeighbourhood(districts: District[], beaches: readonly Beach[]): void {
  const main = beaches.find((b) => b.main);
  if (main === undefined) return;
  const plain = districts
    .filter((d) => d.culture === 'none')
    .map((d) => ({ d, away: distanceToShore(main, d) }))
    .sort((a, b) => a.away - b.away || a.d.id - b.d.id);
  for (let i = 0; i < plain.length; i++) {
    const entry = plain[i] as { d: District; away: number };
    if (i > 0 && entry.away > BEACH_REACH) break;
    entry.d.culture = 'beach';
  }
  const nearest = plain[0];
  if (nearest) nearest.d.name = 'The Boardwalk';
}

/** Metres from a district site to the nearest point of a beach's waterline. */
function distanceToShore(beach: Beach, d: District): number {
  let best = Infinity;
  for (const p of beach.shore) best = Math.min(best, dist2(p.x, p.y, d.x, d.y));
  return Math.sqrt(best);
}

function angularDistance(layout: ZoneLayout, d: District, angle: number): number {
  const a = Math.atan2(d.y - layout.core.y, d.x - layout.core.x) - angle;
  return Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
}

/** District lookup: nearest site within the point's zone, else nearest overall. */
export function districtAt(districts: readonly District[], layout: ZoneLayout, x: number, y: number): District {
  const zone = zoneAt(layout, x, y);
  let best: District | undefined;
  let bestD = Infinity;
  let fallback: District | undefined;
  let fallbackD = Infinity;
  for (const d of districts) {
    const dd = dist2(d.x, d.y, x, y);
    if (dd < fallbackD) {
      fallbackD = dd;
      fallback = d;
    }
    if (d.zone === zone && dd < bestD) {
      bestD = dd;
      best = d;
    }
  }
  return (best ?? fallback) as District;
}
