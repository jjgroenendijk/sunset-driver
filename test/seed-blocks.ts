// The block measure of `seed-roads.test.ts`: samples of the ground each zone's
// minor fill was asked to cover, and the metres from each to the nearest road.
import { airfieldAt, LEVEL_BLEND } from '../src/world/airfields.ts';
import { layoutZones, zoneAt } from '../src/world/districts.ts';
import { MINOR_BY_ZONE } from '../src/world/fill.ts';
import type { Heightfield } from '../src/world/heightfield.ts';
import { LandMasses } from '../src/world/landmass.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { District, RoadTier, WorldDescription, Zone } from '../src/world/types.ts';
import { PointGrid } from './seed-index.ts';

/**
 * How far from a district site of its own zone the ground still belongs to that
 * district's fill, as a multiple of the zone's widest `along` spacing. The
 * minor fill is seeded at the district sites and grows outward, so ground
 * further out than this is ground the fill was never asked to cover.
 */
const CATCHMENT = 2;

/** One sample of the block measure: its place on the sample grid and the metres to the nearest road. */
export interface Sample {
  ix: number;
  iy: number;
  half: number;
}

/** Values by zone. */
type ByZone<V> = Partial<Record<Zone, V[]>>;

/**
 * Every sample of each zone, and the metres to the nearest road of the ones on
 * the ground its fill was asked to cover. Ground the fill was never asked to
 * cover only ever puts the median up, so the floor reads all of it and the
 * ceiling the rest.
 */
export function blockSamples(w: WorldDescription, hf: Heightfield): { samples: ByZone<Sample>; filled: ByZone<number> } {
  const zones = layoutZones(w.size, w.core, w.water);
  const grid = new PointGrid(w.size, 40, w.roads);
  const land = new LandMasses(hf, w.water, w.water.seaLevel + 1);
  const mainland = land.massAt(w.core.x, w.core.y);
  const climbable: Partial<Record<RoadTier, Uint8Array>> = {
    street: climbableFrom(hf, w, 'street'),
    dirt: climbableFrom(hf, w, 'dirt'),
  };
  const samples: ByZone<Sample> = {};
  const filled: ByZone<number> = {};
  const take = (ix: number, iy: number): void => {
    const x = hf.worldX(ix);
    const y = hf.worldY(iy);
    // Dry ground only, and not the strip along the edge that roads keep off.
    if (hf.at(ix, iy) < w.water.seaLevel + 1) return;
    if (Math.abs(x) > w.size / 2 - 120 || Math.abs(y) > w.size / 2 - 120) return;
    if (land.massAt(x, y) !== mainland) return;
    const zone = zoneAt(zones, x, y);
    const half = grid.nearest(x, y);
    const found = samples[zone] ?? [];
    samples[zone] = found;
    found.push({ ix: ix / 8, iy: iy / 8, half });
    const reach = climbable[MINOR_BY_ZONE[zone].tier] as Uint8Array;
    if (reach[iy * hf.gridSize + ix] !== 1) return;
    // An airfield and its blend are ground the roads keep off (spec section 8.4).
    if (airfieldAt(w.airfields, x, y, LEVEL_BLEND) !== undefined) return;
    if (!nearADistrict(w, zone, x, y, (d) => onClimbable(hf, reach, d.x, d.y))) return;
    const covered = filled[zone] ?? [];
    filled[zone] = covered;
    covered.push(half);
  };
  for (let iy = 0; iy < hf.gridSize; iy += 8) {
    for (let ix = 0; ix < hf.gridSize; ix += 8) take(ix, iy);
  }
  return { samples, filled };
}

/**
 * The metres to the nearest road of every sample in a piece of at least `size`
 * samples, where a piece is the samples joined through their eight neighbours.
 */
export function piecesOf(samples: readonly Sample[], size: number): number[] {
  const at = new Map<string, number>();
  samples.forEach((s, i) => at.set(`${s.ix},${s.iy}`, i));
  const seen = new Uint8Array(samples.length);
  const kept: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (seen[i] === 1) continue;
    const piece = pieceFrom(samples, at, seen, i);
    if (piece.length >= size) for (const j of piece) kept.push((samples[j] as Sample).half);
  }
  return kept;
}

/** The samples of the piece that sample `i` stands in, marked as seen. */
function pieceFrom(samples: readonly Sample[], at: Map<string, number>, seen: Uint8Array, i: number): number[] {
  seen[i] = 1;
  const piece = [i];
  for (let k = 0; k < piece.length; k++) {
    const s = samples[piece[k] as number] as Sample;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const j = at.get(`${s.ix + dx},${s.iy + dy}`);
        if (j === undefined || seen[j] === 1) continue;
        seen[j] = 1;
        piece.push(j);
      }
    }
  }
  return piece;
}

/**
 * True where a district of a zone stands within the zone's catchment of a
 * place, on ground a road can climb to. A site on a knoll no road reaches
 * (issue #399) seeds no fill, so the ground around it is nobody's blocks.
 */
function nearADistrict(w: WorldDescription, zone: Zone, x: number, y: number, served: (d: District) => boolean): boolean {
  const reach = CATCHMENT * (MINOR_BY_ZONE[zone].along[1] as number);
  return w.districts.some((d) => d.zone === zone && Math.hypot(d.x - x, d.y - y) <= reach && served(d));
}

/** True where a place stands on ground of a climbable flag grid. */
function onClimbable(hf: Heightfield, reach: Uint8Array, x: number, y: number): boolean {
  const ix = Math.round((x - hf.originX) / hf.cellSize);
  const iy = Math.round((y - hf.originY) / hf.cellSize);
  if (ix < 0 || iy < 0 || ix >= hf.gridSize || iy >= hf.gridSize) return false;
  return reach[iy * hf.gridSize + ix] === 1;
}

/** The four steps to a node's neighbours on the grid, x then y: east, west, north, south. */
const STEPS = [1, 0, -1, 0, 0, 1, 0, -1];

/**
 * The ground a road of a tier could be laid on: every terrain node joined to
 * the core by steps over dry land no steeper than the tier climbs. Ground
 * outside it — a knoll, a ledge, a shelf behind a cliff — carries no road
 * whatever the fill does, so it says nothing about how the fill spaces them.
 */
function climbableFrom(hf: Heightfield, w: WorldDescription, tier: RoadTier): Uint8Array {
  const n = hf.gridSize;
  const rise = TIERS[tier].maxGrade * hf.cellSize;
  const dry = w.water.seaLevel + 1;
  const reached = new Uint8Array(n * n);
  const queue = new Int32Array(n * n);
  const cx = Math.round((w.core.x - hf.originX) / hf.cellSize);
  const cy = Math.round((w.core.y - hf.originY) / hf.cellSize);
  let tail = 0;
  if (cx >= 0 && cy >= 0 && cx < n && cy < n) {
    reached[cy * n + cx] = 1;
    queue[tail++] = cy * n + cx;
  }
  for (let head = 0; head < tail; head++) {
    const at = queue[head] as number;
    const ix = at % n;
    const iy = (at - ix) / n;
    const h = hf.at(ix, iy);
    for (let k = 0; k < 4; k++) {
      const jx = ix + (STEPS[2 * k] as number);
      const jy = iy + (STEPS[2 * k + 1] as number);
      if (jx < 0 || jy < 0 || jx >= n || jy >= n) continue;
      const to = jy * n + jx;
      const g = hf.at(jx, jy);
      if (reached[to] === 1 || g < dry || Math.abs(g - h) > rise) continue;
      reached[to] = 1;
      queue[tail++] = to;
    }
  }
  return reached;
}
