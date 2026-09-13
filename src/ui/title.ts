import { normaliseAppearance, type CharacterAppearance } from '../sim/character.ts';
import type { WorldDescription } from '../world/types.ts';
import { nextIndex } from './menu-nav.ts';
import { buildControlsPage } from './title-controls.ts';
import { button, menuList, page } from './title-parts.ts';
import { NewGamePage } from './title-setup.ts';

/** What the player settled on before the session starts. */
export interface TitleChoice {
  seed: string;
  character: CharacterAppearance;
  /**
   * The world the preview built for `seed`, or null where the player never
   * asked for one. The session reuses it rather than generating the same seed
   * a second time.
   */
  world: WorldDescription | null;
}

const PAGE_NAMES = ['main', 'setup', 'settings', 'controls'] as const;
type PageName = (typeof PAGE_NAMES)[number];

/** The page Escape and Back go to from each page. */
const PARENT: Record<PageName, PageName | null> = {
  main: null,
  setup: 'main',
  settings: 'main',
  controls: 'settings',
};

/**
 * The title screen of spec section 12, laid out as a game's main menu. The
 * main page offers New game, Load game and Controls. Load game stays disabled
 * until the saves of spec section 12 exist. New game is the seed
 * entry, the map of the seed and character creation (`title-setup.ts`), and
 * Controls is the binding list (`title-controls.ts`).
 *
 * The arrow keys walk the items of the page on screen, Enter picks one and
 * Escape goes back up one page. The pointer moves the same focus, so the
 * keyboard and the mouse never show two different highlights.
 */
export class TitleScreen {
  private readonly root: HTMLElement;
  private readonly setup: NewGamePage;
  private readonly pages: Record<PageName, HTMLElement>;
  private current: PageName = 'main';
  /** The item each page was left from, which takes the focus again when the player comes back up. */
  private readonly lastFocus: Partial<Record<PageName, HTMLElement>> = {};
  private resolve: ((choice: TitleChoice) => void) | null = null;

  constructor(parent: HTMLElement, initial: TitleChoice, onPreview: (appearance: CharacterAppearance) => void) {
    const character = normaliseAppearance(initial.character);

    this.root = document.createElement('section');
    this.root.className = 'title';
    this.root.setAttribute('aria-label', 'Main menu');

    this.setup = new NewGamePage(initial.seed, character, onPreview, {
      back: () => this.back(),
      start: () => this.finish(),
    });
    this.pages = {
      main: this.buildMain(),
      setup: this.setup.root,
      settings: this.buildSettings(),
      controls: buildControlsPage(() => this.back()),
    };

    const brand = document.createElement('header');
    brand.className = 'title-brand';
    brand.innerHTML =
      '<span class="title-eyebrow">A city built from a seed</span>' +
      '<h1><span>Sunset</span> <em>Driver</em></h1>' +
      '<span class="title-rule" aria-hidden="true"></span>';

    const hint = document.createElement('footer');
    hint.className = 'title-hint';
    hint.innerHTML =
      '<span><kbd>↑</kbd><kbd>↓</kbd> Choose</span><span><kbd>Enter</kbd> Confirm</span>' +
      '<span><kbd>Esc</kbd> Back</span>';

    this.root.append(brand, ...PAGE_NAMES.map((name) => this.pages[name]), hint);
    this.root.addEventListener('pointerover', this.onPointer);
    window.addEventListener('keydown', this.onKey);
    parent.append(this.root);

    onPreview(character);
    this.show('main');
  }

  /** Resolves once the player starts a session. */
  wait(): Promise<TitleChoice> {
    return new Promise<TitleChoice>((resolve) => {
      this.resolve = resolve;
    });
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }

  private buildMain(): HTMLElement {
    const main = page('title-page title-main');
    main.append(
      menuList([
        { numeral: 'I', label: 'New game', note: 'Choose a city and a driver', action: () => this.show('setup') },
        { numeral: 'II', label: 'Load game', note: 'Saves come in a later version', action: null },
        {
          numeral: 'III',
          label: 'Settings',
          note: 'Controls, graphics and sound',
          action: () => this.show('settings'),
        },
      ]),
    );
    return main;
  }

  private buildSettings(): HTMLElement {
    const settings = page('title-page title-settings');
    const menu = menuList(
      [
        {
          numeral: 'I',
          label: 'Controls',
          note: 'The keys for the street and the map',
          action: () => this.show('controls'),
        },
        { numeral: 'II', label: 'Graphics', note: 'Comes in a later version', action: null },
        { numeral: 'III', label: 'Sound', note: 'Comes in a later version', action: null },
      ],
      'Settings',
    );
    menu.append(button('title-back', 'Back', () => this.back()));
    settings.append(menu);
    return settings;
  }

  /**
   * Show a page. Going back up puts the focus on the item the player left that
   * page from, as a game menu does; going down starts on the page's own first choice.
   */
  private show(name: PageName): void {
    const leaving = this.pages[this.current];
    if (leaving.contains(document.activeElement)) this.lastFocus[this.current] = document.activeElement as HTMLElement;
    const up = PARENT[this.current] === name;
    this.current = name;
    this.root.dataset.page = name;
    for (const key of PAGE_NAMES) this.pages[key].hidden = key !== name;
    const first = (up ? this.lastFocus[name] : null) ?? this.pages[name].querySelector<HTMLElement>('[data-autofocus]');
    (first ?? this.items()[0])?.focus({ preventScroll: true });
  }

  /** Go to the page above the one on screen, where there is one. */
  private back(): void {
    const parent = PARENT[this.current];
    if (parent) this.show(parent);
  }

  /** The items of the page on screen the arrow keys walk, in reading order. */
  private items(): HTMLElement[] {
    return [...this.pages[this.current].querySelectorAll<HTMLElement>('[data-nav]')].filter(
      (el) => el.tabIndex >= 0 && !el.hidden && el.offsetParent !== null && !(el as HTMLButtonElement).disabled,
    );
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && PARENT[this.current]) {
      event.preventDefault();
      this.back();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = this.items();
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[nextIndex(at, event.key === 'ArrowDown' ? 1 : -1, items.length)]?.focus();
  };

  /** The pointer takes the focus with it, so there is only ever one highlight. */
  private readonly onPointer = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') return;
    const item = (event.target as Element).closest<HTMLElement>('[data-nav]');
    // A text box is left alone: moving over it must not take the caret from where the player types.
    if (!item || item instanceof HTMLInputElement || item === document.activeElement) return;
    if (document.activeElement instanceof HTMLInputElement) return;
    item.focus({ preventScroll: true });
  };

  private finish(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(this.setup.choice());
  }
}
