import type { MenuSettings } from './settings.ts';
import { backButton, menuList, page } from './title-parts.ts';

/**
 * The Options column of the title screen and of the pause menu. Camera opens a
 * column of its own beside it; Sound and the minimap's north are checkboxes,
 * and a press takes effect at once.
 */
export function buildSettingsPage(settings: MenuSettings, back: () => void): HTMLElement {
  const root = page('title-page title-settings');
  const menu = menuList(
    [
      { numeral: 'I', label: 'Camera', opens: 'camera' },
      { numeral: 'II', label: 'Sound', toggle: settings.sound },
      { numeral: 'III', label: 'North-up map', toggle: settings.northUp },
    ],
    'Options',
  );
  menu.append(backButton(back));
  root.append(menu);
  return root;
}
