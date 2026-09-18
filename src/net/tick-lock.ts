/**
 * The shared clock of spec section 21.4: the host broadcasts the authoritative
 * tick and every joiner locks to it, so all peers evaluate `(seed, tick)`
 * identically and see the same ambient world without any of it crossing the
 * wire.
 *
 * Pure arithmetic in tick space. It never reads a clock of its own: the frame
 * hands it the tick the record stands on and the steps the local clock asked
 * for, and it answers with the steps to take.
 *
 * A beat carries the host's tick as it was when it was sent, so a joiner locks
 * half a round trip behind. That offset is steady and under a tick on a good
 * link; measuring it needs the round trip, which comes with the replication of
 * spec section 21.5.
 */

/** How often the host beats: twice a second, which is cheap and keeps the drift under a frame. */
export const BEAT_TICKS = 30;

/**
 * How far apart two ticks may drift before the joiner jumps rather than walks.
 * Two seconds is more than a slow frame or a lost beat explains, so what is
 * left is a peer that stopped: a tab in the background, or a long stall.
 */
export const SNAP_TICKS = 120;

/**
 * A joiner's grip on the host's clock.
 *
 * Between beats it walks: one extra step in a frame that is behind, one fewer
 * in a frame that is ahead. At 60 frames a second that closes a second of drift
 * in a second, which is a city running slightly fast or slow rather than one
 * that jumps.
 */
export class TickLock {
  /** Ticks the host was ahead by at the last beat, less what has been made up since. */
  private drift = 0;
  private heard = false;

  /** Whether a beat has ever arrived. Until one has, the frame is the local clock's alone. */
  get locked(): boolean {
    return this.heard;
  }

  /** How far behind the host this peer stands, as far as the last beat said. Negative is ahead. */
  get gap(): number {
    return this.drift;
  }

  /**
   * A beat from the host. Answers the tick to jump to where the gap is too wide
   * to walk, and null where the walk will close it.
   */
  beat(hostTick: number, localTick: number): number | null {
    this.heard = true;
    this.drift = hostTick - localTick;
    if (Math.abs(this.drift) < SNAP_TICKS) return null;
    this.drift = 0;
    return hostTick;
  }

  /** The steps this frame should take, given the steps the local clock asked for. */
  steps(asked: number): number {
    if (!this.heard || this.drift === 0) return asked;
    if (this.drift > 0) {
      this.drift -= 1;
      return asked + 1;
    }
    if (asked === 0) return 0;
    this.drift += 1;
    return asked - 1;
  }

  /**
   * Take the host's clock at the handshake. The record jumps to the tick the
   * host named, so there is no drift to walk off: the caller is what moves the
   * record, and this says the walk starts from level.
   */
  lockTo(): void {
    this.heard = true;
    this.drift = 0;
  }

  /** Let go of the host's clock: the peer keeps the tick it stands on and runs on its own again. */
  release(): void {
    this.heard = false;
    this.drift = 0;
  }
}

/** Whether the host owes a beat, given the tick it stands on and the tick it last beat on. */
export function beatDue(tick: number, lastBeat: number): boolean {
  return tick - lastBeat >= BEAT_TICKS;
}
