/**
 * A short signature of a built world, for comparing one build against another.
 *
 * The world is a pure function of its seed, so Node and the browser must build
 * the same one. Nothing in the project checked that until issue #243, where
 * `Math.cos` rounded one bit differently in the two engines and the browser
 * traced a different road network, gave the parcels different owners and drew
 * grass where Node had buildings. Nothing failed; a person noticed a picture.
 *
 * `scripts/world-check.ts` runs this on both sides and compares the lines. The
 * digest covers each layer in the order it is built, so the first line that
 * differs says which stage of generation went its own way. It reads the world
 * and the layers and changes neither.
 */
import { hashString } from '../core/hash.ts';
import { buildLayers, type WorldLayers } from './chunks.ts';
import type { Point, WorldDescription } from './types.ts';

/** Metres are rounded to this many decimals, so a digest is about places rather than bits. */
const DECIMALS = 6;

function n(value: number): string {
  return value.toFixed(DECIMALS);
}

function hash(text: string): string {
  return hashString(text).toString(16);
}

/** A run of points as one string, for feeding the hash. */
function path(points: readonly Point[]): string {
  return points.map((p) => `${n(p.x)},${n(p.y)}`).join(' ');
}

/**
 * One line per layer, each `name hash`, in the order generation builds them.
 * Compare two digests line by line: the first line that differs names the
 * stage that diverged, and every line after it is downstream of that one.
 */
export function worldDigest(world: WorldDescription, layers: WorldLayers = buildLayers(world)): string[] {
  const { parcels, buildings } = layers;
  const water = world.water.islands.map((i) => `${i.id}:${n(i.x)},${n(i.y)},${n(i.radius)}`).join(';');
  const districts = world.districts.map((d) => `${d.id}:${d.zone}:${n(d.x)},${n(d.y)}:${n(d.density)}`).join(';');
  const beaches = world.beaches.map((b) => `${b.id}:${n(b.length)}:${b.boardwalkRoad}:${b.carParks.length}`).join(';');
  return [
    `seed ${world.seed}`,
    `archetype ${world.archetype}`,
    `terrain ${hash(world.terrain.heights.join(','))}`,
    `water ${hash(water)}`,
    `districts ${hash(districts)}`,
    `beaches ${hash(beaches)}`,
    `roads ${world.roads.length} ${hash(
      world.roads.map((r) => `${r.id}:${r.tier}:${path(r.points)}:${r.nodes.join(',')}`).join(';'),
    )}`,
    `corridors ${world.corridors.length} ${hash(
      world.corridors.map((c) => `${c.id}:${c.kind}:${path(c.polygon)}`).join(';'),
    )}`,
    `tram ${world.tram.stops.length} ${hash(path(world.tram.route))}`,
    `parcels ${parcels.parcels.length} ${hash(
      parcels.parcels.map((p) => `${p.id}:${p.owner}:${p.zone}:${n(p.area)}:${path(p.region.outer)}`).join(';'),
    )}`,
    `stations ${hash(path(parcels.stations))}`,
    `buildings ${buildings.buildings.length} ${hash(
      buildings.buildings.map((b) => `${b.id}:${b.kind}:${b.parcel}:${n(b.area)}:${n(b.width)}:${n(b.depth)}:${n(b.facing)}`).join(';'),
    )}`,
  ];
}
