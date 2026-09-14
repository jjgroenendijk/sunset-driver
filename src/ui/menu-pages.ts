import { nextIndex } from './menu-nav.ts';

/**
 * A menu made of pages, one on screen at a time: the title screen and the
 * pause menu both walk theirs through this.
 *
 * `parent` says where Back goes from each page. The arrow keys walk the
 * elements with `data-nav` on the page on screen, in DOM order, and skip a
 * disabled one. The pointer moves the same focus, so the keyboard and the
 * mouse never show two different highlights.
 */
export class MenuPages<Name extends string> {
  private readonly root: HTMLElement;
  private readonly pages: Record<Name, HTMLElement>;
  private readonly parent: Record<Name, Name | null>;
  private shown: Name;
  /** The item each page was left from, which takes the focus again when the player comes back up. */
  private readonly lastFocus: Partial<Record<Name, HTMLElement>> = {};

  constructor(root: HTMLElement, pages: Record<Name, HTMLElement>, parent: Record<Name, Name | null>, first: Name) {
    this.root = root;
    this.pages = pages;
    this.parent = parent;
    this.shown = first;
    root.addEventListener('pointerover', this.onPointer);
  }

  get current(): Name {
    return this.shown;
  }

  /**
   * Show a page. Going back up puts the focus on the item the player left that
   * page from, as a game menu does; going down starts on the page's own first choice.
   */
  show(name: Name): void {
    const leaving = this.pages[this.shown];
    if (leaving.contains(document.activeElement)) this.lastFocus[this.shown] = document.activeElement as HTMLElement;
    const up = this.parent[this.shown] === name;
    this.shown = name;
    this.root.dataset.page = name;
    for (const key in this.pages) this.pages[key].hidden = key !== name;
    const first = (up ? this.lastFocus[name] : null) ?? this.pages[name].querySelector<HTMLElement>('[data-autofocus]');
    (first ?? this.items()[0])?.focus({ preventScroll: true });
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
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
    // In a text box of several lines the arrows move the caret.
    if (document.activeElement instanceof HTMLTextAreaElement) return false;
    event.preventDefault();
    const items = this.items();
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[nextIndex(at, event.key === 'ArrowDown' ? 1 : -1, items.length)]?.focus();
    return true;
  }

  /** The items of the page on screen the arrow keys walk, in reading order. */
  private items(): HTMLElement[] {
    return [...this.pages[this.shown].querySelectorAll<HTMLElement>('[data-nav]')].filter(
      (el) => el.tabIndex >= 0 && !el.hidden && el.offsetParent !== null && !(el as HTMLButtonElement).disabled,
    );
  }

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
