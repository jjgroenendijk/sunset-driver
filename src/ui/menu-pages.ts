import { nextIndex } from './menu-nav.ts';
import { CYCLE_EVENT } from './title-parts.ts';

/**
 * A menu made of pages: the title screen and the pause menu both walk theirs
 * through this.
 *
 * `parent` says where Back goes from each page. A page named in `columns` opens
 * as a column beside its parent, which stays on screen, so a submenu reads as
 * an accordion laid on its side. Any other page is shown alone.
 *
 * An item with `data-opens` opens that page, and a second press closes it
 * again. Its `aria-expanded` says whether the page is open. The right arrow
 * opens it too, and the left arrow closes the column the focus is in. On an item
 * with `data-cycle` the two side arrows move its setting instead.
 *
 * The up and down arrows walk the elements with `data-nav` in the column that
 * holds the focus, in DOM order, and skip a disabled one. The pointer moves the
 * same focus, so the keyboard and the mouse never show two different highlights.
 */
export class MenuPages<Name extends string> {
  private readonly root: HTMLElement;
  private readonly pages: Record<Name, HTMLElement>;
  private readonly parent: Record<Name, Name | null>;
  private readonly columns: ReadonlySet<Name>;
  private shown: Name;
  /** Called with a page each time it opens, rather than being come back up to. */
  onOpen: ((name: Name) => void) | null = null;
  /** The item each page was left from, which takes the focus again when the player comes back up. */
  private readonly lastFocus: Partial<Record<Name, HTMLElement>> = {};

  constructor(
    root: HTMLElement,
    pages: Record<Name, HTMLElement>,
    parent: Record<Name, Name | null>,
    first: Name,
    columns: ReadonlySet<Name> = new Set(),
  ) {
    this.root = root;
    this.pages = pages;
    this.parent = parent;
    this.columns = columns;
    this.shown = first;
    root.addEventListener('pointerover', this.onPointer);
    root.addEventListener('click', this.onClick);
  }

  get current(): Name {
    return this.shown;
  }

  /**
   * Show a page, with the parents it opens beside. Going back up puts the focus
   * on the item the player left that page from, as a game menu does; going down
   * starts on the page's own first choice.
   */
  show(name: Name): void {
    const leaving = this.pages[this.shown];
    if (leaving.contains(document.activeElement)) this.lastFocus[this.shown] = document.activeElement as HTMLElement;
    let up = false;
    for (let at = this.parent[this.shown]; at !== null && !up; at = this.parent[at]) up = at === name;
    this.shown = name;
    this.root.dataset.page = name;
    const open = this.chain(name);
    for (const key in this.pages) {
      const page = this.pages[key];
      page.hidden = !open.includes(key);
      if (key !== name && open.includes(key)) page.dataset.behind = '';
      else delete page.dataset.behind;
      if (this.columns.has(key)) page.dataset.column = '';
    }
    for (const item of this.root.querySelectorAll<HTMLElement>('[data-opens]')) {
      item.setAttribute('aria-expanded', String(open.includes(item.dataset.opens as Name)));
    }
    if (!up) this.onOpen?.(name);
    const first = (up ? this.lastFocus[name] : null) ?? this.pages[name].querySelector<HTMLElement>('[data-autofocus]');
    (first ?? this.items(this.pages[name])[0])?.focus({ preventScroll: true });
  }

  /** Open a page, or close it where it is already open, and put the focus back on its opener. */
  toggle(name: Name): void {
    if (!this.chain(this.shown).includes(name)) {
      this.show(name);
      return;
    }
    const parent = this.parent[name];
    if (parent === null) return;
    const opener = this.pages[parent].querySelector<HTMLElement>(`[data-opens="${name}"]`);
    if (opener) this.lastFocus[parent] = opener;
    this.show(parent);
  }

  /** Go to the page above the one on screen, and answer false where there is none. */
  back(): boolean {
    const parent = this.parent[this.shown];
    if (parent) this.show(parent);
    return parent !== null;
  }

  /** Handle Escape and the arrow keys, and answer whether the key was used. */
  key(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      if (!this.back()) return false;
      event.preventDefault();
      return true;
    }
    const active = document.activeElement as HTMLElement | null;
    // In a text box the arrows move the caret.
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return false;
    const side = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (side !== 0 && active?.dataset.cycle !== undefined) {
      event.preventDefault();
      active.dispatchEvent(new CustomEvent(CYCLE_EVENT, { detail: side }));
      return true;
    }
    if (event.key === 'ArrowRight' && active?.dataset.opens) {
      event.preventDefault();
      const name = active.dataset.opens as Name;
      if (!this.chain(this.shown).includes(name)) this.show(name);
      else this.items(this.pages[name])[0]?.focus();
      return true;
    }
    if (event.key === 'ArrowLeft') {
      const page = this.pageOf(active);
      if (page === null || !this.columns.has(page)) return false;
      event.preventDefault();
      this.toggle(page);
      return true;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
    event.preventDefault();
    const items = this.items(this.pages[this.pageOf(active) ?? this.shown]);
    const at = items.indexOf(active as HTMLElement);
    items[nextIndex(at, event.key === 'ArrowDown' ? 1 : -1, items.length)]?.focus();
    return true;
  }

  /** The page and the parents it opens beside, deepest first. */
  private chain(name: Name): Name[] {
    const out = [name];
    let at = name;
    while (this.columns.has(at)) {
      const parent = this.parent[at];
      if (parent === null) break;
      out.push(parent);
      at = parent;
    }
    return out;
  }

  /** The open page an element stands in, or null. */
  private pageOf(el: Element | null): Name | null {
    for (const name of this.chain(this.shown)) if (el && this.pages[name].contains(el)) return name;
    return null;
  }

  /** The items of a page the arrow keys walk, in reading order. */
  private items(page: HTMLElement): HTMLElement[] {
    return [...page.querySelectorAll<HTMLElement>('[data-nav]')].filter(
      (el) => el.tabIndex >= 0 && !el.hidden && el.offsetParent !== null && !(el as HTMLButtonElement).disabled,
    );
  }

  private readonly onClick = (event: MouseEvent): void => {
    const item = (event.target as Element).closest<HTMLElement>('[data-opens]');
    if (item && !(item as HTMLButtonElement).disabled) this.toggle(item.dataset.opens as Name);
  };

  /** The pointer takes the focus with it, so there is only ever one highlight. */
  private readonly onPointer = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') return;
    const item = (event.target as Element).closest<HTMLElement>('[data-nav]');
    // A text box is left alone: moving over it must not take the caret from where the player types.
    if (!item || item instanceof HTMLInputElement || item instanceof HTMLTextAreaElement) return;
    if (item === document.activeElement) return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    item.focus({ preventScroll: true });
  };
}
