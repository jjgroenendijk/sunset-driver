/** Simulation runs at a fixed 60 Hz regardless of render rate. */
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

/** One in-game day is 24 real minutes: one real minute per game hour. */
export const REAL_SECONDS_PER_DAY = 24 * 60;
export const TICKS_PER_DAY = REAL_SECONDS_PER_DAY * TICK_RATE;
export const TICKS_PER_HOUR = TICKS_PER_DAY / 24;

/** Most simulation steps taken in one render frame; beyond this the clock falls behind rather than freezing the frame. */
export const MAX_STEPS_PER_FRAME = 8;

/**
 * Fixed-step accumulator. The render loop feeds it wall-clock deltas; it
 * answers with how many whole simulation steps to run. Simulation code never
 * sees the delta itself, only the tick count.
 */
export class FixedStepClock {
  private accumulatorMs = 0;

  /** Feed elapsed wall time; returns the number of fixed steps to take now. */
  advance(elapsedMs: number): number {
    if (!(elapsedMs > 0)) return 0;
    this.accumulatorMs += Math.min(elapsedMs, MAX_STEPS_PER_FRAME * TICK_MS);
    let steps = 0;
    while (this.accumulatorMs >= TICK_MS - 1e-6 && steps < MAX_STEPS_PER_FRAME) {
      this.accumulatorMs -= TICK_MS;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulatorMs = 0;
    return steps;
  }

  /** Fraction of a step elapsed since the last one, for render interpolation. */
  alpha(): number {
    return this.accumulatorMs / TICK_MS;
  }
}

/** Game-clock breakdown of a tick: day number and hour of day. */
export function gameTime(tick: number): { day: number; hour: number; minute: number; dayFraction: number } {
  const day = Math.floor(tick / TICKS_PER_DAY);
  const inDay = tick - day * TICKS_PER_DAY;
  const dayFraction = inDay / TICKS_PER_DAY;
  const hour = Math.floor(inDay / TICKS_PER_HOUR);
  const minute = Math.floor(((inDay - hour * TICKS_PER_HOUR) / TICKS_PER_HOUR) * 60);
  return { day, hour, minute, dayFraction };
}
