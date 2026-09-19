/**
 * The pause menu of a session and what its items do: the saves of spec section
 * 16.4, the restart into another seed, and the settings and the room it shows.
 *
 * `ui/pause.ts` draws the menu and holds no session. This hands it the session:
 * the record it saves and the slots it saves into. It is here rather than in
 * `main.ts` because it is one subject — the save and restart path — and
 * `main.ts` is the boot.
 */
import { randomSeedString, writeSeedToHash } from './core/seed.ts';
import type { PartyActions } from './ui/party.ts';
import { gameTime } from './sim/clock.ts';
import { createSave, saveFromText, saveToText, type SaveFile } from './sim/save.ts';
import type { SimState } from './sim/simulation.ts';
import { PauseMenu } from './ui/pause.ts';
import { setPendingStart, type SaveSlots } from './ui/saves.ts';
import type { MenuSettings } from './ui/settings.ts';

/** What the menu is built over. */
export interface PauseSession {
  seed: string;
  state: SimState;
  slots: SaveSlots;
  /** Load a save of this seed into the live session, and put the frame where it lands. */
  loadInto: (save: SaveFile) => void;
  settings: MenuSettings;
  party: PartyActions;
}

/** Build the pause menu of a session, closed. */
export function buildPauseMenu(session: PauseSession): PauseMenu {
  const { seed, state, slots, loadInto } = session;
  return new PauseMenu(document.body, seed, {
    save: () => {
      slots.write(createSave(seed, state));
      const time = gameTime(state.tick);
      return `Saved · day ${time.day + 1}, ${clockText(time.hour, time.minute)}`;
    },
    canLoad: () => slots.has(seed),
    load: () => {
      const save = slots.read(seed);
      if (!save) throw new Error('No save yet.');
      loadInto(save);
      return 'Loaded.';
    },
    exportText: () => saveToText(createSave(seed, state)),
    importText: (text) => {
      const save = saveFromText(text);
      if (save.state.seed === state.seed) {
        loadInto(save);
        return 'Loaded.';
      }
      // Another seed is another world, and a world is built from a clean page.
      // The save is kept as that seed's save, and the page loads it.
      slots.write(save);
      restart(save.seed, save.state.character, true);
      return 'Opening…';
    },
    settings: session.settings,
    party: session.party,
    regenerate: () => restart(randomSeedString(), state.character, false),
    quit: () => location.reload(),
  });
}

/** `07:05` from an hour and a minute. */
function clockText(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Load the page again straight into a seed (spec section 12): from its save,
 * for an import of another seed's save, or afresh, for Regenerate.
 */
function restart(seed: string, character: SimState['character'], load: boolean): void {
  setPendingStart(sessionStorage, { seed, character, load });
  history.replaceState(null, '', writeSeedToHash(location.hash, seed));
  location.reload();
}
