import { expect, it } from 'vitest';
import { landUseLayers } from '../../scripts/land-use.ts';
import { ZONES, landFraction, measureLayout, type ZoneMetrics } from '../../scripts/layout-metrics.ts';
import { ARCHETYPES, type TerrainArchetype } from '../../src/world/terrain/archetype.ts';
import type { WorldDescription, Zone } from '../../src/world/types.ts';
import { LAND_FRACTION, LAYOUT_BANDS, type LayoutBand, type ZoneBands } from './layout-bands.ts';
import { FOOTPRINT_COUNT, MIN_ZONE_HECTARES, MIN_ZONE_PARCELS } from './seed-limits.ts';
import { seeds, worlds, parcelsOf, buildingsOf, graphOf } from './seed-fixture.ts';
import { sweepSuite } from './seed-suite.ts';

/**
 * The seed sweep of spec section 3, on how dense the city is rather than on
 * whether it is legal.
 *
 * Every other check here asks whether a layout holds together: that roads
 * connect, that grades hold, that nothing stands on anything else. A map that
 * gives three fifths of its downtown to tarmac passes all of them. These read
 * the shares of `scripts/layout-metrics.ts` and hold each one to the band
 * `layout-bands.ts` pins, so "the city is too sparse" is a failing check and not an
 * opinion.
 */
sweepSuite('layout', () => {
  it('leaves a share of the map as dry land inside the band and inside its archetype\'s target', () => {
    const complaints: string[] = [];
    for (const seed of seeds) {
      const world = worlds.get(seed) as WorldDescription;
      const fraction = landFraction(world.terrain, world.water.seaLevel);
      const target = (ARCHETYPES.find((a) => a.name === world.archetype) as TerrainArchetype).landFraction;
      for (const [what, band] of [['the band', LAND_FRACTION], [`the ${world.archetype} target`, target]] as const) {
        if (fraction < band.min || fraction > band.max) {
          complaints.push(`seed ${seed}: ${(fraction * 100).toFixed(1)} % land, outside ${what} of ${band.min} to ${band.max}`);
        }
      }
    }
    expect(complaints.join('\n')).toBe('');
  });

  it('gives each zone a share of road, of building and a parcel size inside its band', () => {
    const complaints: string[] = [];
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const world = worlds.get(seed) as WorldDescription;
      const layers = landUseLayers(world, graphOf(seed), parcelsOf(seed), buildingsOf(seed));
      const metrics = measureLayout(world, layers);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      for (const zone of ZONES) checkZone(fault, zone, metrics[zone]);
      if (complaint !== undefined) complaints.push(`seed ${seed}: ${complaint}`);
    }
    expect(complaints.join('\n')).toBe('');
  });
});

/** Hold every reading of one zone to its band, and its road and parcel shares to the whole. */
function checkZone(fault: (text: string) => void, zone: Zone, m: ZoneMetrics): void {
  // A zone the water left a few hectares of says nothing about the
  // layout: one block either way moves every share of it.
  if (m.hectares < MIN_ZONE_HECTARES) return;
  const bands = LAYOUT_BANDS[zone];
  for (const metric of ['roadShare', 'buildingShare', 'buildingsPerHectare'] as const) {
    check(fault, zone, metric, m[metric], bands[metric]);
  }
  if (m.parcels >= MIN_ZONE_PARCELS) {
    check(fault, zone, 'medianParcelArea', m.medianParcelArea, bands.medianParcelArea);
  }
  // The parcels are the land the roads left, so the two shares are the
  // whole of the ground the map reaches. What is missing is land no road
  // reaches, which `seed-parcels.test.ts` holds to its own ceiling.
  if (m.roadShare + m.parcelShare > 1.001) {
    fault(`the ${zone} is ${(m.roadShare * 100).toFixed(1)} % road and ${(m.parcelShare * 100).toFixed(1)} % parcel at once`);
  }
}

/** Hold one reading of one zone to its band. */
function check(
  fault: (text: string) => void,
  zone: Zone,
  metric: keyof ZoneBands & keyof ZoneMetrics,
  value: number,
  band: LayoutBand,
): void {
  if (value >= band.min && value <= band.max) return;
  fault(`the ${zone} reads ${value.toFixed(3)} for ${metric}, outside its band of ${band.min} to ${band.max}`);
}
