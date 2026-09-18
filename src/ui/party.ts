/**
 * The Open game to others page of the pause menu (spec section 21.2): the room
 * code, the invite link, and the line saying who is in the city.
 *
 * It holds no networking. Every item calls an action `main.ts` hands it, and
 * the page is redrawn from one state object, so what the player reads is always
 * what `src/net/control.ts` last reported.
 */
import type { ControlState } from '../net/control.ts';
import { button, card, page } from './title-parts.ts';

export interface PartyActions {
  /** Where the room stands, read afresh on every redraw. */
  state(): ControlState;
  /** Open a game to others on a fresh room code. */
  open(): void;
  /** Leave the room and carry on in single player. */
  leave(): void;
  /** The link a joiner opens, or null while there is no room. */
  invite(): string | null;
}

/** Put text on the clipboard and say whether it went. The pause menu owns both. */
export type CopyText = (text: string, done: string) => void;

export interface PartyPage {
  root: HTMLElement;
  /** Draw the page from the state the actions report. */
  update(): void;
}

/** What the player reads where there is no room yet. */
const NO_ROOM = 'No room yet';

export function buildPartyPage(actions: PartyActions, copyText: CopyText, back: () => void): PartyPage {
  const root = page('title-page pause-party');
  const sheet = card(
    'IX',
    'Open game to others',
    'Up to six players in one city, over a link between the browsers. Nobody runs a server, and no save is shared.',
  );

  const code = document.createElement('p');
  code.className = 'pause-seed';
  const link = document.createElement('textarea');
  link.className = 'pause-text pause-invite';
  link.spellcheck = false;
  link.readOnly = true;
  link.dataset.nav = '';
  link.setAttribute('aria-label', 'Invite link');

  const status = document.createElement('p');
  status.className = 'pause-status';
  status.setAttribute('aria-live', 'polite');

  const open = button('title-cta', 'Open game to others', () => actions.open());
  const copy = button('title-back', 'Copy invite link', () => {
    const invite = actions.invite();
    if (invite !== null) copyText(invite, 'The invite link is on the clipboard.');
  });
  const leave = button('title-back', 'Leave game', () => actions.leave());
  const row = document.createElement('div');
  row.className = 'pause-row';
  row.append(open, copy, leave, button('title-back', 'Back', back));

  const update = (): void => {
    const state = actions.state();
    const live = state.phase === 'waiting' || state.phase === 'playing';
    const invite = actions.invite();
    code.textContent = live ? `Room ${state.room}` : NO_ROOM;
    link.value = live && invite !== null ? invite : '';
    status.textContent = playersLine(state);
    open.disabled = state.phase !== 'offline';
    copy.disabled = !live || invite === null;
    leave.disabled = !live;
  };

  sheet.append(code, link, row, status);
  root.append(sheet);
  return { root, update };
}

/** The status line: what just happened, and who is in the city while somebody is. */
function playersLine(state: ControlState): string {
  if (state.phase !== 'playing') return state.message;
  return `${state.message} Signalling over ${state.via}.`;
}
