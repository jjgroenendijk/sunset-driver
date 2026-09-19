import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  clearRoomFromHash,
  inviteLink,
  randomRoomCode,
  readRoomCode,
  readRoomFromLocation,
  writeRoomToHash,
} from '../src/net/invite.ts';
import { PROTOCOL, readBeat, readHello, refuse } from '../src/net/protocol.ts';
import { BEAT_TICKS, SNAP_TICKS, TickLock } from '../src/net/tick-lock.ts';
import { MAX_PLAYERS, Party, type MessageBody, type NetLink } from '../src/net/party.ts';
import type { MessageKind } from '../src/net/protocol.ts';
import { EMPTY_INPUT } from '../src/sim/input.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';

const SEED = 'sunset';
const ROOM = 'K7M3QX';

/** A record standing on a tick, which is what a frame of the room reads. */
function at(tick: number): SimState {
  const state = createSimState(1);
  state.tick = tick;
  return state;
}

interface Sent {
  kind: MessageKind;
  body: MessageBody;
  to: string | undefined;
}

/** A link with nothing behind it: the test drives the peer events and reads what was said. */
class TestLink implements NetLink {
  readonly selfId = 'me';
  readonly via = 'test';
  readonly sent: Sent[] = [];
  closed = false;
  onPeerJoin: ((id: string) => void) | null = null;
  onPeerLeave: ((id: string) => void) | null = null;
  onMessage: ((kind: MessageKind, body: unknown, from: string) => void) | null = null;

  send(kind: MessageKind, body: MessageBody, to?: string): void {
    this.sent.push({ kind, body, to });
  }

  close(): void {
    this.closed = true;
  }

  /** A peer arrives and says hello, which is what a real peer does on the join. */
  greet(id: string, hello: { seed?: string; tick?: number; host?: boolean; protocol?: number } = {}): void {
    this.onPeerJoin?.(id);
    this.onMessage?.(
      'hello',
      { protocol: hello.protocol ?? PROTOCOL, seed: hello.seed ?? SEED, tick: hello.tick ?? 0, host: hello.host ?? false },
      id,
    );
  }
}

/** The last message of a kind, which is what the other side would have read. */
function last(link: TestLink, kind: MessageKind): Sent | undefined {
  return [...link.sent].reverse().find((message) => message.kind === kind);
}

describe('the room code and the invite link', () => {
  it('draws a code of the spoken alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = randomRoomCode();
      expect(code).toHaveLength(CODE_LENGTH);
      for (const character of code) expect(CODE_ALPHABET).toContain(character);
    }
  });

  it('takes a code as a player types it, and refuses what is not one', () => {
    expect(readRoomCode(' k7m3-qx ')).toBe(ROOM);
    expect(readRoomCode('K7M3Q')).toBeNull();
    expect(readRoomCode('K7M3Q0')).toBeNull();
    expect(readRoomCode('')).toBeNull();
  });

  it('carries the seed and the room in one link, and reads both back', () => {
    const link = inviteLink('https://example.test/play#seed=sunset', 'harbour', ROOM);
    expect(link).toContain('seed=harbour');
    expect(readRoomFromLocation(new URL(link).hash)).toBe(ROOM);
  });

  it('leaves the other parameters of the hash alone', () => {
    expect(readRoomFromLocation(writeRoomToHash('#seed=sunset', ROOM))).toBe(ROOM);
    expect(writeRoomToHash('#seed=sunset', ROOM)).toContain('seed=sunset');
    expect(clearRoomFromHash(writeRoomToHash('#seed=sunset', ROOM))).toBe('#seed=sunset');
    expect(clearRoomFromHash('#room=K7M3QX')).toBe('');
  });
});

describe('what a peer is allowed to say', () => {
  it('reads a hello, and refuses what is not one', () => {
    expect(readHello({ protocol: PROTOCOL, seed: SEED, tick: 12, host: true })?.tick).toBe(12);
    expect(readHello({ protocol: PROTOCOL, seed: SEED, tick: -1, host: true })).toBeNull();
    expect(readHello({ protocol: PROTOCOL, seed: SEED, tick: 1.5, host: true })).toBeNull();
    expect(readHello({ protocol: PROTOCOL, seed: 7, tick: 1, host: true })).toBeNull();
    expect(readHello('hello')).toBeNull();
    expect(readHello(null)).toBeNull();
  });

  it('reads a beat, and refuses a tick that is not a tick', () => {
    expect(readBeat({ tick: 90 })).toBe(90);
    expect(readBeat({ tick: Number.NaN })).toBeNull();
    expect(readBeat({})).toBeNull();
  });

  it('turns away another city and another protocol', () => {
    expect(refuse({ protocol: PROTOCOL, seed: SEED, tick: 0, host: true }, SEED)).toBeNull();
    expect(refuse({ protocol: PROTOCOL, seed: 'harbour', tick: 0, host: true }, SEED)).toBe('seed');
    expect(refuse({ protocol: PROTOCOL + 1, seed: SEED, tick: 0, host: true }, SEED)).toBe('protocol');
  });
});

describe('the shared clock', () => {
  it('is the local clock until a beat arrives', () => {
    const lock = new TickLock();
    expect(lock.locked).toBe(false);
    expect(lock.steps(1)).toBe(1);
  });

  it('walks in behind the host, one step a frame', () => {
    const lock = new TickLock();
    expect(lock.beat(1010, 1000)).toBeNull();
    expect(lock.gap).toBe(10);
    expect(lock.steps(1)).toBe(2);
    expect(lock.gap).toBe(9);
  });

  it('walks back when it is ahead, and never takes a step it was not offered', () => {
    const lock = new TickLock();
    lock.beat(990, 1000);
    expect(lock.steps(1)).toBe(0);
    expect(lock.gap).toBe(-9);
    expect(lock.steps(0)).toBe(0);
    expect(lock.gap).toBe(-9);
  });

  it('jumps rather than walks where the gap is too wide', () => {
    const lock = new TickLock();
    expect(lock.beat(1000 + SNAP_TICKS, 1000)).toBe(1000 + SNAP_TICKS);
    expect(lock.gap).toBe(0);
    expect(lock.steps(1)).toBe(1);
  });

  it('lets go of the host, and runs on the local clock again', () => {
    const lock = new TickLock();
    lock.beat(1010, 1000);
    lock.release();
    expect(lock.locked).toBe(false);
    expect(lock.steps(1)).toBe(1);
  });
});

describe('a room', () => {
  it('says hello to a peer that arrives, and counts it once it answers', () => {
    const link = new TestLink();
    const party = new Party(link, { seed: SEED, room: ROOM, host: true, tick: 0 });
    link.greet('a');
    expect(last(link, 'hello')?.to).toBe('a');
    expect(last(link, 'hello')?.body).toMatchObject({ seed: SEED, host: true });
    expect(party.state.players).toBe(2);
    expect(party.state.phase).toBe('playing');
  });

  it('answers a hello from a peer whose join it never saw', () => {
    const link = new TestLink();
    const party = new Party(link, { seed: SEED, room: ROOM, host: false, tick: 0 });
    link.onMessage?.('hello', { protocol: PROTOCOL, seed: SEED, tick: 40, host: true }, 'host');
    expect(last(link, 'hello')?.to).toBe('host');
    expect(party.state.players).toBe(2);
    link.onMessage?.('hello', { protocol: PROTOCOL, seed: SEED, tick: 40, host: true }, 'host');
    expect(link.sent.filter((message) => message.kind === 'hello')).toHaveLength(1);
  });

  it('beats the authoritative tick to the room, and only while somebody is in it', () => {
    const link = new TestLink();
    const party = new Party(link, { seed: SEED, room: ROOM, host: true, tick: 0 });
    expect(party.frame(at(BEAT_TICKS), EMPTY_INPUT, 1)).toBe(1);
    expect(last(link, 'tick')).toBeUndefined();
    link.greet('a');
    party.frame(at(BEAT_TICKS), EMPTY_INPUT, 1);
    expect(last(link, 'tick')?.body).toEqual({ tick: BEAT_TICKS });
    party.frame(at(BEAT_TICKS + 1), EMPTY_INPUT, 1);
    expect(link.sent.filter((message) => message.kind === 'tick')).toHaveLength(1);
  });

  it('locks a joiner to the host at the handshake', () => {
    const link = new TestLink();
    const party = new Party(link, { seed: SEED, room: ROOM, host: false, tick: 0 });
    const snaps: number[] = [];
    party.onSnap = (tick) => snaps.push(tick);
    link.greet('host', { host: true, tick: 9_000 });
    expect(snaps).toEqual([9_000]);
    party.frame(at(9_000), EMPTY_INPUT, 1);
    link.onMessage?.('tick', { tick: 9_010 }, 'host');
    expect(party.frame(at(9_000), EMPTY_INPUT, 1)).toBe(2);
  });

  it('takes a beat from the host and from nobody else', () => {
    const link = new TestLink();
    const party = new Party(link, { seed: SEED, room: ROOM, host: false, tick: 0 });
    link.greet('host', { host: true, tick: 100 });
    party.frame(at(100), EMPTY_INPUT, 1);
    link.onMessage?.('tick', { tick: 160 }, 'other');
    expect(party.frame(at(100), EMPTY_INPUT, 1)).toBe(1);
  });

  it('refuses a peer from another city, and says so', () => {
    const link = new TestLink();
    const party = new Party(link, { seed: SEED, room: ROOM, host: true, tick: 0 });
    link.greet('a', { seed: 'harbour' });
    expect(party.state.players).toBe(1);
    expect(party.state.message).toContain('another city');
    expect(party.state.phase).toBe('waiting');
  });

  it('goes back to single player when the host it joined is in another city', () => {
    const link = new TestLink();
    const party = new Party(link, { seed: SEED, room: ROOM, host: false, tick: 0 });
    link.greet('host', { host: true, seed: 'harbour', tick: 500 });
    expect(party.state.phase).toBe('offline');
    expect(link.closed).toBe(true);
  });

  it('turns away the player after the last seat', () => {
    const link = new TestLink();
    const party = new Party(link, { seed: SEED, room: ROOM, host: true, tick: 0 });
    for (let i = 0; i < MAX_PLAYERS; i++) link.greet(`p${i}`);
    expect(party.state.players).toBe(MAX_PLAYERS);
    expect(party.state.message).toContain('full');
  });

  it('goes back to the line it opened on when a peer it never took leaves', () => {
    const link = new TestLink();
    const party = new Party(link, { seed: SEED, room: ROOM, host: true, tick: 0 });
    link.greet('a', { seed: 'harbour' });
    link.onPeerLeave?.('a');
    expect(party.state.phase).toBe('waiting');
    expect(party.state.message).toBe('The room is open. Send the link to a friend.');
  });

  it('goes back to single player when the room empties, and not before', () => {
    const link = new TestLink();
    const party = new Party(link, { seed: SEED, room: ROOM, host: true, tick: 0 });
    link.greet('a');
    link.greet('b');
    link.onPeerLeave?.('a');
    expect(party.state.phase).toBe('playing');
    link.onPeerLeave?.('b');
    expect(party.state.phase).toBe('offline');
    expect(party.state.players).toBe(1);
    expect(link.closed).toBe(true);
  });

  it('goes back to single player when the host leaves', () => {
    const link = new TestLink();
    const party = new Party(link, { seed: SEED, room: ROOM, host: false, tick: 0 });
    link.greet('host', { host: true, tick: 10 });
    link.onPeerLeave?.('host');
    expect(party.state.phase).toBe('offline');
    expect(party.state.message).toContain('host');
  });

  it('takes the steps it was handed once it is on its own again', () => {
    const link = new TestLink();
    const party = new Party(link, { seed: SEED, room: ROOM, host: false, tick: 0 });
    link.greet('host', { host: true, tick: 400 });
    party.frame(at(400), EMPTY_INPUT, 1);
    link.onMessage?.('tick', { tick: 460 }, 'host');
    party.close();
    expect(party.frame(at(400), EMPTY_INPUT, 1)).toBe(1);
  });
});
