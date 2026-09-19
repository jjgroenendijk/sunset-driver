import { normaliseAppearance, type CharacterAppearance } from '../sim/character.ts';
import type { WorldSource } from '../render/world-source.ts';
import type { WorldDescription } from '../world/types.ts';
import { MenuPages } from './menu-pages.ts';
import type { BuildingViewChoice, SoundChoice } from './settings.ts';
import { buildCameraPage } from './title-camera.ts';
import { buildSoundPage } from './title-sound.ts';
import { buildControlsPage } from './title-controls.ts';
import { button, menuList, type MenuItem, page } from './title-parts.ts';
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
  /**
   * True where the player asked to look at the city rather than to play in it:
   * the session opens on the free camera, high over the streets. It is what a
   * phone is offered (`docs/menus.md`), because a phone reaches none of the
   * keys the game is driven with.
   */
  explore: boolean;
  /** The starting money the money code set on the seed box, if it was typed. */
  money?: number;
}

/** The numerals the main page counts its items with, however many it has. */
const NUMERALS = ['I', 'II', 'III', 'IV'];

const PAGE_NAMES = ['main', 'setup', 'settings', 'controls', 'camera', 'sound'] as const;
type PageName = (typeof PAGE_NAMES)[number];

/** The page Escape and Back go to from each page. */
const PARENT: Record<PageName, PageName | null> = {
  main: null,
  setup: 'main',
  settings: 'main',
  controls: 'settings',
  camera: 'settings',
  sound: 'settings',
};

/**
 * The title screen of spec section 12, laid out as a game's main menu. The
 * main page offers New game, Load game and Settings, and Settings offers
 * Controls, Camera (`title-camera.ts`) and Sound (`title-sound.ts`). Load game
 * stays disabled
 * until it lists the saves the pause menu writes (#273). New game is the seed
 * entry, the map of the seed and character creation (`title-setup.ts`), and
 * Controls is the binding list (`title-controls.ts`).
 *
 * The arrow keys walk the items of the page on screen, Enter picks one and
 * Escape goes back up one page. The pointer moves the same focus, so the
 * keyboard and the mouse never show two different highlights.
 *
 * A touch browser is given one item more, at the top of the main page: Explore
 * the city, which starts the seed the menu opened on straight into the free
 * camera. It is put first because it is the only thing on the list a phone can
 * actually do.
 */
export class TitleScreen {
  private readonly root: HTMLElement;
  private readonly setup: NewGamePage;
  private readonly pages: MenuPages<PageName>;
  private readonly touch: boolean;
  private resolve: ((choice: TitleChoice) => void) | null = null;

  constructor(
    parent: HTMLElement,
    initial: TitleChoice,
    worlds: WorldSource,
    onPreview: (appearance: CharacterAppearance) => void,
    buildingView: BuildingViewChoice,
    touch: boolean,
    sound: SoundChoice,
  ) {
    this.touch = touch;
    const character = normaliseAppearance(initial.character);

    this.root = document.createElement('section');
    this.root.className = 'title';
    this.root.setAttribute('aria-label', 'Main menu');

    this.setup = new NewGamePage(initial.seed, character, worlds, onPreview, {
      back: () => this.back(),
      start: () => this.finish(),
    });
    const pages: Record<PageName, HTMLElement> = {
      main: this.buildMain(),
      setup: this.setup.root,
      settings: this.buildSettings(),
      controls: buildControlsPage(() => this.back(), touch),
      camera: buildCameraPage(buildingView, () => this.back()),
      sound: buildSoundPage(sound, () => this.back()),
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
    const explore: MenuItem[] = this.touch
      ? [
          {
            numeral: 'I',
            label: 'Explore the city',
            note: 'Fly over the world with two thumbs',
            action: () => this.finish(true),
          },
        ]
      : [];
    const numeral = (at: number): string => NUMERALS[at + explore.length] ?? '';
    main.append(
      menuList([
        ...explore,
        { numeral: numeral(0), label: 'New game', note: 'Choose a city and a driver', action: () => this.show('setup') },
        { numeral: numeral(1), label: 'Load game', note: 'Saves come in a later version', action: null },
        {
          numeral: numeral(2),
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
        {
          numeral: 'IV',
          label: 'Sound',
          note: 'The engine, the street and the mute',
          action: () => this.show('sound'),
        },
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

  /**
   * Hand the session over. Explore takes the seed the New game page holds
   * without the player having opened it, which is the seed the URL or the roll
   * left there and the one the menu has already been building in the worker.
   */
  private finish(explore = false): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.({ ...this.setup.choice(), explore });
  }
}
