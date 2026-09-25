/**
 * What the session holds instead of the networking: a handle that is offline
 * until the player opens a game or opens an invite link (spec section 21.2,
 * point 4).
 *
 * Nothing under `src/net` is imported at the top level except this file and
 * `invite.ts`, and neither of them touches a socket. The Trystero code and the
 * room are fetched on the press, so a single-player session downloads nothing
 * of the multiplayer and connects to nothing.
 */
import type { InputFrame } from '../sim/input.ts';
import type { SimState } from '../sim/simulation.ts';
import { inviteLink, randomRoomCode } from './invite.ts';
import type { Party, PartyState } from './party.ts';
import type { RemotePlayer } from './roster.ts';

/**
 * Where the multiplayer stands, as the pause menu draws it. `connecting` is the
 * wait on the relays, which is this file's alone: a room that is open is one of
 * the phases `party.ts` reports.
 */
type ControlPhase = PartyState['phase'] | 'connecting';

export interface ControlState extends Omit<PartyState, 'phase'> {
  phase: ControlPhase;
}

/** What a session with nobody else in it has to hand back, made once. */
const ALONE: readonly RemotePlayer[] = [];

export class PartyControl {
  private readonly seed: string;
  /**
   * The record: read for the tick a room opens on, for the look the handshake
   * carries, and for the frames that go out. Never written here.
   */
  private readonly record: () => SimState;
  private party: Party | null = null;
  private connecting = false;
  private room = '';
  private host = false;
  private note = '';

  /** Called whenever the line the player reads changes. */
  onChange: ((state: ControlState) => void) | null = null;
  /** The tick the record must jump to, because the host's clock says so (spec section 21.4). */
  onSnap: ((tick: number) => void) | null = null;

  constructor(seed: string, record: () => SimState) {
    this.seed = seed;
    this.record = record;
  }

  get state(): ControlState {
    const party = this.party;
    if (party) return party.state;
    return {
      phase: this.connecting ? 'connecting' : 'offline',
      room: this.room,
      host: this.host,
      players: 1,
      via: '',
      message: this.note,
    };
  }

  /** Whether a room is open or being opened, so the menu offers to leave rather than to open. */
  get live(): boolean {
    return this.party !== null || this.connecting;
  }

  /** Open a game to others on a fresh room code (spec section 21.2, point 1). */
  async open(): Promise<void> {
    await this.start(randomRoomCode(), true);
  }

  /** Join the room an invite link named (spec section 21.2, point 2). */
  async join(room: string): Promise<void> {
    await this.start(room, false);
  }

  /** Leave the room. The session carries on where it stood, without a reload. */
  close(): void {
    this.party?.close();
  }

  /**
   * The frame's steps, corrected for the host's clock, with everything the room
   * owes sent and everything it was told written in. Single player is the steps
   * it was handed and nothing else.
   */
  frame(state: SimState, input: InputFrame, steps: number): number {
    return this.party?.frame(state, input, steps) ?? steps;
  }

  /** Everybody else in the city, as the frame draws them (spec section 21.5). */
  remotes(tick: number): readonly RemotePlayer[] {
    return this.party?.remotes(tick) ?? ALONE;
  }

  /** The link a host copies out of the pause menu, or null while there is no room. */
  invite(href: string): string | null {
    return this.room === '' ? null : inviteLink(href, this.seed, this.room);
  }

  private async start(room: string, host: boolean): Promise<void> {
    if (this.live) return;
    this.connecting = true;
    this.room = room;
    this.host = host;
    this.note = host ? 'Opening the room…' : `Joining room ${room}…`;
    this.changed();
    try {
      const [{ openLink }, { Party }] = await Promise.all([import('./link.ts'), import('./party.ts')]);
      const now = this.record();
      // The party is built on the link before the relays answer, so a peer
      // that connects during the wait is greeted rather than missed.
      const party = await openLink(room, (link) => {
        const opened = new Party(link, { seed: this.seed, room, host, tick: now.tick, look: now.character });
        opened.onChange = (state) => this.settle(state);
        opened.onSnap = (tick) => this.onSnap?.(tick);
        return opened;
      });
      // A room that closed itself inside the wait, refused by its host, is
      // already settled: holding it would leave the menu on a dead room.
      if (party.state.phase !== 'offline') this.party = party;
    } catch (error) {
      // Every way of reaching the other browsers failed, and the game is
      // already running: it stays where it is, on its own (spec section 21.2,
      // point 5).
      this.note = 'No relay answered, so the game stays single player.';
      console.warn('multiplayer: the room could not be opened.', error);
    } finally {
      this.connecting = false;
      this.changed();
    }
  }

  /**
   * A room that closed itself is let go of, so the menu can open another one.
   * The session's shared territory goes with it: spec section 21.3 keeps a room
   * out of everybody's save, so the player's own captures are put back and the
   * map they left single player on is the map they come back to.
   */
  private settle(state: ControlState): void {
    if (state.phase === 'offline') {
      const own = this.party?.ownCaptures ?? null;
      if (own !== null) this.record().factions.captured = own;
      this.party = null;
      this.room = '';
      this.host = false;
      this.note = state.message;
    }
    this.changed();
  }

  private changed(): void {
    this.onChange?.(this.state);
  }
}
