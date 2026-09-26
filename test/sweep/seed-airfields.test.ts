import { expect, it } from 'vitest';
import { AIRFIELD_KEEP, airfieldAt } from '../../src/world/transit/airfields.ts';
import { toSegment } from '../../src/world/junctions/crossing-line.ts';
import { fromLocal } from '../../src/world/transit/airfield-frame.ts';
import { Heightfield } from '../../src/world/terrain/heightfield.ts';
import { SurfaceIndex } from '../../src/world/terrain/surface.ts';
import { AIRCRAFT_CLASSES, type Airfield, type Point, type RoadCurve, type WorldDescription } from '../../src/world/types.ts';
import { buildingsOf, seeds, worlds } from './seed-fixture.ts';
import { FOOTPRINT_COUNT } from './seed-limits.ts';
import { sweepSuite } from './seed-suite.ts';

/** Metres between the samples a road is walked at for the airfield it may not enter. */
const ROAD_STEP = 4;

/**
 * The seed sweep of spec section 3, on the airfields of spec section 8.4: the
 * airport every seed has, and the ground the roads and the buildings leave it.
 */
sweepSuite('airfields', () => {
  it('gives every seed one airport, served by a road from its gate', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const airports = w.airfields.filter((field) => field.kind === 'airport');
      expect(airports.length, `seed ${seed}: airports`).toBe(1);
      const airport = airports[0] as (typeof airports)[number];
      expect(airport.road, `seed ${seed}: no road reaches the airport`).toBeGreaterThanOrEqual(0);
      const road = w.roads[airport.road] as RoadCurve;
      const near = Math.min(...road.points.slice(1).map((p, i) => toSegment(airport.gate, road.points[i] as Point, p)));
      expect(near, `seed ${seed}: the airport's road stands off its gate`).toBeLessThan(45);
    }
  });

  it('parks every aircraft of the roster on some airfield', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const parked = new Set(w.airfields.flatMap((field) => field.stands.map((stand) => stand.cls)));
      const dock = w.airfields.some((field) => field.kind === 'dock');
      for (const cls of AIRCRAFT_CLASSES) {
        if (cls === 'seaplane' && !dock) continue;
        expect(parked.has(cls), `seed ${seed}: no ${cls} waits anywhere`).toBe(true);
      }
    }
  });

  it('paves the runways, and leaves an airstrip its dirt', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const surfaces = new SurfaceIndex(w);
      for (const field of w.airfields) checkPaving(seed, surfaces, field);
    }
  });

  it('levels the ground under every airfield', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      for (const field of w.airfields) {
        if (field.kind === 'dock') continue;
        expect(field.level, `seed ${seed}: airfield ${field.id} stands in the sea`).toBeGreaterThan(w.water.seaLevel + 1);
        for (const stand of field.stands) {
          const h = hf.sample(stand.x, stand.y);
          expect(Math.abs(h - field.level), `seed ${seed}: the ${stand.cls} stands off the level`).toBeLessThan(0.01);
        }
      }
    }
  });

  it('keeps every road off the airfields but the gate', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      for (const road of w.roads) {
        for (let i = 0; i + 1 < road.points.length; i++) {
          const a = road.points[i] as Point;
          const b = road.points[i + 1] as Point;
          const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / ROAD_STEP));
          for (let k = 0; k <= steps; k++) {
            const x = a.x + ((b.x - a.x) * k) / steps;
            const y = a.y + ((b.y - a.y) * k) / steps;
            const field = airfieldAt(w.airfields, x, y, AIRFIELD_KEEP / 2);
            // An expect per sample is the dearest part of the walk, so only a fault asks.
            if (field !== undefined) expect(field.id, `seed ${seed}: road ${road.id} runs onto airfield ${field.id}`).toBeUndefined();
          }
        }
      }
    }
  });

  it('builds nothing on an airfield', () => {
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      for (const building of buildingsOf(seed).buildings) {
        for (const corner of building.lot) {
          const field = airfieldAt(w.airfields, corner.x, corner.y);
          if (field !== undefined) expect(field.id, `seed ${seed}: building ${building.id} stands on airfield ${field.id}`).toBeUndefined();
        }
      }
    }
  });
});

/** Checks that the runways and aprons of one airfield are paved, and an airstrip's runway is dirt. */
function checkPaving(seed: number, surfaces: SurfaceIndex, field: Airfield): void {
  for (const part of field.parts) {
    if (part.kind !== 'runway' && part.kind !== 'apron') continue;
    const at = fromLocal(field, part.u, part.v);
    const want = field.kind === 'airstrip' && part.kind === 'runway' ? 'dirt' : 'asphalt';
    expect(surfaces.at(at.x, at.y), `seed ${seed}: the ${field.kind}'s ${part.kind}`).toBe(want);
  }
}
