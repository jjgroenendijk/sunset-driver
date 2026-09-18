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
import { inviteLink, randomRoomCode } from './invite.ts';
import type { Party, PartyState } from './party.ts';

/**
 * Where the multiplayer stands, as the pause menu draws it. `connecting` is the
 * wait on the relays, which is this file's alone: a room that is open is one of
 * the phases `party.ts` reports.
 */
export type ControlPhase = PartyState['phase'] | 'connecting';

export interface ControlState extends Omit<PartyState, 'phase'> {
  phase: ControlPhase;
}

export class PartyControl {
  private readonly seed: string;
  private readonly tick: () => number;
  private party: Party | null = null;
  private connecting = false;
  private room = '';
  private host = false;
  private note = 'Open the game and anyone with the link can drive this city with you.';

  /** Called whenever the line the player reads changes. */
  onChange: ((state: ControlState) => void) | null = null;
  /** The tick the record must jump to, because the host's clock says so (spec section 21.4). */
  onSnap: ((tick: number) => void) | null = null;

  constructor(seed: string, tick: () => number) {
    this.seed = seed;
    this.tick = tick;
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

  /** The frame's steps, corrected for the host's clock. Single player is the steps it was handed. */
  frame(tick: number, steps: number): number {
    return this.party?.frame(tick, steps) ?? steps;
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
      const link = await openLink(room);
      const party = new Party(link, { seed: this.seed, room, host, tick: this.tick() });
      party.onChange = (state) => this.settle(state);
      party.onSnap = (tick) => this.onSnap?.(tick);
      this.party = party;
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

  /** A room that closed itself is let go of, so the menu can open another one. */
  private settle(state: ControlState): void {
    if (state.phase === 'offline') {
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
