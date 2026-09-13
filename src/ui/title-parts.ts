/** The pieces every page of the title screen is built from. */

/** A page of the title screen, hidden until it is shown. */
export function page(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.hidden = true;
  return el;
}

/** A card with a roman numeral, a heading and a line under it, in the manner of a printed programme. */
export function card(numeral: string, heading: string, note: string): HTMLElement {
  const el = document.createElement('section');
  el.className = 'title-card';
  const head = document.createElement('header');
  head.className = 'title-card-head';
  const number = document.createElement('span');
  number.className = 'title-numeral';
  number.textContent = numeral;
  const h2 = document.createElement('h2');
  h2.textContent = heading;
  const p = document.createElement('p');
  p.textContent = note;
  head.append(number, h2, p);
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

/** One item of a menu list. An item with no action is drawn and skipped: what it opens does not exist yet. */
export interface MenuItem {
  numeral: string;
  label: string;
  note: string;
  action: (() => void) | null;
}

/** A menu card: a roman numeral, a label and a note per item, and a heading where there is one. */
export function menuList(items: readonly MenuItem[], heading?: string): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'title-menu';
  if (heading) {
    const h2 = document.createElement('h2');
    h2.className = 'title-menu-heading';
    h2.textContent = heading;
    nav.append(h2);
  }
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
    const note = document.createElement('span');
    note.className = 'title-menu-note';
    note.textContent = entry.note;
    item.append(numeral, label, note);
    if (entry.action) item.addEventListener('click', entry.action);
    else item.disabled = true;
    nav.append(item);
  }
  return nav;
}
