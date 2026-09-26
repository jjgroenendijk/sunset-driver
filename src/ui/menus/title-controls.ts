import { CONTROLS, TOUCH_CONTROLS } from '../input/controls.ts';
import { keyParts } from './menu-nav.ts';
import { backButton, card, page } from './title-parts.ts';

/**
 * The Controls page of the title screen: every binding of `controls.ts`, drawn
 * as key caps. A touch browser is shown the gestures of the flight instead,
 * because the keys are not there to press.
 */
export function buildControlsPage(back: () => void, touch = false): HTMLElement {
  const root = page('title-page title-keys');
  const sheet = card('', touch ? 'Touch' : 'Controls');

  const list = document.createElement('dl');
  list.className = 'title-key-list';
  for (const binding of touch ? TOUCH_CONTROLS : CONTROLS) {
    const action = document.createElement('dt');
    action.textContent = binding.action;
    const keys = document.createElement('dd');
    for (const part of keyParts(binding.keys)) {
      const el = document.createElement(part.cap ? 'kbd' : 'span');
      el.textContent = part.text;
      keys.append(el);
    }
    list.append(action, keys);
  }
  sheet.append(list);

  sheet.append(backButton(back));
  root.append(sheet);
  return root;
}
