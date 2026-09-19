import { normaliseAppearance, type CharacterAppearance } from '../sim/character.ts';
import type { WorldSource } from '../render/world-source.ts';
import type { WorldDescription } from '../world/types.ts';
import { MenuPages } from './menu-pages.ts';
import type { MenuSettings } from './settings.ts';
import { buildCameraPage, buildGorePage } from './title-camera.ts';
import { buildControlsPage } from './title-controls.ts';
import { columnsOf, menuList, type MenuItem, page } from './title-parts.ts';
import { buildSettingsPage } from './title-settings.ts';
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
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI'];

const PAGE_NAMES = ['main', 'setup', 'settings', 'controls', 'camera', 'gore'] as const;
type PageName = (typeof PAGE_NAMES)[number];

/** The page Escape and Back go to from each page. */
const PARENT: Record<PageName, PageName | null> = {
  main: null,
  setup: 'main',
  settings: 'main',
  controls: 'main',
  camera: 'settings',
  gore: 'settings',
};

/** The pages that open as a column beside their parent. New game takes the whole screen. */
const COLUMNS: ReadonlySet<PageName> = new Set(['settings', 'controls', 'camera', 'gore']);

/**
 * The title screen of spec section 12, laid out as a game's main menu. The
 * main page offers New game, Load game, Controls, Graphics and Options, as the
 * pause menu does. Controls and Options open as a column beside it
 * (`title-settings.ts`), and Camera and Gore as columns beside Options. Load game and
 * Graphics stay disabled until there is something behind them; Load game waits
 * for a list of the saves the pause menu writes (#273). New game is the seed entry, the map of the seed and character creation
 * (`title-setup.ts`), and Controls is the binding list (`title-controls.ts`).
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
  /** The room of the invite link the page was opened on, or null on a plain page. */
  private readonly room: string | null;
  private readonly seed: string;
  private resolve: ((choice: TitleChoice) => void) | null = null;

  constructor(
    parent: HTMLElement,
    initial: TitleChoice,
    worlds: WorldSource,
    onPreview: (appearance: CharacterAppearance) => void,
    settings: MenuSettings,
    touch: boolean,
    room: string | null = null,
  ) {
    this.touch = touch;
    this.room = room;
    this.seed = initial.seed;
    const character = normaliseAppearance(initial.character);

    this.root = document.createElement('section');
    this.root.className = 'title';
    this.root.setAttribute('aria-label', 'Main menu');

    this.setup = new NewGamePage(initial.seed, character, worlds, onPreview, {
      back: () => this.back(),
      start: () => this.finish(),
      joining: room !== null,
    });
    const pages: Record<PageName, HTMLElement> = {
      main: this.buildMain(),
      setup: this.setup.root,
      settings: buildSettingsPage(settings, () => this.back()),
      controls: buildControlsPage(() => this.back(), touch),
      camera: buildCameraPage(settings.buildingView, () => this.back()),
      gore: buildGorePage(settings.gore, () => this.back()),
    };
    this.pages = new MenuPages(this.root, pages, PARENT, 'main', COLUMNS);

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

    this.root.append(brand, columnsOf(PAGE_NAMES.map((name) => pages[name])), hint);
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
            label: 'Explore',
            action: () => this.finish(true),
          },
        ]
      : [];
    const numeral = (at: number): string => NUMERALS[at + explore.length] ?? '';
    const first: MenuItem =
      this.room === null
        ? { numeral: numeral(0), label: 'New game', action: () => this.show('setup') }
        : { numeral: numeral(0), label: 'Join game', action: () => this.show('setup') };
    if (this.room !== null) main.append(inviteBanner(this.room, this.seed));
    main.append(
      menuList([
        ...explore,
        first,
        { numeral: numeral(1), label: 'Load game' },
        { numeral: numeral(2), label: 'Controls', opens: 'controls' },
        { numeral: numeral(3), label: 'Graphics' },
        { numeral: numeral(4), label: 'Options', opens: 'settings' },
      ]),
    );
    return main;
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

/**
 * What a page opened on an invite link says first: this is somebody else's
 * game, in their city, and pressing on joins it (spec section 21.2, point 2).
 */
function inviteBanner(room: string, seed: string): HTMLElement {
  const banner = document.createElement('section');
  banner.className = 'title-invite';
  banner.setAttribute('role', 'status');
  const eyebrow = document.createElement('span');
  eyebrow.className = 'title-eyebrow';
  eyebrow.textContent = 'You were invited';
  const heading = document.createElement('h2');
  heading.textContent = `Join room ${room}`;
  const city = document.createElement('p');
  city.textContent = `Seed ${seed}`;
  banner.append(eyebrow, heading, city);
  return banner;
}
