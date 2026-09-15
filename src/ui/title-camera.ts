import { BUILDING_VIEWS, type BuildingViewChoice } from './settings.ts';
import { button, menuList, page } from './title-parts.ts';

const NUMERALS = ['I', 'II', 'III', 'IV'];

/**
 * The Camera page of the title screen and of the pause menu: what happens when
 * a building stands between the camera and the player (spec section 10.7).
 * The chosen item carries `aria-pressed` and takes the focus when the page
 * opens. A pick takes effect at once.
 */
export function buildCameraPage(setting: BuildingViewChoice, back: () => void): HTMLElement {
  const root = page('title-page title-camera');
  const menu = menuList(
    BUILDING_VIEWS.map((choice, i) => ({
      numeral: NUMERALS[i] as string,
      label: choice.label,
      note: choice.note,
      action: () => {
        setting.choose(choice.value);
        mark();
      },
    })),
    'When a building is in the way',
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
  const done = button('title-back', 'Back', back);
  menu.append(done);
  root.append(menu);
  return root;
}
