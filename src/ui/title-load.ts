import { saveNote, type SaveSummary } from './saves.ts';
import { backButton, menuList, page, type MenuItem } from './title-parts.ts';

/**
 * The Load game column of the title screen (spec section 12): the saves this
 * browser holds, newest first, one row each. The row names the seed, and its
 * note says where the session was — the day, the time of day and the money.
 *
 * The rows carry no numeral, because there may be any number of them and the
 * seed is what the player is choosing between. A browser with no save never
 * opens this page: the main menu leaves Load game disabled.
 */
export function buildLoadPage(saves: readonly SaveSummary[], pick: (save: SaveSummary) => void, back: () => void): HTMLElement {
  const root = page('title-page title-load');
  const items: MenuItem[] = saves.map((save) => ({
    numeral: '',
    label: save.seed,
    note: saveNote(save),
    action: () => pick(save),
  }));
  const menu = menuList(items, 'Load game');
  menu.append(backButton(back));
  root.append(menu);
  return root;
}
