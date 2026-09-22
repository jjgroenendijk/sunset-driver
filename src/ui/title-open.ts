/**
 * What a page opens on: the seed and the look a session starts with, and
 * whether it took the title screen to choose them.
 *
 * A page loaded by an import of another seed's save, or by Regenerate, goes
 * straight into its seed. Every other page opens on the title screen, on the
 * seed of the address bar, and says so first where the address is an invite
 * link (spec section 21.2, point 2).
 */
import { readSeedFromLocation, seedFromString } from '../core/seed.ts';
import { readRoomFromLocation } from '../net/invite.ts';
import type { WorldSource } from '../render/world-source.ts';
import { DEFAULT_APPEARANCE, type CharacterAppearance } from '../sim/character.ts';
import { SaveSlots, takePendingStart, type SaveSummary } from './saves.ts';
import type { MenuSettings } from './settings.ts';
import { TitleScreen, type TitleChoice } from './title.ts';

export interface TitleNeeds {
  worlds: WorldSource;
  /** The character turning in the scene behind the menu. */
  onPreview: (appearance: CharacterAppearance) => void;
  settings: MenuSettings;
  touch: boolean;
}

/** What the session starts on, and whether it loads the seed's save once the world stands. */
export interface OpeningChoice extends TitleChoice {
  load: boolean;
}

export async function openingChoice(needs: TitleNeeds): Promise<OpeningChoice> {
  const pending = takePendingStart(sessionStorage);
  if (pending) {
    return { seed: pending.seed, character: pending.character, world: null, explore: false, load: pending.load };
  }
  const opening = readSeedFromLocation(location.hash);
  // The seed the menu opens on is built while the player is still choosing a
  // look, so Start usually finds it finished. A player who changes the seed
  // pays for the build then, as they did before.
  needs.worlds.warm(seedFromString(opening));
  const title = new TitleScreen(
    document.body,
    { seed: opening, character: DEFAULT_APPEARANCE, world: null, explore: false },
    needs.worlds,
    needs.onPreview,
    needs.settings,
    needs.touch,
    readRoomFromLocation(location.hash),
    browserSaves(),
  );
  const choice = await title.wait();
  title.destroy();
  return { ...choice, load: choice.load === true };
}

/**
 * The saves of this browser, for the Load game page. A browser that refuses
 * local storage — a private window, a blocked third-party frame — throws on
 * the first read, and the menu is drawn without the page rather than not at
 * all.
 */
function browserSaves(): readonly SaveSummary[] {
  try {
    return new SaveSlots(localStorage).list();
  } catch (error) {
    console.warn('The saves of this browser could not be read.', error);
    return [];
  }
}
