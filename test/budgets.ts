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
   * `stepSim`, per tick, measured over one game hour. Occupied so far by the
   * placeholder character motion; driving, physics, traffic and police AI all
   * come out of the same {@link SIM_SLICE_MS}.
   */
  simTick: 0.02,

  /**
   * `generateWorld`, per seed: the whole-map skeleton, not a chunk. Offline
   * work, so it is not part of the frame; chunk generation gets its own
   * per-frame cap when streaming lands (spec section 9.1).
   */
  worldGen: 1500,

  /** `generateWorld` worst case across the measured seeds, where the tail is noisier. */
  worldGenWorst: 3000,

  /**
   * `buildRoadGraph` over a whole-map road network. Offline work like
   * {@link BUDGET_MS.worldGen}: traffic, police and navigation build the graph
   * once and then query it.
   */
  roadGraph: 50,

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
   */
  carve: 60,

  /**
   * `buildFootprint` over a whole-map road network: every curve offset, every
   * junction aproned and the lot unioned (spec section 6.4). Offline work like
   * {@link BUDGET_MS.worldGen}; chunk-level parcels get their own per-frame cap
   * when streaming lands (spec section 9.1).
   */
  footprint: 900,

  /**
   * `buildParcels` over a whole map: the coastline traced off the heightfield,
   * the footprint subtracted from it, and the oversized blocks cut down (spec
   * section 6.4). Offline work like {@link BUDGET_MS.worldGen}, and it is given
   * the footprint and the graph rather than building them itself.
   */
  parcels: 900,

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
   * The dearest single piece of putting a chunk of the core into the scene:
   * one generated tower copied into its batch (spec section 9.1).
   *
   * The streaming slice is {@link FRAME_SLICE_MS.streaming} and `spendBudget`
   * holds the upload queue to it, but a piece is indivisible — a geometry goes
   * into a batch whole — so a frame that starts one just inside the slice
   * overruns by this much. That overrun is the only one the queue allows, and
   * it costs a frame a fraction of itself rather than a stall. What takes it
   * down is building LOD in the near ring (spec section 9.2), not a larger
   * number here.
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
