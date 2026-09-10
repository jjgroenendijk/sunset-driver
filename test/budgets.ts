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
   * work, so it is not part of the frame; a chunk cut from it is capped by
   * {@link BUDGET_US.chunkSlice} instead.
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
   * `buildFootprint` over a whole-map road network: every curve offset, every
   * junction aproned and the lot unioned (spec section 6.4). Offline work like
   * {@link BUDGET_MS.worldGen}.
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
   * `new ChunkSource` over a whole map: the road segments and the parcels sorted
   * into the chunks they stand in (spec section 9.1). Paid once per seed, before
   * the first chunk, and given the parcels rather than cutting them itself.
   */
  chunkSource: 5,
} as const;

/** Budgets small enough that milliseconds would round them away. */
export const BUDGET_US = {
  /**
   * `TensorField.majorAt`, per sample. The road tracer calls it once per
   * streamline step, so this is the cost of every metre of road on the map.
   */
  tensorSample: 20,

  /**
   * `ChunkSource.chunk`, per chunk: the terrain slice copied and the roads and
   * parcels inside the chunk gathered (spec section 9.1). Streaming has 2 ms of
   * the frame and does the geometry as well, so cutting the chunk itself may
   * only ever be a small part of that.
   */
  chunkSlice: 250,
} as const;
