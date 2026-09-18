/**
 * The company in a room: who is in it, what they were told at the handshake,
 * and whose clock everybody keeps (spec sections 21.2 and 21.4).
 *
 * It holds no Trystero and no DOM. Everything that touches a socket is behind
 * `NetLink`, which `link.ts` implements over a Trystero room and a test fills
 * with a pair of ends, so the handshake, the refusals, the shared clock and the
 * fall back to single player are all read headless.
 *
 * What it does not do yet: replicate players, and migrate the host when the
 * host leaves. Both are spec section 21.4 and belong to the issue after this
 * one; here a room whose host leaves degrades to single player like any other
 * room that empties.
 */
import {
  readBeat,
  readHello,
  refuse,
  refusalText,
  type Hello,
  type MessageKind,
  PROTOCOL,
} from './protocol.ts';
import { beatDue, TickLock } from './tick-lock.ts';

/** Players in one room, spec section 21.1. The seventh is turned away at the handshake. */
export const MAX_PLAYERS = 6;

/** What a message weighs on the wire: a `hello`, or the tick of a beat. */
export type MessageBody = Hello | { tick: number };

/**
 * The half of the room that owns a socket. `link.ts` is the one that really
 * does; a test stands two of these back to back instead.
 */
export interface NetLink {
  /** This peer's id in the room. */
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
}

export class Party {
  private readonly link: NetLink;
  private readonly seed: string;
  private readonly room: string;
  private readonly isHost: boolean;
  private readonly lock = new TickLock();
  /** The peers that got through the handshake, and whether each is the host. */
  private readonly peers = new Map<string, boolean>();
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
    this.isHost = options.host;
    this.now = options.tick;
    this.lastBeat = options.tick;
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
   * One frame of the shared clock. The host beats when a beat is due; a joiner
   * answers with the steps that walk it back into line. Everything else in the
   * frame is what a single-player frame does.
   */
  frame(tick: number, steps: number): number {
    this.now = tick;
    if (this.phase === 'offline') return steps;
    if (this.isHost) {
      if (this.peers.size > 0 && beatDue(tick, this.lastBeat)) {
        this.lastBeat = tick;
        this.link.send('tick', { tick });
      }
      return steps;
    }
    return this.lock.steps(steps);
  }

  /** Leave the room and go back to single player, without a reload (spec section 21.2, point 5). */
  close(message = 'Back to single player.'): void {
    if (this.phase === 'offline') return;
    this.phase = 'offline';
    this.note = message;
    this.lock.release();
    this.peers.clear();
    this.link.onPeerJoin = null;
    this.link.onPeerLeave = null;
    this.link.onMessage = null;
    this.link.close();
    this.changed();
  }

  private greet(id: string): void {
    const hello: Hello = { protocol: PROTOCOL, seed: this.seed, tick: this.now, host: this.isHost };
    this.link.send('hello', hello, id);
  }

  private heard(kind: MessageKind, body: unknown, from: string): void {
    if (this.phase === 'offline') return;
    if (kind === 'hello') this.handshake(body, from);
    else if (kind === 'tick') this.beat(body, from);
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

  private left(id: string): void {
    const wasHost = this.peers.get(id) === true;
    this.peers.delete(id);
    if (wasHost) return this.close('The host left the game. Back to single player.');
    if (this.joined && this.peers.size === 0) return this.close('Everyone left the game. Back to single player.');
    this.note = this.crowdLine();
    this.changed();
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
