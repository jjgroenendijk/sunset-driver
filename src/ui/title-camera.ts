import { BUILDING_VIEWS, type BuildingViewChoice } from './settings.ts';
import { backButton, menuList, page } from './title-parts.ts';

const NUMERALS = ['I', 'II', 'III', 'IV'];

/**
 * The Camera column of the title screen and of the pause menu: what happens when
 * a building stands between the camera and the player (spec section 10.7).
 * The chosen item carries `aria-pressed` and takes the focus when the column
 * opens. A pick takes effect at once.
 */
export function buildCameraPage(setting: BuildingViewChoice, back: () => void): HTMLElement {
  const root = page('title-page title-camera');
  const menu = menuList(
    BUILDING_VIEWS.map((choice, i) => ({
      numeral: NUMERALS[i] as string,
      label: choice.label,
      action: () => {
        setting.choose(choice.value);
        mark();
      },
    })),
    'Camera',
  );
  const items = [...menu.querySelectorAll<HTMLButtonElement>('.title-menu-item')];
  const mark = (): void => {
    const view = setting.current();
    items.forEach((item, i) => {
      const chosen = BUILDING_VIEWS[i]?.value === view;
      item.setAttribute('aria-pressed', String(chosen));
      if (chosen) item.dataset.autofocus = '';
      else delete item.dataset.autofocus;
    });
  };
  mark();
  menu.append(backButton(back));
  root.append(menu);
  return root;
}
