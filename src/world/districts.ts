import { dist2, lerp, smoothstep } from '../core/math.ts';
import { genRng, Subsystem, type Rng } from '../core/rng.ts';
import { atan2, cos, hypot, sin } from '../core/libm.ts';
import type { Culture, District, Island, Point, WaterDescription, Zone } from './types.ts';
import type { Heightfield } from './heightfield.ts';
import { LandMasses } from './landmass.ts';
import { SEA_LEVEL } from './terrain.ts';

/** Metres above the sea a district site needs; the waterline itself is not buildable. */
const DRY = SEA_LEVEL + 1;

/**
 * Zone ring radii as fractions of the world side length.
 *
 * The city is the subject of the map (spec section 8.2), so these rings are
 * most of it: over the seeds measured, the core, the inner ring and the
 * industrial wedge take about a third of the dry land and the suburbs around
 * them another third. What is left for the outskirts and the wilderness is the
 * margin — the corners of the map and the outer islands — and not the majority.
 */
export const ZONE_RADII: Record<Exclude<Zone, 'wilderness' | 'industrial'>, number> = {
  core: 0.13,
  inner: 0.28,
  suburban: 0.4,
  outskirts: 0.5,
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

/**
 * The industrial wedge, with its reach as fractions of the world side. It
 * starts half as far out again as the core reaches and runs to just inside the
 * suburbs, which is where it stood against the rings before they were widened.
 */
const INDUSTRIAL_HALF_ANGLE = (26 * Math.PI) / 180;
const INDUSTRIAL_INNER = ZONE_RADII.core * 1.5;
const INDUSTRIAL_OUTER = ZONE_RADII.suburban * 0.9;
/** The share of the wedge that must be dry, gentle land for the wedge to stand there. */
const INDUSTRIAL_DRY = 0.6;
/** The steepest ground, as rise over run, that counts as gentle to the wedge: yards and warehouses stand on flat land. */
const INDUSTRIAL_SLOPE = 0.15;
/** The step the wedge turns by, each way in turn, while it looks for land. */
const INDUSTRIAL_TURN = (5 * Math.PI) / 180;
/** The most steps it turns each way: a quarter turn. */
const INDUSTRIAL_TURNS = 18;

export function layoutZones(size: number, core: Point, water: WaterDescription): ZoneLayout {
  const outer = water.islands.filter((i) => !i.main);
  outer.sort((a, b) => dist2(a.x, a.y, water.harbour.x, water.harbour.y) - dist2(b.x, b.y, water.harbour.x, water.harbour.y));
  return {
    size,
    core,
    industrialAngle: water.industry,
    industrialHalfAngle: INDUSTRIAL_HALF_ANGLE,
    industrialInner: size * INDUSTRIAL_INNER,
    industrialOuter: size * INDUSTRIAL_OUTER,
    suburbIsland: outer[0],
  };
}

/**
 * The direction of the industrial wedge. It points at the harbour where that
 * way is mostly dry, gentle land. A harbour on a waterfront faces open water,
 * so there the wedge turns along the shore, a step each way in turn, to the
 * first direction with land enough. With none, it takes the best direction it
 * tried.
 */
export function industryAngle(hf: Heightfield, size: number, core: Point, harbour: Point): number {
  const toward = atan2(harbour.y - core.y, harbour.x - core.x);
  let best = toward;
  let bestDry = -1;
  for (let k = 0; k <= INDUSTRIAL_TURNS * 2; k++) {
    const angle = toward + (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * INDUSTRIAL_TURN;
    const dry = wedgeDry(hf, size, core, angle);
    if (dry >= INDUSTRIAL_DRY) return angle;
    if (dry > bestDry) {
      best = angle;
      bestDry = dry;
    }
  }
  return best;
}

/** The share of a wedge along `angle` that is dry, gentle land inside the map, from a grid of samples. */
function wedgeDry(hf: Heightfield, size: number, core: Point, angle: number): number {
  const steps = 5;
  let dry = 0;
  for (let i = 0; i < steps; i++) {
    const r = size * lerp(INDUSTRIAL_INNER, INDUSTRIAL_OUTER, (i + 0.5) / steps);
    for (let j = 0; j < steps; j++) {
      const a = angle + INDUSTRIAL_HALF_ANGLE * ((2 * j + 1) / steps - 1);
      const x = core.x + cos(a) * r;
      const y = core.y + sin(a) * r;
      if (Math.abs(x) < size / 2 && Math.abs(y) < size / 2 && hf.sample(x, y) >= DRY && hf.slope(x, y) < INDUSTRIAL_SLOPE) dry++;
    }
  }
  return dry / (steps * steps);
}

/** Which zone ring a point falls in, ignoring water. */
export function zoneAt(layout: ZoneLayout, x: number, y: number): Zone {
  const dx = x - layout.core.x;
  const dy = y - layout.core.y;
  const r = hypot(dx, dy);
  const s = layout.size;
  const isl = layout.suburbIsland;
  if (isl && hypot(x - isl.x, y - isl.y) < isl.radius * 1.2) return 'suburban';
  if (r >= layout.industrialInner && r <= layout.industrialOuter) {
    let a = atan2(dy, dx) - layout.industrialAngle;
    a = atan2(sin(a), cos(a));
    if (Math.abs(a) <= layout.industrialHalfAngle) return 'industrial';
  }
  if (r < ZONE_RADII.core * s) return 'core';
  if (r < ZONE_RADII.inner * s) return 'inner';
  if (r < ZONE_RADII.suburban * s) return 'suburban';
  if (r < ZONE_RADII.outskirts * s) return 'outskirts';
  return 'wilderness';
}

/**
 * How high the skyline stands over a place, in [0, 1] (spec section 10.3): 1 in
 * the middle of the city and 0 at the outer edge of the inner ring and past it.
 *
 * The zone rings are hard edges, and a tower height read from them would stop
 * at a circle. This value falls off smoothly with the distance from the core
 * instead, so the skyline tapers. It is flat at the middle and flat at the edge,
 * so neither end shows a crease.
 */
export function skylineAt(layout: ZoneLayout, x: number, y: number): number {
  const r = hypot(x - layout.core.x, y - layout.core.y);
  return 1 - smoothstep(0, ZONE_RADII.inner * layout.size, r);
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
    const x = layout.core.x + cos(a) * r;
    const y = layout.core.y + sin(a) * r;
    if (Math.abs(x) > s / 2 || Math.abs(y) > s / 2) continue;
    if (zoneAt(layout, x, y) !== zone) continue;
    if (hf.sample(x, y) < DRY) continue;
    if (!land.reaches(x, y)) continue;
    return { x, y };
  }
  // Deterministic fallback: the first dry cell of the zone in grid order.
  for (let iy = 0; iy < hf.gridSize; iy += 2) {
    for (let ix = 0; ix < hf.gridSize; ix += 2) {
      const x = hf.worldX(ix);
      const y = hf.worldY(iy);
      if (zoneAt(layout, x, y) !== zone || hf.at(ix, iy) < DRY) continue;
      if (land.reaches(x, y)) return { x, y };
    }
  }
  return { x: layout.core.x, y: layout.core.y };
}

/** Place district sites and hand out names, cultures and stats. */
export function generateDistricts(seed: number, layout: ZoneLayout, hf: Heightfield, water: WaterDescription): District[] {
  const rng = genRng(seed, Subsystem.Districts, 1);
  const land = new LandMasses(hf, water, DRY);
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

  // The Boardwalk is named in `beaches.ts`, once the beaches are known: the
  // district a resort beach runs through is the only one the name fits.

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

function angularDistance(layout: ZoneLayout, d: District, angle: number): number {
  const a = atan2(d.y - layout.core.y, d.x - layout.core.x) - angle;
  return Math.abs(atan2(sin(a), cos(a)));
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
