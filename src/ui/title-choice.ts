/**
 * A settings page that is one choice from a short list: the Camera page
 * (`title-camera.ts`) and the Sound page (`title-sound.ts`) are both this.
 *
 * The chosen item carries `aria-pressed` and takes the focus when the page
 * opens. A pick takes effect at once, because a settings page with an Apply
 * button is a settings page nobody reads.
 */
import type { SettingChoice } from './settings.ts';
import { button, menuList, page } from './title-parts.ts';

const NUMERALS = ['I', 'II', 'III', 'IV', 'V'];

/** One option, as a page lists it. */
export interface PageChoice<T> {
  value: T;
  label: string;
  note: string;
}

export function buildChoicePage<T>(
  className: string,
  heading: string,
  choices: readonly PageChoice<T>[],
  setting: SettingChoice<T>,
  back: () => void,
): HTMLElement {
  const root = page(`title-page ${className}`);
  const menu = menuList(
    choices.map((choice, i) => ({
      numeral: NUMERALS[i] as string,
      label: choice.label,
      note: choice.note,
      action: () => {
        setting.choose(choice.value);
        mark();
      },
    })),
    heading,
  );
  const items = [...menu.querySelectorAll<HTMLButtonElement>('.title-menu-item')];
  const mark = (): void => {
    const held = setting.current();
    items.forEach((item, i) => {
      const chosen = choices[i]?.value === held;
      item.setAttribute('aria-pressed', String(chosen));
      if (chosen) item.dataset.autofocus = '';
      else delete item.dataset.autofocus;
    });
  };
  mark();
  menu.append(button('title-back', 'Back', back));
  root.append(menu);
  return root;
}
