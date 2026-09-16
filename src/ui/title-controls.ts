import { CONTROLS, TOUCH_CONTROLS } from './controls.ts';
import { keyParts } from './menu-nav.ts';
import { button, card, page } from './title-parts.ts';

/**
 * The Controls page of the title screen: every binding of `controls.ts`, drawn
 * as key caps. A touch browser is shown the gestures of the flight instead,
 * because the keys are not there to press.
 */
export function buildControlsPage(back: () => void, touch = false): HTMLElement {
  const root = page('title-page title-keys');
  const sheet = touch
    ? card('I', 'Touch controls', 'Explore the city flies the camera over the world.')
    : card('I', 'Controls', 'The same list is in the README.');

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

  const done = button('title-back', 'Back', back);
  done.dataset.autofocus = '';
  sheet.append(done);
  root.append(sheet);
  return root;
}
