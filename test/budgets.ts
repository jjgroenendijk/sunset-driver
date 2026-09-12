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
 * seeds so a seed the sweep has not read yet still passes. They are not the
 * city we want: a real dense downtown gives about 28 % of its ground to the
 * street and 50 % to buildings, and the core here gives 60 % and 12 %. The
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
  // 80 seeds: road 58 to 65 %, building 10 to 14 %, 2.2 to 3.4 buildings a
  // hectare, median parcel 547 to 920 m².
  core: {
    roadShare: { min: 0.45, max: 0.75 },
    buildingShare: { min: 0.05, max: 0.22 },
    buildingsPerHectare: { min: 1.2, max: 5 },
    medianParcelArea: { min: 350, max: 1400 },
  },
  // 46 to 54 %, 14 to 19 %, 3.3 to 4.3, 1137 to 1634 m².
  inner: {
    roadShare: { min: 0.35, max: 0.65 },
    buildingShare: { min: 0.07, max: 0.28 },
    buildingsPerHectare: { min: 2, max: 6 },
    medianParcelArea: { min: 700, max: 2500 },
  },
  // 12 to 42 %, 5 to 25 %, 0.4 to 1.8, 2008 to 12845 m². The wedge lies along
  // the harbour, so how much of it is water — and how much city is left in it —
  // moves further from seed to seed than any other zone.
  industrial: {
    roadShare: { min: 0.06, max: 0.6 },
    buildingShare: { min: 0.02, max: 0.35 },
    buildingsPerHectare: { min: 0.15, max: 3 },
    medianParcelArea: { min: 1200, max: 20000 },
  },
  // 10 to 38 %, 3 to 18 %, 1.1 to 7.1, 4459 to 11049 m².
  suburban: {
    roadShare: { min: 0.06, max: 0.55 },
    buildingShare: { min: 0.01, max: 0.27 },
    buildingsPerHectare: { min: 0.5, max: 10 },
    medianParcelArea: { min: 2500, max: 16000 },
  },
  // 3 to 19 %, 0.5 to 10 %, 0.1 to 2.0, 4602 to 50774 m².
  outskirts: {
    roadShare: { min: 0.015, max: 0.3 },
    buildingShare: { min: 0.002, max: 0.16 },
    buildingsPerHectare: { min: 0.05, max: 3 },
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
