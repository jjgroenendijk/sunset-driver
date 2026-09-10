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

  /** `generateWorld` worst case across a whole sweep, where the tail is noisier. */
  worldGenWorst: 3000,

  /**
   * `buildRoadGraph` over a whole-map road network. Offline work like
   * {@link BUDGET_MS.worldGen}: traffic, police and navigation build the graph
   * once and then query it.
   */
  roadGraph: 50,
} as const;
