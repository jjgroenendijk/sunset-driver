/**
 * The company in a room: who is in it, what they were told at the handshake,
 * whose clock everybody keeps, and who owns what (spec sections 21.2 to 21.5).
 *
 * It holds no Trystero and no DOM. Everything that touches a socket is behind
 * `NetLink`, which `link.ts` implements over a Trystero room and a test fills
 * with a pair of ends, so the handshake, the refusals, the shared clock, the
 * replication, the host migration and the fall back to single player are all
 * read headless.
 *
 * Authority is split the way spec section 21.4 splits it:
 *
 * - **Each player owns itself.** Every peer sends its own pose and its own
 *   inputs (`move.ts`) and nobody else ever writes them, so a player's driving
 *   never waits on the network. The others are drawn from `replica.ts`.
 * - **The host owns divergence.** The promoted cars, the startled crowd, the
 *   fires, the police, the emergency units, the enforcers, the settled street
 *   crime and the session's captured blocks are the host's, sent as the deltas
 *   and correction snapshots of `divergence.ts` and written into every joiner's
 *   record.
 * - **Everything else is derived.** A career is the player's own (21.3), and
 *   the rest of the city is a function of `(seed, tick)`, which is why the
 *   shared clock is worth what it costs.
 *
 * The record is read here and written in one place only: the divergence set, at
 * the top of {@link Party.frame}, so a message from a socket never lands in the
 * middle of a tick.
 */
import { normaliseAppearance, type CharacterAppearance } from '../sim/character.ts';
import type { InputFrame } from '../sim/input.ts';
import type { SimState } from '../sim/simulation.ts';
import { applyWorld, readWorld, WorldSender, type WorldUpdate } from './divergence.ts';
import { frameOf, packFrame, readFrame } from './move.ts';
import {
  readBeat,
  readHello,
  refuse,
  refusalText,
  type Hello,
  type MessageKind,
  PROTOCOL,
} from './protocol.ts';
import { Roster, type RemotePlayer } from './roster.ts';
import { beatDue, TickLock } from './tick-lock.ts';

/** Players in one room, spec section 21.1. The seventh is turned away at the handshake. */
export const MAX_PLAYERS = 6;

/** What a message weighs on the wire: a `hello`, a tick, a player's frame, or the world. */
export type MessageBody = Hello | { tick: number } | WorldUpdate | Float32Array;

/**
 * The half of the room that owns a socket. `link.ts` is the one that really
 * does; a test stands two of these back to back instead.
 */
export interface NetLink {
  /** This peer's id in the room. The lowest of them takes the room over (spec section 21.4). */
  readonly selfId: string;
  /** Which signalling strategy answered, for the line the player reads. */
  readonly via: string;
  send(kind: MessageKind, body: MessageBody, to?: string): void;
  onPeerJoin: ((id: string) => void) | null;
  onPeerLeave: ((id: string) => void) | null;
  onMessage: ((kind: MessageKind, body: unknown, from: string) => void) | null;
  close(): void;
}

/**
 * Where a room stands. `waiting` is a room nobody has joined yet, `playing` a
 * room with company in it, and `offline` a session back on its own — closed by
 * the player, emptied, or refused.
 */
export type PartyPhase = 'waiting' | 'playing' | 'offline';

/** What the pause menu draws. Everything in it is a string or a count, so nothing else reads the room. */
export interface PartyState {
  phase: PartyPhase;
  room: string;
  host: boolean;
  /** Everyone in the room, this player among them. */
  players: number;
  via: string;
  /** The line under the room code: what just happened, in the player's words. */
  message: string;
}

export interface PartyOptions {
  seed: string;
  room: string;
  /** Whether this peer opened the room. A joiner locks its clock to the host's. */
  host: boolean;
  /** The tick the record stands on as the room opens. */
  tick: number;
  /** The look this player picked, so the others can draw them. */
  look?: CharacterAppearance;
}

export class Party {
  private readonly link: NetLink;
  private readonly seed: string;
  private readonly room: string;
  private readonly look: CharacterAppearance;
  /** Whether this peer opened the room, which no migration ever changes. */
  private readonly opened: boolean;
  /** Whether this peer is the authority now, which a migration does change. */
  private isHost: boolean;
  private readonly lock = new TickLock();
  /** The peers that got through the handshake, and whether each is the host. */
  private readonly peers = new Map<string, boolean>();
  /** Everybody else, as they are drawn and as they are sent to. */
  private readonly roster = new Roster();
  /** The host's side of the divergence set, or null on a peer that is not the host. */
  private world: WorldSender | null;
  /** Updates that arrived between two frames, written into the record at the next one. */
  private readonly incoming: WorldUpdate[] = [];
  /** The host tick of the last update written in, so a late one does not undo a newer one. */
  private applied = -1;
  /**
   * The blocks this player held before the session's shared map was written
   * over them, or null on a peer that never took one in. Spec section 21.3
   * keeps a session's territory out of everybody's save, so it is handed back
   * when the room closes and the player's own map is as they left it.
   */
  private ownCaptured: number[] | null = null;
  /** Whether anybody ever got through, so an empty room is told from a room that emptied. */
  private joined = false;
  private phase: PartyPhase = 'waiting';
  private note: string;
  private lastBeat: number;
  /**
   * The tick of the last frame. A message is read between two frames, so this
   * is what a `hello` carries and what a beat is measured against: one frame
   * stale at worst, which is under the walk the lock corrects anyway.
   */
  private now: number;

  /** The room as the pause menu draws it, called on every change. */
  onChange: ((state: PartyState) => void) | null = null;
  /** The tick the record must jump to, because the host's clock says so. */
  onSnap: ((tick: number) => void) | null = null;

  constructor(link: NetLink, options: PartyOptions) {
    this.link = link;
    this.seed = options.seed;
    this.room = options.room;
    this.look = options.look ?? normaliseAppearance(null);
    this.opened = options.host;
    this.isHost = options.host;
    this.now = options.tick;
    this.lastBeat = options.tick;
    this.world = options.host ? new WorldSender(options.tick) : null;
    this.note = this.openingLine();
    link.onPeerJoin = (id) => this.greet(id);
    link.onPeerLeave = (id) => this.left(id);
    link.onMessage = (kind, body, from) => this.heard(kind, body, from);
  }

  get state(): PartyState {
    return {
      phase: this.phase,
      room: this.room,
      host: this.isHost,
      players: this.phase === 'offline' ? 1 : this.peers.size + 1,
      via: this.link.via,
      message: this.note,
    };
  }

  /**
   * One frame of the room. The divergence the host sent is written into the
   * record first, so the tick steps from the world everybody else is in; the
   * host beats its clock and sends what it owns; every peer sends itself to
   * whoever is owed a frame of it; and a joiner answers with the steps that
   * walk it back into line with the host.
   *
   * `input` is the frame the last tick was stepped with, which is what rides
   * along so the others can predict between two of these.
   */
  frame(state: SimState, input: InputFrame, steps: number): number {
    this.now = state.tick;
    if (this.phase === 'offline') return steps;
    this.settle(state);
    if (this.isHost) this.broadcast(state);
    this.report(state, input);
    return this.isHost ? steps : this.lock.steps(steps);
  }

  /**
   * The blocks this player held before the room's shared map replaced them, or
   * null where it never did. `control.ts` writes them back as the room closes.
   */
  get ownCaptures(): number[] | null {
    return this.ownCaptured;
  }

  /** Everybody else, as the frame draws them at this tick (spec section 21.5). */
  remotes(tick: number): RemotePlayer[] {
    return this.roster.drawn(tick);
  }

  /** Leave the room and go back to single player, without a reload (spec section 21.2, point 5). */
  close(message = 'Back to single player.'): void {
    if (this.phase === 'offline') return;
    this.phase = 'offline';
    this.note = message;
    this.lock.release();
    this.peers.clear();
    this.roster.clear();
    this.incoming.length = 0;
    this.world = null;
    this.link.onPeerJoin = null;
    this.link.onPeerLeave = null;
    this.link.onMessage = null;
    this.link.close();
    this.changed();
  }

  /** Write in what the host said about the world it owns. A host owns it and writes nothing. */
  private settle(state: SimState): void {
    for (const update of this.incoming) {
      if (this.isHost || update.tick < this.applied) continue;
      this.applied = update.tick;
      if (this.ownCaptured === null && update.parts.captured !== undefined) {
        this.ownCaptured = [...state.factions.captured];
      }
      applyWorld(state, update);
    }
    this.incoming.length = 0;
  }

  /** The host's side of a frame: the beat of the shared clock, and what it owns. */
  private broadcast(state: SimState): void {
    if (this.peers.size === 0) return;
    if (beatDue(state.tick, this.lastBeat)) {
      this.lastBeat = state.tick;
      this.link.send('tick', { tick: state.tick });
    }
    const update = this.world?.due(state, state.tick) ?? null;
    if (update !== null) this.link.send('world', update);
  }

  /** Send this player to every peer owed a frame of them, at the rate their distance earns. */
  private report(state: SimState, input: InputFrame): void {
    if (this.roster.size === 0) return;
    const owed = this.roster.due(state.tick, state.player);
    if (owed.length === 0) return;
    const packed = packFrame(frameOf(state, input));
    for (const id of owed) this.link.send('move', packed, id);
  }

  private greet(id: string): void {
    const hello: Hello = {
      protocol: PROTOCOL,
      seed: this.seed,
      tick: this.now,
      host: this.isHost,
      look: this.look,
    };
    this.link.send('hello', hello, id);
  }

  private heard(kind: MessageKind, body: unknown, from: string): void {
    if (this.phase === 'offline') return;
    if (kind === 'hello') this.handshake(body, from);
    else if (kind === 'tick') this.beat(body, from);
    else if (kind === 'move') this.moved(body, from);
    else if (kind === 'world') this.told(body, from);
    else if (kind === 'host') this.claimed(body, from);
  }

  /**
   * The handshake of spec section 21.2. A peer that is not in this city, or not
   * on this protocol, is turned away, and so is one that would be the seventh
   * player. A joiner locks its clock to the host's here and nowhere else.
   */
  private handshake(body: unknown, from: string): void {
    const hello = readHello(body);
    if (hello === null) return;
    const why = refuse(hello, this.seed);
    if (why !== null) return this.turnAway(from, hello, refusalText(why));
    if (!this.peers.has(from) && this.peers.size + 2 > MAX_PLAYERS) {
      return this.turnAway(from, hello, `The room is full at ${MAX_PLAYERS} players.`);
    }
    this.peers.set(from, hello.host);
    this.roster.admit(from, hello.look, this.now);
    this.joined = true;
    if (hello.host && !this.isHost) {
      this.lock.lockTo();
      this.onSnap?.(hello.tick);
    }
    this.phase = 'playing';
    this.note = this.crowdLine();
    this.changed();
  }

  /**
   * A peer that may not play here. The other side reads our own `hello` and
   * refuses us for the same reason, so nothing has to be said twice. A joiner
   * turned away by the host has nobody left and goes back to single player.
   */
  private turnAway(from: string, hello: Hello, message: string): void {
    this.peers.delete(from);
    this.roster.forget(from);
    if (!this.isHost && hello.host) return this.close(message);
    this.note = message;
    this.changed();
  }

  private beat(body: unknown, from: string): void {
    if (this.isHost || this.peers.get(from) !== true) return;
    const hostTick = readBeat(body);
    if (hostTick === null) return;
    const snapTo = this.lock.beat(hostTick, this.now);
    if (snapTo !== null) this.onSnap?.(snapTo);
  }

  /** A peer saying where it is. It is the only authority on that, so it is taken as sent. */
  private moved(body: unknown, from: string): void {
    if (!this.peers.has(from)) return;
    const frame = readFrame(body);
    if (frame !== null) this.roster.hear(from, frame);
  }

  /** The world as the host owns it. It is kept until the next frame writes it in. */
  private told(body: unknown, from: string): void {
    if (this.isHost || this.peers.get(from) !== true) return;
    const update = readWorld(body);
    if (update !== null) this.incoming.push(update);
  }

  /**
   * A peer taking the room over, because the host left (spec section 21.4).
   * Only the lowest peer id may, so every peer reaches the same answer on its
   * own and the message is the confirmation rather than the decision.
   */
  private claimed(body: unknown, from: string): void {
    const tick = readBeat(body);
    if (tick === null || !this.peers.has(from) || this.opened) return;
    if (this.isHost && from >= this.link.selfId) return;
    if (!this.isHost && (this.hostId() !== null || from !== this.lowest())) return;
    this.follow(from, tick);
  }

  /** Follow a new host: its clock, its world, and a note the player reads. */
  private follow(id: string, tick: number): void {
    this.isHost = false;
    this.world = null;
    this.applied = -1;
    for (const peer of this.peers.keys()) this.peers.set(peer, peer === id);
    this.lock.lockTo();
    this.onSnap?.(tick);
    this.note = 'The host left. Another player is hosting now.';
    this.changed();
  }

  private left(id: string): void {
    const wasHost = this.peers.get(id) === true;
    this.peers.delete(id);
    this.roster.forget(id);
    if (wasHost && this.peers.size > 0) return this.migrate();
    if (wasHost) return this.close('The host left the game. Back to single player.');
    if (this.joined && this.peers.size === 0) return this.close('Everyone left the game. Back to single player.');
    this.note = this.crowdLine();
    this.changed();
  }

  /**
   * The host left and somebody is still here, so the lowest peer id takes over
   * (spec section 21.4). Nothing of the divergence set has to be handed over:
   * every peer has been writing the host's deltas into its own record all
   * along, so the new host already holds what it now owns and sends a
   * correction snapshot at once to put the rest of the room on it.
   */
  private migrate(): void {
    const next = this.lowest();
    if (next !== this.link.selfId) {
      this.peers.set(next, true);
      // The new host's ticks start again from its own clock, so what the old
      // host had already sent is no bar to the first update of the new one.
      this.applied = -1;
      this.note = 'The host left. Another player is hosting now.';
      this.changed();
      return;
    }
    this.isHost = true;
    this.applied = -1;
    this.lock.release();
    this.lastBeat = this.now;
    this.world = new WorldSender(this.now);
    this.world.correct();
    this.link.send('host', { tick: this.now });
    this.note = 'The host left. You are hosting now.';
    this.changed();
  }

  /** The lowest peer id in the room, this peer among them. */
  private lowest(): string {
    let low = this.link.selfId;
    for (const id of this.peers.keys()) if (id < low) low = id;
    return low;
  }

  /** The peer this one takes for the host, or null while it knows of none. */
  private hostId(): string | null {
    for (const [id, host] of this.peers) if (host) return id;
    return null;
  }

  /** Who is in the city, or the line a room with nobody in it opened on. */
  private crowdLine(): string {
    const players = this.peers.size + 1;
    return players > 1 ? `${players} players in the city.` : this.openingLine();
  }

  private openingLine(): string {
    return this.isHost ? 'The room is open. Send the link to a friend.' : 'Waiting for the host…';
  }

  private changed(): void {
    this.onChange?.(this.state);
  }
}
