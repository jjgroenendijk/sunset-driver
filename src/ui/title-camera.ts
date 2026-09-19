import { GORE_LEVELS, type Gore } from '../render/gore.ts';
import { BUILDING_VIEWS, type BuildingViewChoice, type Choice } from './settings.ts';
import { backButton, menuList, page } from './title-parts.ts';

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI'];

/**
 * A column of the title screen and of the pause menu that picks one choice of
 * several. The chosen item carries `aria-pressed` and takes the focus when the
 * column opens. A pick takes effect at once.
 */
function buildChoicePage<T>(
  name: string,
  heading: string,
  choices: readonly { value: T; label: string }[],
  setting: Choice<T>,
  back: () => void,
): HTMLElement {
  const root = page(`title-page ${name}`);
  const menu = menuList(
    choices.map((choice, i) => ({
      numeral: NUMERALS[i] as string,
      label: choice.label,
      action: () => {
        setting.choose(choice.value);
        mark();
      },
    })),
    heading,
  );
  const items = [...menu.querySelectorAll<HTMLButtonElement>('.title-menu-item')];
  const mark = (): void => {
    const current = setting.current();
    items.forEach((item, i) => {
      const chosen = choices[i]?.value === current;
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

/** The Camera column: what happens when a building stands between the camera and the player (spec section 10.7). */
export function buildCameraPage(setting: BuildingViewChoice, back: () => void): HTMLElement {
  return buildChoicePage('title-camera', 'Camera', BUILDING_VIEWS, setting, back);
}

/** The Gore column: how much blood is drawn. It changes the picture only, never the record. */
export function buildGorePage(setting: Choice<Gore>, back: () => void): HTMLElement {
  return buildChoicePage('title-gore', 'Gore', GORE_LEVELS, setting, back);
}
