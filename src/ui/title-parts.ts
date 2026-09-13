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
