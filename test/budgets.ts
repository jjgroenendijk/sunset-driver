import type { Zone } from '../src/world/types.ts';

/**
 * Performance budgets the gate enforces (spec section 2.4, section 3).
 *
 * `FRAME_SLICE_MS` is the spec table: the ceiling each system may ever reach
 * inside a 16 ms frame on integrated graphics. `BUDGET_MS` is what the tests
 * enforce *today* — a slice is shared by the systems that will land in it, so
 * each entry claims only the part already spent. Raise an entry together with
 * the system that spends it, never past its slice, and never to make a failing
 * test pass.
 */

/** The 60 fps frame on the target hardware. */
export const FRAME_MS = 16;

/** Spec section 2.4: how the frame is divided between systems. */
export const FRAME_SLICE_MS = {
  render: 9,
  physics: 2,
  gameplayAndAi: 2,
  streaming: 2,
  headroom: 1,
} as const;

/** The slices `stepSim` owns: physics plus gameplay and AI. */
export const SIM_SLICE_MS = FRAME_SLICE_MS.physics + FRAME_SLICE_MS.gameplayAndAi;

export const BUDGET_MS = {
  /**
   * `stepSim`, per tick: the Rapier world of spec section 11.3 stepped once,
   * with the player's car on the ground tiles around it. Traffic, pedestrians
   * and police AI come out of the same {@link SIM_SLICE_MS} and are not here
   * yet, so this claims the part the physics already spends.
   */
  simTick: 0.2,

  /**
   * `generateWorld`, per seed: the whole-map skeleton, not a chunk. Offline
   * work, so it is not part of the frame; chunk generation gets its own
   * per-frame cap when streaming lands (spec section 9.1).
   *
   * Measured warm, like every other figure here: the first world of a process
   * carries the generator's JIT and runs about a quarter slower than the cost
   * this claims.
   */
  worldGen: 1500,

  /** `generateWorld` worst case across the measured seeds, where the tail is noisier. */
  worldGenWorst: 3000,

  /**
   * `buildRoadGraph` over a whole-map road network. Offline work like
   * {@link BUDGET_MS.worldGen}: traffic, police and navigation build the graph
   * once and then query it.
   *
   * This, {@link BUDGET_MS.carve}, {@link BUDGET_MS.footprint} and
   * {@link BUDGET_MS.parcels} all rose with the zone rings of spec section 8.2,
   * which is the system that spends them: a world carries three times the
   * curves it did. Each figure below is what the measured seeds take on an
   * Apple M1 laptop, with the room a GitHub runner needs — the runner has been
   * seen to take three times as long on the smallest of them, where a
   * millisecond of collection lands on a measurement of tens.
   *
   * The graph takes 15 ms at worst, where it took 7 ms before.
   */
  roadGraph: 120,

  /**
   * `buildTensorField` over a whole map: a small fraction of the world it is
   * built from. A build this far over is an accidental per-cell search, not a
   * slow runner.
   */
  tensorField: 150,

  /**
   * `buildCarve` over a whole-map road network: every segment on the ground
   * filed by the ground it carves (spec section 7.1). Offline work like
   * {@link BUDGET_MS.roadGraph}; a chunk then carves its own heights out of it,
   * and that cost lands in the streaming cap when streaming does (spec section
   * 9.1).
   *
   * It takes 17 ms at worst, where it took 8 ms before.
   */
  carve: 120,

  /**
   * `buildFootprint` over a whole-map road network: every curve offset, every
   * junction aproned and the lot unioned (spec section 6.4). Offline work like
   * {@link BUDGET_MS.worldGen}; chunk-level parcels get their own per-frame cap
   * when streaming lands (spec section 9.1).
   *
   * It takes 569 ms at worst, where it took 258 ms before.
   */
  footprint: 1500,

  /**
   * `buildParcels` over a whole map: the coastline traced off the heightfield,
   * the footprint subtracted from it, and the oversized blocks cut down (spec
   * section 6.4). Offline work like {@link BUDGET_MS.worldGen}, and it is given
   * the footprint and the graph rather than building them itself.
   *
   * It takes 353 ms at worst, where it took 182 ms before.
   */
  parcels: 1500,

  /**
   * `buildBuildings` over a whole map: every building parcel cut into lots
   * along its frontage (spec section 10.3). Offline work like
   * {@link BUDGET_MS.parcels}, and it is given the parcels and the graph rather
   * than building them itself. It reads polygons but never cuts any, so it
   * costs a fraction of the parcels it stands on.
   */
  buildings: 250,

  /**
   * The plants of one chunk (spec section 10.4): every cell of the scatter grid
   * over it asked which parcel it stands on, how much room it has and whether a
   * building is already there. This is per-chunk work like cutting the chunk
   * itself, so it lands in the streaming cap when streaming does (spec section
   * 9.1); the boundary index of a parcel is built once and every chunk after
   * that reads it.
   */
  chunkPlants: 8,

  /**
   * The geometry of the buildings of one chunk of the core: the towers the
   * generator builds, the blocks around them and the hulls that outline both
   * (spec section 10.3). This is the dearest chunk of a world, because every
   * other one is mostly houses.
   *
   * Worker work (spec section 9.1): a chunk is built in a `ChunkPool` worker
   * and the frame is charged only for {@link BUDGET_MS.chunkUpload}. It is
   * still measured, because a worker that takes half a second to answer is a
   * city that fills in half a second late.
   */
  chunkBuildings: 150,

  /**
   * The dearest single step of putting a chunk of the core into the scene:
   * `MAX_STEP_VERTICES` of a generated tower copied into its batch (spec
   * section 9.1).
   *
   * The streaming slice is {@link FRAME_SLICE_MS.streaming} and `spendBudget`
   * holds the upload queue to it, but a step is indivisible, so a frame that
   * starts one just inside the slice overruns by this much. That overrun is the
   * only one the queue allows, and it costs a frame a fraction of itself rather
   * than a stall.
   *
   * A step is a fixed count of vertices rather than a whole part, so this
   * number is about the copy and not about the largest tower a seed happens to
   * build. It is about 0.4 ms on an Apple M1 laptop, which leaves the room a
   * runner several times slower needs.
   */
  chunkUpload: 4,
} as const;

/** Budgets small enough that milliseconds would round them away. */
export const BUDGET_US = {
  /**
   * `TensorField.majorAt`, per sample. The road tracer calls it once per
   * streamline step, so this is the cost of every metre of road on the map.
   */
  tensorSample: 20,
} as const;

/**
 * A band a layout metric of one zone has to fall in (spec section 8.2). Both
 * ends are allowed.
 */
export interface LayoutBand {
  min: number;
  max: number;
}

/** What `test/seed-layout.ts` holds one zone of one seed to. */
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
 * How dense each zone is (spec section 8.2), as a band rather than a number,
 * because a seed is allowed to vary.
 *
 * These are what the generator gives **today**, widened past the spread of 80
 * seeds so a seed the sweep has not read yet still passes. They are not yet the
 * city we want: a real dense downtown gives about 28 % of its ground to the
 * street and 50 % to buildings, and the core here gives 50 % and 22 %. The
 * layout issues move these bands towards that, and each of them says which band
 * it moved and why. Until one does, a number outside a band is a regression to
 * find, exactly like a performance budget.
 *
 * The comment over each zone is the spread those 80 seeds gave, so how much
 * room a band leaves is visible without measuring again.
 *
 * Measured on a grid of `METRIC_CELL` metres in `scripts/layout-metrics.ts`,
 * over the dry land of the zone.
 */
export const LAYOUT_BANDS: Record<Zone, ZoneBands> = {
  // 80 seeds: road 44 to 55 %, building 16 to 30 %, 3.1 to 6.1 buildings a
  // hectare, median parcel 1217 to 3266 m². Issue #190 moved all four: the
  // strip blocks of spec section 6.1 took the road share down from 58 to 65 %
  // and the middle parcel up from 547 to 920 m². Issue #191 moved none of them.
  // Issue #192 moved the two the buildings own: the street wall and the row
  // back to back took the building share from 13 to 25 % up to 16 to 30 %, and
  // the buildings a hectare from 2.4 to 4.4 up to 3.1 to 6.1.
  core: {
    roadShare: { min: 0.34, max: 0.65 },
    buildingShare: { min: 0.12, max: 0.36 },
    buildingsPerHectare: { min: 2.4, max: 7.5 },
    medianParcelArea: { min: 800, max: 4500 },
  },
  // 40 to 47 %, 19 to 29 %, 4.8 to 7.4, 2020 to 3471 m². Issue #190 moved the
  // road share and the middle parcel, from 46 to 54 % and 1137 to 1634 m².
  // Issue #192 took the building share from 15 to 23 % up to 19 to 29 %, and
  // the buildings a hectare from 3.4 to 5.0 up to 4.8 to 7.4.
  inner: {
    roadShare: { min: 0.3, max: 0.58 },
    buildingShare: { min: 0.15, max: 0.35 },
    buildingsPerHectare: { min: 3.8, max: 9 },
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
  outskirts: {
    roadShare: { min: 0.015, max: 0.3 },
    buildingShare: { min: 0.015, max: 0.16 },
    buildingsPerHectare: { min: 0.35, max: 3 },
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
  // like a suburb and nothing finer than that.
  wilderness: {
    roadShare: { min: 0, max: 0.12 },
    buildingShare: { min: 0, max: 0.05 },
    buildingsPerHectare: { min: 0, max: 1.5 },
    medianParcelArea: { min: 400, max: 6e5 },
  },
};
