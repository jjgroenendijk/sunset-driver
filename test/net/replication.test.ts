import { describe, expect, it } from 'vitest';
import {
  applyWorld,
  DELTA_TICKS,
  PARTS_PER_DELTA,
  readWorld,
  SNAPSHOT_TICKS,
  WorldSender,
} from '../../src/net/divergence.ts';
import { compareStrings } from '../../src/core/sort.ts';
import { FRAME_LENGTH, frameOf, packFrame, readFrame, type PlayerFrame } from '../../src/net/move.ts';
import { MAX_PLAYERS, Party, type MessageBody, type NetLink } from '../../src/net/party.ts';
import type { MessageKind } from '../../src/net/protocol.ts';
import { DELAY_TICKS, REACH_TICKS, Replica } from '../../src/net/replica.ts';
import { FAR_TICKS, INTEREST_RANGE, NEAR_TICKS, Roster } from '../../src/net/roster.ts';
import { BEAT_TICKS } from '../../src/net/tick-lock.ts';
import { EMPTY_INPUT } from '../../src/sim/input.ts';
import { createSimState, type SimState } from '../../src/sim/simulation.ts';

const SEED = 'sunset';
const ROOM = 'K7M3QX';

/** A frame of a player standing still, which a test then moves. */
function frame(over: Partial<PlayerFrame> = {}): PlayerFrame {
  return { ...frameOf(createSimState(1), EMPTY_INPUT), ...over };
}

/**
 * A room with nothing behind it: every member's link hands what it sends
 * straight to the others, so a whole party is driven headless.
 */
class Wire implements NetLink {
  readonly via = 'test';
  readonly sent: { kind: MessageKind; body: MessageBody; to: string | undefined }[] = [];
  onPeerJoin: ((id: string) => void) | null = null;
  onPeerLeave: ((id: string) => void) | null = null;
  onMessage: ((kind: MessageKind, body: unknown, from: string) => void) | null = null;
  gone = false;

  constructor(
    readonly selfId: string,
    private readonly room: Wire[],
  ) {
    room.push(this);
  }

  send(kind: MessageKind, body: MessageBody, to?: string): void {
    this.sent.push({ kind, body, to });
    for (const other of this.room) {
      if (other === this || other.gone) continue;
      if (to !== undefined && other.selfId !== to) continue;
      other.onMessage?.(kind, body, this.selfId);
    }
  }

  close(): void {
    this.gone = true;
  }
}

/** One player of a test room: a party, and the record it reads and writes. */
class Member {
  readonly link: Wire;
  readonly party: Party;
  readonly state: SimState;

  constructor(id: string, room: Wire[], host: boolean, tick: number) {
    this.link = new Wire(id, room);
    this.state = createSimState(1);
    this.state.tick = tick;
    this.party = new Party(this.link, { seed: SEED, room: ROOM, host, tick });
    this.party.onSnap = (to) => {
      this.state.tick = to;
    };
  }

  /** One frame, which the record then steps by hand so a test can say how far. */
  frame(steps = 1): number {
    return this.party.frame(this.state, EMPTY_INPUT, steps);
  }

  /** Run `count` frames, moving the record on a tick each time. */
  run(count: number): void {
    for (let i = 0; i < count; i++) {
      this.frame();
      this.state.tick += 1;
    }
  }
}

/** Two members meet, which is what Trystero reports on both sides. */
function meet(...members: Member[]): void {
  for (const a of members) {
    for (const b of members) if (a !== b) a.link.onPeerJoin?.(b.link.selfId);
  }
}

/** One member leaves, as every other member hears it. */
function leaves(who: Member, room: Member[]): void {
  who.link.gone = true;
  for (const other of room) if (other !== who) other.link.onPeerLeave?.(who.link.selfId);
}

describe('a player on the wire', () => {
  it('packs a frame and reads the same one back', () => {
    const sent = frame({ tick: 1_234_567, x: 12.5, y: -40.25, heading: 1.5, driving: false, sprint: true });
    const read = readFrame(packFrame(sent));
    expect(read?.tick).toBe(1_234_567);
    expect(read?.x).toBeCloseTo(12.5, 3);
    expect(read?.y).toBeCloseTo(-40.25, 3);
    expect(read?.heading).toBeCloseTo(1.5, 3);
    expect(read?.driving).toBe(false);
    expect(read?.sprint).toBe(true);
    expect(read?.cls).toBe(sent.cls);
  });

  it('reads one out of the buffer a strategy may hand back instead', () => {
    const packed = packFrame(frame({ tick: 90, x: 3 }));
    expect(readFrame(packed.buffer)?.x).toBeCloseTo(3, 3);
  });

  it('refuses what is not a frame', () => {
    expect(readFrame(new Float32Array(FRAME_LENGTH - 1))).toBeNull();
    expect(readFrame({ tick: 1 })).toBeNull();
    expect(readFrame(null)).toBeNull();
    const broken = packFrame(frame());
    broken[6] = Number.NaN;
    expect(readFrame(broken)).toBeNull();
  });
});

describe('a remote player', () => {
  it('has nothing to draw until a frame arrives', () => {
    expect(new Replica().at(100)).toBeNull();
  });

  it('draws the moment between the two frames around it', () => {
    const replica = new Replica();
    replica.push(frame({ tick: 100, x: 0, driving: false }));
    replica.push(frame({ tick: 120, x: 20, driving: false }));
    // 110 is halfway between the two, so the pose is halfway along.
    expect(replica.at(110 + DELAY_TICKS)?.x).toBeCloseTo(10, 5);
  });

  it('carries a late player on along the way they were going', () => {
    const replica = new Replica();
    replica.push(frame({ tick: 100, x: 0, heading: 0, speed: 6, driving: false }));
    // Six ticks past the last frame is a tenth of a second at six metres a
    // second, which is where a walker who kept walking would be.
    expect(replica.at(106 + DELAY_TICKS)?.x).toBeCloseTo(0.6, 3);
  });

  it('stops carrying them on once they are gone rather than late', () => {
    const replica = new Replica();
    replica.push(frame({ tick: 100, x: 0, heading: 0, speed: 6, driving: false }));
    const far = replica.at(100 + REACH_TICKS * 4 + DELAY_TICKS);
    expect(far?.x).toBeCloseTo((6 * REACH_TICKS) / 60, 3);
  });

  it('drops a frame that arrives after a newer one', () => {
    const replica = new Replica();
    replica.push(frame({ tick: 120, x: 20 }));
    replica.push(frame({ tick: 100, x: 0 }));
    expect(replica.held).toBe(1);
    expect(replica.newest).toBe(120);
  });
});

describe('who is owed a frame', () => {
  it('sends to a peer nearby ten times a second, and to a distant one twice', () => {
    const roster = new Roster();
    roster.admit('near', {}, 0);
    roster.admit('far', {}, 0);
    roster.hear('near', frame({ tick: 0, x: 0, y: 0 }));
    roster.hear('far', frame({ tick: 0, x: INTEREST_RANGE + 50, y: 0 }));
    const here = { x: 0, y: 0 };
    // The peer at hand is owed a frame; the one across the map is not owed one
    // yet, because it is owed them five times less often.
    expect(roster.due(DELAY_TICKS, here)).toEqual(['near']);
    expect(roster.due(DELAY_TICKS + NEAR_TICKS - 1, here)).toEqual([]);
    expect(roster.due(DELAY_TICKS + NEAR_TICKS, here)).toEqual(['near']);
    expect(roster.due(FAR_TICKS, here).sort(compareStrings)).toEqual(['far', 'near']);
  });

  it('forgets a peer that left, and everybody at once when the room closes', () => {
    const roster = new Roster();
    roster.admit('a', {}, 0);
    roster.admit('b', {}, 0);
    roster.forget('a');
    expect(roster.size).toBe(1);
    roster.clear();
    expect(roster.size).toBe(0);
  });
});

describe('what the host owns', () => {
  it('sends only the parts that changed, and no more than the cap at once', () => {
    const state = createSimState(1);
    const sender = new WorldSender(0);
    // Nothing has gone out yet, so every part is new: two deltas cover the set.
    const first = sender.due(state, DELTA_TICKS);
    const second = sender.due(state, DELTA_TICKS * 2);
    expect(Object.keys(first?.parts ?? {})).toHaveLength(PARTS_PER_DELTA);
    expect(Object.keys(second?.parts ?? {})).toHaveLength(PARTS_PER_DELTA);
    expect(sender.due(state, DELTA_TICKS * 3)).toBeNull();
    state.fires.nextBlaze = 4;
    expect(Object.keys(sender.due(state, DELTA_TICKS * 4)?.parts ?? {})).toEqual(['fires']);
  });

  it('sends the whole set as a correction, on its own period and on demand', () => {
    const state = createSimState(1);
    const sender = new WorldSender(0);
    const correction = sender.due(state, SNAPSHOT_TICKS);
    expect(correction?.full).toBe(true);
    expect(Object.keys(correction?.parts ?? {})).toHaveLength(8);
    sender.correct();
    expect(sender.due(state, SNAPSHOT_TICKS + DELTA_TICKS)?.full).toBe(true);
  });

  it('refuses a part that is not the shape that part of a record has', () => {
    expect(readWorld({ tick: 1, full: false, parts: { police: { units: 'lots' } } })).toBeNull();
    expect(readWorld({ tick: 1, full: false, parts: { captured: ['a block'] } })).toBeNull();
    expect(readWorld({ tick: -1, full: false, parts: { crimes: { settled: [] } } })).toBeNull();
    expect(readWorld({ tick: 1, full: false, parts: {} })).toBeNull();
    expect(readWorld(null)).toBeNull();
  });

  it('writes what it owns into a record and leaves the career alone', () => {
    const state = createSimState(1);
    state.money = 900;
    const update = readWorld({
      tick: 10,
      full: true,
      parts: { crimes: { settled: [{ id: 3 }] }, captured: [7] },
    });
    expect(update).not.toBeNull();
    if (update) applyWorld(state, update);
    expect(state.crimes.settled).toHaveLength(1);
    expect(state.factions.captured).toEqual([7]);
    expect(state.money).toBe(900);
  });
});

describe('a room of two', () => {
  it('draws the host where the host said it was', () => {
    const room: Wire[] = [];
    const host = new Member('a', room, true, 1_000);
    const joiner = new Member('b', room, false, 0);
    meet(host, joiner);
    expect(joiner.state.tick).toBe(1_000);
    host.state.player.x = 40;
    host.state.player.driving = false;
    host.frame();
    const drawn = joiner.party.remotes(joiner.state.tick);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.pose.x).toBeCloseTo(40, 3);
    expect(drawn[0]?.pose.driving).toBe(false);
  });

  it('hands the world the host owns to the joiner, and never the other way round', () => {
    const room: Wire[] = [];
    const host = new Member('a', room, true, 1_000);
    const joiner = new Member('b', room, false, 0);
    meet(host, joiner);
    joiner.state.money = 250;
    host.state.fires.nextBlaze = 6;
    host.state.factions.captured = [11, 12];
    // Two deltas carry the whole set, and the joiner writes each in at its own
    // next frame.
    host.run(DELTA_TICKS * 4);
    joiner.run(3);
    expect(joiner.state.fires.nextBlaze).toBe(6);
    expect(joiner.state.factions.captured).toEqual([11, 12]);
    expect(joiner.state.money).toBe(250);
    expect(host.state.money).toBe(500);
  });

  it('keeps the blocks a joiner held, so the session reaches no save', () => {
    const room: Wire[] = [];
    const host = new Member('a', room, true, 1_000);
    const joiner = new Member('b', room, false, 0);
    meet(host, joiner);
    joiner.state.factions.captured = [1, 2];
    host.state.factions.captured = [9];
    host.run(DELTA_TICKS * 4);
    joiner.run(3);
    // The room's shared map is what the joiner plays on, and the map it came in
    // with is what it leaves with (spec section 21.3).
    expect(joiner.state.factions.captured).toEqual([9]);
    expect(joiner.party.ownCaptures).toEqual([1, 2]);
    expect(host.party.ownCaptures).toBeNull();
  });

  it('turns away the player after the last seat', () => {
    const room: Wire[] = [];
    const host = new Member('a', room, true, 0);
    for (let i = 0; i < MAX_PLAYERS; i++) new Member(`p${i}`, room, false, 0).link.onPeerJoin?.('a');
    expect(host.party.state.players).toBe(MAX_PLAYERS);
  });
});

describe('the host leaving', () => {
  it('hands the room to the lowest peer id, which beats and corrects at once', () => {
    const room: Wire[] = [];
    const host = new Member('c', room, true, 5_000);
    const low = new Member('a', room, false, 0);
    const other = new Member('b', room, false, 0);
    const all = [host, low, other];
    meet(...all);
    expect(low.state.tick).toBe(5_000);
    leaves(host, all);
    expect(low.party.state.host).toBe(true);
    expect(other.party.state.host).toBe(false);
    expect(low.party.state.message).toContain('You are hosting now.');
    expect(other.party.state.message).toContain('Another player is hosting now.');
    // The new host beats its own clock, and puts the room on the world it holds.
    low.run(BEAT_TICKS + 1);
    expect(low.link.sent.some((message) => message.kind === 'tick')).toBe(true);
    const world = low.link.sent.find((message) => message.kind === 'world');
    expect(world).toBeDefined();
    expect((world?.body as { full: boolean }).full).toBe(true);
  });

  it('takes a beat from the peer that took over, and from nobody else', () => {
    const room: Wire[] = [];
    const host = new Member('c', room, true, 5_000);
    const low = new Member('a', room, false, 5_000);
    const other = new Member('b', room, false, 5_000);
    const all = [host, low, other];
    meet(...all);
    leaves(host, all);
    low.state.tick = 5_100;
    low.frame();
    // `other` is behind the new host, so its frame takes the extra step that
    // walks it back into line.
    expect(other.frame()).toBe(2);
  });

  it('still falls back to single player when the last peer left was the host', () => {
    const room: Wire[] = [];
    const host = new Member('a', room, true, 0);
    const joiner = new Member('b', room, false, 0);
    const all = [host, joiner];
    meet(...all);
    leaves(host, all);
    expect(joiner.party.state.phase).toBe('offline');
    expect(joiner.party.state.message).toContain('host');
  });
});
