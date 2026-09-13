import { normaliseAppearance, type CharacterAppearance } from '../sim/character.ts';
import type { WorldDescription } from '../world/types.ts';
import { nextIndex } from './menu-nav.ts';
import { buildControlsPage } from './title-controls.ts';
import { page } from './title-parts.ts';
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

type PageName = 'main' | 'setup' | 'controls';

/**
 * The title screen of spec section 12, laid out as a game's main menu. The
 * main page offers New game and Controls. New game is the seed
 * entry, the map of the seed and character creation (`title-setup.ts`), and
 * Controls is the binding list (`title-controls.ts`).
 *
 * The arrow keys walk the items of the page on screen, Enter picks one and
 * Escape goes back to the main page. The pointer moves the same focus, so the
 * keyboard and the mouse never show two different highlights.
 */
export class TitleScreen {
  private readonly root: HTMLElement;
  private readonly setup: NewGamePage;
  private readonly pages: Record<PageName, HTMLElement>;
  private current: PageName = 'main';
  /** The main menu item that was picked last, which takes the focus again when the player comes back. */
  private lastMain: HTMLElement | null = null;
  private resolve: ((choice: TitleChoice) => void) | null = null;

  constructor(parent: HTMLElement, initial: TitleChoice, onPreview: (appearance: CharacterAppearance) => void) {
    const character = normaliseAppearance(initial.character);

    this.root = document.createElement('section');
    this.root.className = 'title';
    this.root.setAttribute('aria-label', 'Main menu');

    this.setup = new NewGamePage(initial.seed, character, onPreview, {
      back: () => this.show('main'),
      start: () => this.finish(),
    });
    this.pages = {
      main: this.buildMain(),
      setup: this.setup.root,
      controls: buildControlsPage(() => this.show('main')),
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

    this.root.append(brand, this.pages.main, this.pages.setup, this.pages.controls, hint);
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
    const nav = document.createElement('nav');
    nav.className = 'title-menu';
    const items: [string, string, string, () => void][] = [
      ['I', 'New game', 'Choose a city and a driver', () => this.show('setup')],
      ['II', 'Controls', 'The keys for the street and the map', () => this.show('controls')],
    ];
    for (const [numeral, label, note, action] of items) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'title-menu-item';
      item.dataset.nav = '';
      item.innerHTML =
        `<span class="title-numeral">${numeral}</span>` +
        `<span class="title-menu-label">${label}</span>` +
        `<span class="title-menu-note">${note}</span>`;
      item.addEventListener('click', action);
      nav.append(item);
    }
    main.append(nav);
    return main;
  }

  private show(name: PageName): void {
    if (this.current === 'main' && this.pages.main.contains(document.activeElement)) {
      this.lastMain = document.activeElement as HTMLElement;
    }
    this.current = name;
    this.root.dataset.page = name;
    for (const key of ['main', 'setup', 'controls'] as const) this.pages[key].hidden = key !== name;
    // Coming back to the main page puts the focus on the item that was left,
    // as a game menu does; anywhere else starts on the page's own first choice.
    const back = name === 'main' ? this.lastMain : null;
    const first = back ?? this.pages[name].querySelector<HTMLElement>('[data-autofocus]');
    (first ?? this.items()[0])?.focus({ preventScroll: true });
  }

  /** The items of the page on screen the arrow keys walk, in reading order. */
  private items(): HTMLElement[] {
    return [...this.pages[this.current].querySelectorAll<HTMLElement>('[data-nav]')].filter(
      (el) => el.tabIndex >= 0 && !el.hidden && el.offsetParent !== null,
    );
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.current !== 'main') {
      event.preventDefault();
      this.show('main');
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
