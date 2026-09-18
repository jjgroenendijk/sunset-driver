/**
 * What `main.ts` calls once to give a session a room it does not have yet
 * (spec section 21.2).
 *
 * This is the one file under `src/net` that reads the page: the address bar
 * carries the invite link, so it is where a joiner's room is read from and
 * where a host's room is written to. Everything else here is either pure or
 * behind `link.ts`.
 */
import type { SimState } from '../sim/simulation.ts';
import { clearRoomFromHash, readRoomFromLocation, writeRoomToHash } from './invite.ts';
import { PartyControl, type ControlState } from './control.ts';
import type { PartyActions } from '../ui/party.ts';

export interface PartyHooks {
  /** Put the record on the host's tick, as a load or a metro trip puts it somewhere else. */
  snap: (tick: number) => void;
  /** Draw the pause menu's room page again, because what it says has changed. */
  redraw: () => void;
}

export interface SessionParty {
  /** What the frame loop and the session hold. */
  control: PartyControl;
  /** What the pause menu's room page presses. */
  actions: PartyActions;
  /**
   * Join the room the page was opened on, where it was opened on one. It is a
   * call of its own because the first thing it does is redraw the pause menu,
   * which is built from `actions` and so does not exist yet here.
   */
  join(): void;
}

/**
 * Wire a session's multiplayer up: the clock, the pause menu, and the address
 * bar. An invite link is the only thing that connects a session without a
 * press, and `join` is where it does it.
 */
export function attachParty(seed: string, record: () => SimState, hooks: PartyHooks): SessionParty {
  const control = new PartyControl(seed, record);
  control.onSnap = hooks.snap;
  control.onChange = (state) => {
    history.replaceState(null, '', roomHash(location.hash, state));
    hooks.redraw();
  };
  return {
    control,
    join: () => {
      const room = readRoomFromLocation(location.hash);
      if (room !== null) void control.join(room);
    },
    actions: {
      state: () => control.state,
      open: () => void control.open(),
      leave: () => control.close(),
      invite: () => control.invite(location.href),
    },
  };
}

/** The hash a room leaves behind: the invite link while it is open, the bare seed once it is not. */
function roomHash(hash: string, state: ControlState): string {
  const live = state.phase === 'waiting' || state.phase === 'playing';
  return live ? writeRoomToHash(hash, state.room) : clearRoomFromHash(hash);
}
