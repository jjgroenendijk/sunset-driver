import type { MenuSettings } from './settings.ts';
import { backButton, menuList, page } from './title-parts.ts';

/**
 * The Options column of the title screen and of the pause menu. View,
 * Buildings and Gore each open a column of their own beside it; Sound and the
 * minimap's north are checkboxes, Frame rate cycles its steps, and a press
 * takes effect at once.
 */
export function buildSettingsPage(settings: MenuSettings, back: () => void): HTMLElement {
  const root = page('title-page title-settings');
  const menu = menuList(
    [
      { numeral: 'I', label: 'View', opens: 'view' },
      { numeral: 'II', label: 'Buildings', opens: 'camera' },
      { numeral: 'III', label: 'Sound', toggle: settings.sound },
      { numeral: 'IV', label: 'North-up map', toggle: settings.northUp },
      { numeral: 'V', label: 'Gore', opens: 'gore' },
      { numeral: 'VI', label: 'Frame rate', cycle: settings.frameRate },
    ],
    'Options',
  );
  menu.append(backButton(back));
  root.append(menu);
  return root;
}
