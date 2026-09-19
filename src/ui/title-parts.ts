/** The pieces every page of the title screen and the pause menu is built from. */
import type { CycleChoice, ToggleChoice } from './settings.ts';

/** A page of the title screen, hidden until it is shown. */
export function page(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.hidden = true;
  return el;
}

/**
 * A card with a heading, in the manner of a printed programme: a roman numeral
 * before it and a line under it where there is one. A column's card has no numeral,
 * as a column's menu has none.
 */
export function card(numeral: string, heading: string, note = ''): HTMLElement {
  const el = document.createElement('section');
  el.className = 'title-card';
  const head = document.createElement('header');
  head.className = 'title-card-head';
  const number = document.createElement('span');
  number.className = 'title-numeral';
  number.textContent = numeral;
  const h2 = document.createElement('h2');
  h2.textContent = heading;
  if (numeral) head.append(number);
  head.append(h2);
  if (note) {
    const p = document.createElement('p');
    p.textContent = note;
    head.append(p);
  }
  el.append(head);
  return el;
}

/** A button that the arrow keys can reach. */
export function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = text;
  el.dataset.nav = '';
  el.addEventListener('click', onClick);
  return el;
}

/**
 * One item of a menu list. An item that `opens` a page is handed to `MenuPages`,
 * which opens that page as a column beside the list and closes it on a second
 * press. An item with a `toggle` is a checkbox. An item with a `cycle` names
 * its step at the end of the row; a press moves it on, and the side arrows move
 * it either way. An item with none of these is drawn and skipped: what it opens
 * does not exist yet.
 */
export interface MenuItem {
  numeral: string;
  label: string;
  note?: string;
  action?: (() => void) | null;
  opens?: string;
  toggle?: ToggleChoice;
  cycle?: CycleChoice;
}

/** The event `MenuPages` sends a cycle item on a side arrow, with the step as its detail. */
export const CYCLE_EVENT = 'menu-cycle';

/** A menu card: a roman numeral and a label per item, a note where there is one, and a heading where there is one. */
export function menuList(items: readonly MenuItem[], heading?: string): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'title-menu';
  if (heading) {
    const h2 = document.createElement('h2');
    h2.className = 'title-menu-heading';
    h2.textContent = heading;
    nav.append(h2);
  }
  // What each checkbox and cycle shows is redrawn after any press on the list,
  // and whenever the list takes the focus, because one setting can move
  // another: a Graphics preset sets every knob, and a knob turns Auto off.
  const marks: (() => void)[] = [];
  const markAll = (): void => marks.forEach((mark) => mark());
  nav.addEventListener('focusin', markAll);
  for (const entry of items) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'title-menu-item';
    item.dataset.nav = '';
    const numeral = document.createElement('span');
    numeral.className = 'title-numeral';
    numeral.textContent = entry.numeral;
    const label = document.createElement('span');
    label.className = 'title-menu-label';
    label.textContent = entry.label;
    item.append(numeral, label);
    if (entry.note) {
      const note = document.createElement('span');
      note.className = 'title-menu-note';
      note.textContent = entry.note;
      item.append(note);
    }
    if (entry.toggle) {
      const toggle = entry.toggle;
      item.setAttribute('role', 'switch');
      marks.push(() => item.setAttribute('aria-checked', String(toggle.on())));
      item.addEventListener('click', () => {
        toggle.set(!toggle.on());
        markAll();
      });
    } else if (entry.cycle) {
      const cycle = entry.cycle;
      item.dataset.cycle = '';
      const value = document.createElement('span');
      value.className = 'title-menu-value';
      item.append(value);
      marks.push(() => (value.textContent = cycle.label()));
      const move = (by: 1 | -1): void => {
        cycle.move(by);
        markAll();
      };
      item.addEventListener('click', () => move(1));
      item.addEventListener(CYCLE_EVENT, (event) => move((event as CustomEvent<1 | -1>).detail));
    } else if (entry.opens) {
      item.dataset.opens = entry.opens;
      item.setAttribute('aria-expanded', 'false');
    } else if (entry.action) item.addEventListener('click', entry.action);
    else item.disabled = true;
    nav.append(item);
  }
  markAll();
  return nav;
}

/**
 * The Back button of a column. A wide screen hides it, because the column's
 * opener closes it and Escape does too; a narrow screen shows one column at a
 * time and needs it.
 */
export function backButton(back: () => void): HTMLButtonElement {
  return button('title-back menu-back', 'Back', back);
}

/** The row the pages of a menu stand in, so a column opens beside the page it came from. */
export function columnsOf(pages: readonly HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'menu-columns';
  row.append(...pages);
  return row;
}
