/**
 * The session's shared map of taken blocks (spec section 21.3).
 *
 * The host owns the map: its `factions.captured` goes out with the rest of the
 * divergence set and is written over every joiner's. A joiner that takes a
 * block takes it in its own record first, so it tells the host with a `take`,
 * and the host writes the block into its own map at the top of its next frame.
 * The delta after that carries it to the whole room.
 *
 * A joiner does not have to watch the capture happen. Any block in its record
 * that was not in the host's last map is one it took since. A block taken
 * before the host's first map arrived cannot be told from a block the joiner
 * held in single player, so it is not sent: the first map writes over it.
 *
 * A joiner keeps the blocks it told the host about in its own record until the
 * host's map carries them, so the block does not flicker back to the faction
 * while the `take` is on the wire. A correction snapshot that still lacks one
 * sends it again: that is the host that took the room over, or a lost message.
 *
 * The single-player map a joiner came in with is kept here too, and
 * `control.ts` writes it back as the room closes. A host keeps the session's
 * map when the room closes, since the map was its own all along.
 */
import { blockAt, blockKey } from '../sim/crime/territory.ts';
import type { SimState } from '../sim/simulation.ts';
import type { WorldUpdate } from './divergence.ts';

/** Blocks one `take` carries at most. A player takes one block at a time, so this is only a guard. */
export const TAKE_LIMIT = 32;

/** What crosses the wire: the blocks a joiner took since the host's last map. */
export interface Take {
  blocks: number[];
}

/** Whether a number is the key of a block of the map. */
function isBlock(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return false;
  const at = blockAt(value);
  return blockKey(at.bx, at.by) === value;
}

/** A `take` as sent, or null where what arrived is not one. */
export function readTake(value: unknown): Take | null {
  if (typeof value !== 'object' || value === null) return null;
  const blocks = (value as Record<string, unknown>).blocks;
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > TAKE_LIMIT) return null;
  return blocks.every(isBlock) ? { blocks: [...blocks] } : null;
}

/** Put a block into a sorted list of blocks, once. */
function insert(list: number[], block: number): void {
  let at = 0;
  while (at < list.length && (list[at] as number) < block) at += 1;
  if (list[at] !== block) list.splice(at, 0, block);
}

export class SharedMap {
  /** The blocks this player held before the host's map replaced them, or null where it never did. */
  private own: number[] | null = null;
  /** The host's map as it was last written in, or null before the first. */
  private hosts: number[] | null = null;
  /** Blocks told to the host that its map does not carry yet. */
  private told: number[] = [];
  /** On the host: blocks the joiners took, written in at the next frame. */
  private readonly taken: number[] = [];

  /** The single-player map to put back as the room closes, or null where it was never replaced. */
  get ownCaptures(): number[] | null {
    return this.own;
  }

  /**
   * On a joiner, before the host's updates are written in: the blocks taken
   * since the host's last map, which the host has not been told about yet.
   */
  fresh(state: SimState): number[] {
    const hosts = this.hosts;
    if (hosts === null) return [];
    const fresh = state.factions.captured.filter((b) => !hosts.includes(b) && !this.told.includes(b));
    this.told.push(...fresh);
    return fresh;
  }

  /**
   * Write one of the host's updates in. Returns the blocks to tell the host
   * again: the ones a correction snapshot still lacks.
   */
  write(state: SimState, update: WorldUpdate, apply: () => void): number[] {
    const carries = update.parts.captured !== undefined;
    if (carries && this.own === null) this.own = [...state.factions.captured];
    apply();
    if (!carries) return [];
    const map = state.factions.captured;
    this.hosts = [...map];
    this.told = this.told.filter((b) => !map.includes(b));
    for (const block of this.told) insert(map, block);
    return update.full ? [...this.told] : [];
  }

  /** On the host: a joiner's `take`, kept until the next frame writes it in. */
  heard(take: Take): void {
    this.taken.push(...take.blocks);
  }

  /** On the host, at the top of a frame: the blocks the joiners took, into the session's map. */
  merge(state: SimState): void {
    for (const block of this.taken) insert(state.factions.captured, block);
    this.taken.length = 0;
  }

  /**
   * This peer took the room over. The blocks it told the old host about are
   * already in its own map, which is the map now.
   */
  hosting(): void {
    this.told = [];
    this.hosts = null;
  }

  /** The room closed: nothing more is told or heard. */
  clear(): void {
    this.told = [];
    this.taken.length = 0;
  }
}
