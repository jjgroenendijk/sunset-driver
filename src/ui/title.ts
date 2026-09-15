import { normaliseAppearance, type CharacterAppearance } from '../sim/character.ts';
import type { WorldDescription } from '../world/types.ts';
import { MenuPages } from './menu-pages.ts';
import type { BuildingViewChoice } from './settings.ts';
import { buildCameraPage } from './title-camera.ts';
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

const PAGE_NAMES = ['main', 'setup', 'settings', 'controls', 'camera'] as const;
type PageName = (typeof PAGE_NAMES)[number];

/** The page Escape and Back go to from each page. */
const PARENT: Record<PageName, PageName | null> = {
  main: null,
  setup: 'main',
  settings: 'main',
  controls: 'settings',
  camera: 'settings',
};

/**
 * The title screen of spec section 12, laid out as a game's main menu. The
 * main page offers New game, Load game and Settings, and Settings offers
 * Controls and Camera (`title-camera.ts`). Load game stays disabled
 * until it lists the saves the pause menu writes (#273). New game is the seed
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
  private readonly pages: MenuPages<PageName>;
  private resolve: ((choice: TitleChoice) => void) | null = null;

  constructor(
    parent: HTMLElement,
    initial: TitleChoice,
    onPreview: (appearance: CharacterAppearance) => void,
    buildingView: BuildingViewChoice,
  ) {
    const character = normaliseAppearance(initial.character);

    this.root = document.createElement('section');
    this.root.className = 'title';
    this.root.setAttribute('aria-label', 'Main menu');

    this.setup = new NewGamePage(initial.seed, character, onPreview, {
      back: () => this.back(),
      start: () => this.finish(),
    });
    const pages: Record<PageName, HTMLElement> = {
      main: this.buildMain(),
      setup: this.setup.root,
      settings: this.buildSettings(),
      controls: buildControlsPage(() => this.back()),
      camera: buildCameraPage(buildingView, () => this.back()),
    };
    this.pages = new MenuPages(this.root, pages, PARENT, 'main');

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

    this.root.append(brand, ...PAGE_NAMES.map((name) => pages[name]), hint);
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
          note: 'Controls, camera, graphics and sound',
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
        {
          numeral: 'II',
          label: 'Camera',
          note: 'When a building is in the way',
          action: () => this.show('camera'),
        },
        { numeral: 'III', label: 'Graphics', note: 'Comes in a later version', action: null },
        { numeral: 'IV', label: 'Sound', note: 'Comes in a later version', action: null },
      ],
      'Settings',
    );
    menu.append(button('title-back', 'Back', () => this.back()));
    settings.append(menu);
    return settings;
  }

  private show(name: PageName): void {
    this.pages.show(name);
  }

  private back(): void {
    this.pages.back();
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    this.pages.key(event);
  };

  private finish(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(this.setup.choice());
  }
}
