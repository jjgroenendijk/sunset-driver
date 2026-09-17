import { SOUND_CHOICES, type SoundChoice } from './settings.ts';
import { button, menuList, page } from './title-parts.ts';

const NUMERALS = ['I', 'II'];

/**
 * The Sound page of the pause menu: the audio of spec section 15 is on, or the
 * game is muted and synthesises nothing. The chosen item carries `aria-pressed`
 * and takes the focus when the page opens, as the Camera page does. A pick
 * takes effect at once.
 */
export function buildSoundPage(setting: SoundChoice, back: () => void): HTMLElement {
  const root = page('title-page title-sound');
  const menu = menuList(
    SOUND_CHOICES.map((choice, i) => ({
      numeral: NUMERALS[i] as string,
      label: choice.label,
      note: choice.note,
      action: () => {
        setting.mute(choice.muted);
        mark();
      },
    })),
    'Sound',
  );
  const items = [...menu.querySelectorAll<HTMLButtonElement>('.title-menu-item')];
  const mark = (): void => {
    const muted = setting.muted();
    items.forEach((item, i) => {
      const chosen = SOUND_CHOICES[i]?.muted === muted;
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
