/**
 * The pause menu of spec section 12: resume, save, load, export and import of a
 * save, the controls, the camera and sound settings, the seed and a copy of it,
 * regenerate, quit, and the button multiplayer will hang off.
 *
 * It is drawn in the look of the title screen and walked the same way, through
 * `MenuPages`. It holds no session: every item calls an action `main.ts` hands
 * it, and a thrown error is shown as the menu's status line. It listens to no
 * key itself, because Escape both opens it and closes it, and `main.ts` is what
 * decides which one a press means.
 */
import type { BuildingViewChoice, SoundChoice } from './settings.ts';
import { buildCameraPage } from './title-camera.ts';
import { buildSoundPage } from './title-sound.ts';
import { buildControlsPage } from './title-controls.ts';
import { MenuPages } from './menu-pages.ts';
import { button, card, menuList, page } from './title-parts.ts';

/** The key that opens and closes the pause menu. Listed in `controls.ts`. */
export const PAUSE_KEY = 'Escape';

export interface PauseActions {
  /** Keep the session in the browser. Answers what the status line says. */
  save(): string;
  /** Whether the seed has a save to load. */
  canLoad(): boolean;
  /** Load the seed's save into the session. Answers what the status line says. */
  load(): string;
  /** The session as clipboard text. */
  exportText(): string;
  /** Load a save from clipboard text. Answers what the status line says. */
  importText(text: string): string;
  /** Start again on a new seed with the same look. */
  regenerate(): void;
  /** Leave the session for the title screen. */
  quit(): void;
  /** What happens when a building is in the way (spec section 10.7). A choice takes effect at once. */
  buildingView: BuildingViewChoice;
  /** How loud the game is (spec section 15). A choice takes effect at once. */
  sound: SoundChoice;
}

const PAGE_NAMES = ['main', 'transfer', 'controls', 'camera', 'sound'] as const;
type PageName = (typeof PAGE_NAMES)[number];

const PARENT: Record<PageName, PageName | null> = {
  main: null,
  transfer: 'main',
  controls: 'main',
  camera: 'main',
  sound: 'main',
};

export class PauseMenu {
  private readonly root: HTMLElement;
  private readonly pages: MenuPages<PageName>;
  private readonly actions: PauseActions;
  private readonly seed: string;
  private readonly loadItem: HTMLButtonElement;
  private readonly text: HTMLTextAreaElement;
  /** One status line per page that has one; both say the same thing. */
  private readonly statuses: HTMLElement[] = [];
  private isOpen = false;

  constructor(parent: HTMLElement, seed: string, actions: PauseActions) {
    this.seed = seed;
    this.actions = actions;
    this.root = document.createElement('section');
    this.root.className = 'title pause';
    this.root.setAttribute('aria-label', 'Pause menu');
    this.root.hidden = true;

    this.text = document.createElement('textarea');
    const main = this.buildMain();
    this.loadItem = main.querySelectorAll<HTMLButtonElement>('.title-menu-item')[2] as HTMLButtonElement;
    const pages: Record<PageName, HTMLElement> = {
      main,
      transfer: this.buildTransfer(),
      controls: buildControlsPage(() => this.pages.back()),
      camera: buildCameraPage(actions.buildingView, () => this.pages.back()),
      sound: buildSoundPage(actions.sound, () => this.pages.back()),
    };
    this.pages = new MenuPages(this.root, pages, PARENT, 'main');

    const brand = document.createElement('header');
    brand.className = 'title-brand';
    brand.innerHTML = '<span class="title-eyebrow">The city waits</span><h1><em>Paused</em></h1>';
    const hint = document.createElement('footer');
    hint.className = 'title-hint';
    hint.innerHTML =
      '<span><kbd>↑</kbd><kbd>↓</kbd> Choose</span><span><kbd>Enter</kbd> Confirm</span>' +
      '<span><kbd>Esc</kbd> Back</span>';
    this.root.append(brand, ...PAGE_NAMES.map((name) => pages[name]), hint);
    parent.append(this.root);
  }

  get open(): boolean {
    return this.isOpen;
  }

  show(): void {
    this.isOpen = true;
    this.root.hidden = false;
    this.say('');
    this.loadItem.disabled = !this.actions.canLoad();
    this.pages.show('main');
  }

  hide(): void {
    this.isOpen = false;
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur();
  }

  /** A key pressed while the menu is open. Escape on the main page resumes. */
  key(event: KeyboardEvent): void {
    if (this.pages.key(event)) return;
    if (event.code === PAUSE_KEY) {
      event.preventDefault();
      this.hide();
    }
  }

  private buildMain(): HTMLElement {
    const main = page('title-page pause-main');
    const menu = menuList([
      { numeral: 'I', label: 'Resume', note: 'Back to the street', action: () => this.hide() },
      { numeral: 'II', label: 'Save game', note: 'One save per seed, in this browser', action: () => this.run(() => this.actions.save()) },
      { numeral: 'III', label: 'Load game', note: 'The last save of this seed', action: () => this.run(() => this.resumeWith(this.actions.load())) },
      { numeral: 'IV', label: 'Export save', note: 'As text for the clipboard', action: () => this.exportSave() },
      { numeral: 'V', label: 'Import save', note: 'From text of a save', action: () => this.importPage() },
      { numeral: 'VI', label: 'Controls', note: 'The keys for the street and the map', action: () => this.pages.show('controls') },
      { numeral: 'VII', label: 'Camera', note: 'When a building is in the way', action: () => this.pages.show('camera') },
      { numeral: 'VIII', label: 'Sound', note: 'How loud the city is', action: () => this.pages.show('sound') },
      { numeral: 'IX', label: 'Open game to others', note: 'Multiplayer comes in a later version', action: null },
      { numeral: 'X', label: 'Quit to title', note: 'Progress since the last save is lost', action: () => this.actions.quit() },
    ]);

    const city = card('I', 'The city', 'Share the seed and anyone can drive this city.');
    const seed = document.createElement('p');
    seed.className = 'pause-seed';
    seed.textContent = this.seed;
    const row = document.createElement('div');
    row.className = 'pause-row';
    row.append(
      button('title-back', 'Copy seed', () => void this.copy(this.seed, 'The seed is on the clipboard.')),
      button('title-back', 'Regenerate', () => this.actions.regenerate()),
    );
    city.append(seed, row, this.status());
    main.append(menu, city);
    return main;
  }

  private buildTransfer(): HTMLElement {
    const root = page('title-page pause-transfer');
    const sheet = card('II', 'Save as text', 'Copy the text to move a save to another machine, or paste a save to load it.');
    this.text.className = 'pause-text';
    this.text.spellcheck = false;
    this.text.dataset.nav = '';
    this.text.setAttribute('aria-label', 'Save text');
    const row = document.createElement('div');
    row.className = 'pause-row';
    const load = button('title-cta', 'Load this save', () => this.run(() => this.resumeWith(this.actions.importText(this.text.value))));
    row.append(
      button('title-back', 'Copy', () => void this.copy(this.text.value, 'The save is on the clipboard.')),
      button('title-back', 'Paste', () => void this.paste()),
      load,
      button('title-back', 'Back', () => this.pages.back()),
    );
    sheet.append(this.text, row, this.status());
    root.append(sheet);
    return root;
  }

  private status(): HTMLElement {
    const el = document.createElement('p');
    el.className = 'pause-status';
    el.setAttribute('aria-live', 'polite');
    this.statuses.push(el);
    return el;
  }

  private say(text: string): void {
    for (const el of this.statuses) el.textContent = text;
  }

  /** Run an action and put what it answered, or what went wrong, on the status line. */
  private run(action: () => string): void {
    try {
      this.say(action());
    } catch (error) {
      this.say(error instanceof Error ? error.message : String(error));
    }
    this.loadItem.disabled = !this.actions.canLoad();
  }

  /** A load that worked goes back to the street at once, to the session as it was saved. */
  private resumeWith(message: string): string {
    this.hide();
    return message;
  }

  private exportSave(): void {
    this.text.value = this.actions.exportText();
    this.pages.show('transfer');
    void this.copy(this.text.value, 'The save is on the clipboard, and in the box below.');
  }

  private importPage(): void {
    this.text.value = '';
    this.pages.show('transfer');
    this.say('Paste a save into the box, then load it.');
    this.text.focus();
  }

  /** Put text on the clipboard. The browser may refuse, so the text stays where it can be copied by hand. */
  private async copy(text: string, done: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.say(done);
    } catch {
      this.say('The browser would not give the clipboard. Select the text and copy it.');
    }
  }

  private async paste(): Promise<void> {
    try {
      this.text.value = await navigator.clipboard.readText();
      this.say('Pasted. Load the save to play it.');
    } catch {
      this.say('The browser would not give the clipboard. Paste into the box with the keyboard.');
    }
  }
}
