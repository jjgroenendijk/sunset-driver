import type { Zone } from '../../src/world/types.ts';

/**
 * A band a layout metric of one zone has to fall in (spec section 8.2). Both
 * ends are allowed.
 */
export interface LayoutBand {
  min: number;
  max: number;
}

/** What `test/sweep/seed-layout.test.ts` holds one zone of one seed to. */
export interface ZoneBands {
  /** Share of the zone's dry land the road footprint covers. */
  roadShare: LayoutBand;
  /** Share of it that is building lot. */
  buildingShare: LayoutBand;
  /** Buildings standing in the zone, per hectare of it. */
  buildingsPerHectare: LayoutBand;
  /** Square metres of the middle parcel of the zone. */
  medianParcelArea: LayoutBand;
}

/**
 * The share of the whole map that is dry land, whatever the archetype (spec
 * section 7.2). Over 200 seeds the lagoon gave 41 to 50 %, the ridge 46 to 58 %
 * and the other four 60 to 73 %. Each archetype holds a narrower target of its
 * own; this band holds them all.
 */
export const LAND_FRACTION: LayoutBand = { min: 0.38, max: 0.78 };

/**
 * How dense each zone is (spec section 8.2), as a band rather than a number,
 * because a seed is allowed to vary.
 *
 * These are what the generator gives **today**, widened past the spread of 80
 * seeds so a seed the sweep has not read yet still passes. They are not yet the
 * city we want: a real dense downtown gives about 28 % of its ground to the
 * street and 50 % to buildings, and the core here gives 50 % and 22 %. The
 * layout issues move these bands towards that, and each of them says which band
 * it moved and why. Until one does, a number outside a band is a regression to
 * find.
 *
 * The comment over each zone is the spread those 80 seeds gave, so how much
 * room a band leaves is visible without measuring again.
 *
 * Measured on a grid of `METRIC_CELL` metres in `scripts/layout-metrics.ts`,
 * over the dry land of the zone.
 */
export const LAYOUT_BANDS: Record<Zone, ZoneBands> = {
  // 80 seeds: road 42 to 53 %, building 20 to 36 %, 4.0 to 7.9 buildings a
  // hectare, median parcel 1217 to 3266 m². Issue #190 moved all four: the
  // strip blocks of spec section 6.1 took the road share down from 58 to 65 %
  // and the middle parcel up from 547 to 920 m². Issue #191 moved none of them.
  // Issue #192 moved the two the buildings own: the street wall and the row
  // back to back took the building share from 13 to 25 % up to 16 to 30 %, and
  // the buildings a hectare from 2.4 to 4.4 up to 3.1 to 6.1. Issue #193 moved
  // the same two again: a block that was a plaza, an open car park or ground
  // cover now carries buildings, which took the building share up to 20 to 36 %
  // and the buildings a hectare up to 4.0 to 7.9. Issue #262 moved the road
  // share from 44 to 55 % down to 42 to 53 %: the highways
  // run on a ring outside the core, not through it.
  core: {
    roadShare: { min: 0.32, max: 0.63 },
    buildingShare: { min: 0.15, max: 0.42 },
    buildingsPerHectare: { min: 3, max: 9.5 },
    medianParcelArea: { min: 800, max: 4500 },
  },
  // 40 to 47 %, 23 to 34 %, 5.9 to 9.1, 2020 to 3471 m². Issue #190 moved the
  // road share and the middle parcel, from 46 to 54 % and 1137 to 1634 m².
  // Issue #192 took the building share from 15 to 23 % up to 19 to 29 %, and
  // the buildings a hectare from 3.4 to 5.0 up to 4.8 to 7.4. Issue #193 took
  // them up again, to 23 to 34 % and 5.9 to 9.1, for the same reason as in the
  // core.
  inner: {
    roadShare: { min: 0.3, max: 0.58 },
    buildingShare: { min: 0.18, max: 0.4 },
    buildingsPerHectare: { min: 4.6, max: 11 },
    medianParcelArea: { min: 1300, max: 5500 },
  },
  // 20 to 39 %, 12 to 31 %, 0.8 to 2.4, 2176 to 14857 m². The wedge lies along
  // the harbour, so how much of it is water — and how much city is left in it —
  // moves further from seed to seed than any other zone, which is why the floor
  // under the building share is well below what any of the 80 gave. Issue #192
  // took that share from 10 to 27 % up to 12 to 31 %.
  industrial: {
    roadShare: { min: 0.06, max: 0.6 },
    buildingShare: { min: 0.06, max: 0.4 },
    buildingsPerHectare: { min: 0.5, max: 3 },
    medianParcelArea: { min: 1200, max: 20000 },
  },
  // 21 to 36 %, 10 to 19 %, 4.2 to 8.2, 5032 to 10278 m². Issue #192 moved the
  // last two from 9 to 17 % and 3.4 to 6.7: a suburban lot keeps its garden,
  // but a block with a road each side is now built on both sides.
  suburban: {
    roadShare: { min: 0.06, max: 0.55 },
    buildingShare: { min: 0.07, max: 0.27 },
    buildingsPerHectare: { min: 3.2, max: 10 },
    medianParcelArea: { min: 2500, max: 16000 },
  },
  // 4 to 19 %, 3 to 9 %, 0.5 to 1.8, 11660 to 48745 m². Issue #192 raised the
  // two floors the buildings own and left the ceilings: out here a row back to
  // back is rare, so it is worth a few buildings a seed.
  //
  // Issue #399 took the buildings a hectare down from 0.35 to 0.3. It re-rolled
  // every district site, and seed 4081019190 — the emptiest outskirts of the
  // 500 — went from 0.456 to 0.338. The outskirts of eight other seeds moved
  // both ways around the same middle, so what the re-roll changed is which seed
  // is the emptiest and not how much is built out there.
  //
  // Issue #643 took both building floors to zero. They were read off the
  // FOOTPRINT_COUNT seeds this check reads and not off the 500 the tier
  // generates, and the wider set never held them. Over all 500, seeds
  // 3548214139 and 878462945 build nothing at all in an outskirts of 119 and
  // 132 ha, and 1198602974 reads 0.0041 and 0.0049. All three read the same on
  // `main`, so the floors were false before anything moved: they sat above the
  // sixteen seeds that were read and below nothing else. An outskirts nobody
  // built in is a fair seed, as an empty wilderness is, and the ceilings still
  // catch a ring built up like a suburb.
  outskirts: {
    roadShare: { min: 0.015, max: 0.3 },
    buildingShare: { min: 0, max: 0.16 },
    buildingsPerHectare: { min: 0, max: 3 },
    medianParcelArea: { min: 2000, max: 80000 },
  },
  // The margin the rings leave: the corners of the map and the outer islands.
  // A seed builds anything out here from nothing at all to two thirds of a
  // house a hectare, and a parcel is whatever the roads left, from 5731 m² to
  // 24 ha over the first 80 seeds. Every floor is zero, because a seed whose
  // wilderness is a bare rock is a fair seed, and the floor under the middle
  // parcel is low for the same reason: seed 4240293950 leaves 58 ha of
  // wilderness in eight pieces, most of them slivers along the coast, and its
  // middle parcel is 750 m². Out here the band catches a wilderness parcelled
  // like a suburb and nothing finer than that. The road ceiling is loose for
  // the same slivers: a ridge seed of 3.3 km leaves 32 ha of wilderness in the
  // corners, with a highway along the coast through them, and reads 18.5 %.
  wilderness: {
    roadShare: { min: 0, max: 0.2 },
    buildingShare: { min: 0, max: 0.05 },
    buildingsPerHectare: { min: 0, max: 1.5 },
    medianParcelArea: { min: 400, max: 6e5 },
  },
};
