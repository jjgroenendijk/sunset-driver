/**
 * Everybody else in the room: what they look like, where they are, and how
 * often this peer owes them a frame of itself (spec section 21.5).
 *
 * Interest management is the last of those. A room of six players sending every
 * frame to everybody is thirty streams, most of them about a car nobody can
 * see: the city is kilometres across and the camera shows a corner of it. So a
 * peer is sent frames at {@link NEAR_TICKS} while they are within
 * {@link INTEREST_RANGE} and at {@link FAR_TICKS} when they are not. A player
 * across the map still appears on the map screen and still arrives smoothly;
 * they simply arrive on fewer frames.
 *
 * The rate is decided per peer rather than per room, so one player far away
 * costs the sender nothing while the two beside it stay at the full rate.
 */
import type { CharacterAppearance } from '../sim/player/character.ts';
import { readAppearance, type PlayerFrame } from './move.ts';
import { Replica, type RemotePose } from './replica.ts';

/** Ticks between frames sent to a peer that is near: ten a second. */
export const NEAR_TICKS = 6;

/** Ticks between frames sent to a peer that is not: two a second. */
export const FAR_TICKS = 30;

/** Metres a peer is sent the full rate within. Past it the camera cannot show them. */
export const INTEREST_RANGE = 250;

/** One remote player, as the renderer and the map read them. */
export interface RemotePlayer {
  id: string;
  appearance: CharacterAppearance;
  pose: RemotePose;
  /** Ticks since their last frame arrived, so a quiet player can be told from a live one. */
  age: number;
}

/** One peer of the room, as this peer keeps them. */
interface Entry {
  appearance: CharacterAppearance;
  replica: Replica;
  /** The local tick a frame was last sent to them, so the rate can be held. */
  sentTick: number;
}

export class Roster {
  private readonly players = new Map<string, Entry>();

  get size(): number {
    return this.players.size;
  }

  /** Whether this peer is on the roster at all. */
  has(id: string): boolean {
    return this.players.has(id);
  }

  /**
   * Take a peer onto the roster, or set the look of one already on it. A look
   * arrives from another browser, so it is wrapped into the choices the
   * character creator offers rather than believed.
   */
  admit(id: string, appearance: unknown, tick: number): void {
    const look = readAppearance(appearance);
    const held = this.players.get(id);
    if (held) {
      held.appearance = look;
      return;
    }
    // A peer joining owes a frame at once rather than at the next rate, so they
    // are seen on the tick they arrive.
    this.players.set(id, { appearance: look, replica: new Replica(), sentTick: tick - NEAR_TICKS });
  }

  /** Take a peer off it, which is what leaving the room looks like from here. */
  forget(id: string): void {
    this.players.delete(id);
  }

  /** Forget everybody, for a room that closed. */
  clear(): void {
    this.players.clear();
  }

  /** A frame from a peer. One from somebody not on the roster is dropped. */
  hear(id: string, frame: PlayerFrame): void {
    this.players.get(id)?.replica.push(frame);
  }

  /** Everybody with a pose to draw at this tick, in no particular order. */
  drawn(tick: number): RemotePlayer[] {
    const out: RemotePlayer[] = [];
    for (const [id, entry] of this.players) {
      const pose = entry.replica.at(tick);
      if (pose !== null) out.push({ id, appearance: entry.appearance, pose, age: entry.replica.age(tick) });
    }
    return out;
  }

  /**
   * The peers owed a frame of this player now, and the mark that they were
   * sent one. `here` is where the local player stands, which is what the
   * distance is measured from.
   */
  due(tick: number, here: { x: number; y: number }): string[] {
    const out: string[] = [];
    for (const [id, entry] of this.players) {
      const pose = entry.replica.at(tick);
      const gap = pose === null ? 0 : Math.hypot(pose.x - here.x, pose.y - here.y);
      const every = gap > INTEREST_RANGE ? FAR_TICKS : NEAR_TICKS;
      if (tick - entry.sentTick < every) continue;
      entry.sentTick = tick;
      out.push(id);
    }
    return out;
  }
}
