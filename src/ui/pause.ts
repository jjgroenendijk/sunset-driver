/**
 * The pause menu of spec section 12. The main list is Resume, Multiplayer,
 * Save game, Load game, Controls, Graphics, Options and Quit to main menu. Every
 * item but Resume and Quit opens a column beside the list, and Export, Import, Camera and Gore
 * open one beside that. Multiplayer is the room of spec section 21 (`party.ts`).
 * Save game also copies the city's seed, which is all anyone needs to drive the
 * same city. Load game holds New city, which starts again on a fresh seed.
 *
 * It is drawn in the look of the title screen and walked the same way, through
 * `MenuPages`. It holds no session: every item calls an action `pause-actions.ts`
 * hands it, and a thrown error is shown as the menu's status line. It listens to no
 * key itself, because Escape both opens it and closes it, and `keys.ts` is what
 * decides which one a press means.
 */
import type { MenuSettings } from './settings.ts';
import { buildPartyPage, type PartyActions, type PartyPage } from './party.ts';
import { buildCameraPage, buildGorePage } from './title-camera.ts';
import { buildControlsPage } from './title-controls.ts';
import { MenuPages } from './menu-pages.ts';
import { backButton, button, card, columnsOf, menuList, page } from './title-parts.ts';
import { buildGraphicsPage } from './title-graphics.ts';
import { buildSettingsPage } from './title-settings.ts';

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
  /** The settings the Settings column offers. A choice takes effect at once. */
  settings: MenuSettings;
  /** The room of spec section 21: where it stands, and the two presses that open and leave it. */
  party: PartyActions;
}

const PAGE_NAMES = ['main', 'party', 'saves', 'export', 'loads', 'import', 'controls', 'graphics', 'settings', 'camera', 'gore'] as const;
type PageName = (typeof PAGE_NAMES)[number];

const PARENT: Record<PageName, PageName | null> = {
  main: null,
  party: 'main',
  saves: 'main',
  export: 'saves',
  loads: 'main',
  import: 'loads',
  controls: 'main',
  graphics: 'main',
  settings: 'main',
  camera: 'settings',
  gore: 'settings',
};

/** Every page but the main one opens as a column beside its parent. */
const COLUMNS: ReadonlySet<PageName> = new Set(PAGE_NAMES.filter((name) => name !== 'main'));

export class PauseMenu {
  private readonly root: HTMLElement;
  private readonly pages: MenuPages<PageName>;
  private readonly actions: PauseActions;
  private readonly seed: string;
  private readonly loadItem: HTMLButtonElement;
  /** The save as text, to copy out, and the box a save is pasted into. */
  private readonly exported: HTMLTextAreaElement;
  private readonly imported: HTMLTextAreaElement;
  /** The multiplayer page, redrawn whenever the room changes under it. */
  private readonly party: PartyPage;
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

    this.exported = saveText(true);
    this.imported = saveText(false);
    this.party = buildPartyPage(actions.party, (text, done) => void this.copy(text, done), () => this.pages.back());
    const loads = this.buildLoads();
    this.loadItem = loads.querySelector<HTMLButtonElement>('.title-menu-item') as HTMLButtonElement;
    const back = (): void => void this.pages.back();
    const pages: Record<PageName, HTMLElement> = {
      main: this.buildMain(),
      party: this.party.root,
      saves: this.buildSaves(),
      export: this.buildExport(),
      loads,
      import: this.buildImport(),
      controls: buildControlsPage(back),
      graphics: buildGraphicsPage(actions.settings.graphics, back),
      settings: buildSettingsPage(actions.settings, back),
      camera: buildCameraPage(actions.settings.buildingView, back),
      gore: buildGorePage(actions.settings.gore, back),
    };
    this.pages = new MenuPages(this.root, pages, PARENT, 'main', COLUMNS);
    // The export is written as its column opens, so it is the session as it stands.
    this.pages.onOpen = (name) => {
      if (name === 'export') this.exportSave();
      if (name === 'import') this.importPage();
    };

    const brand = document.createElement('header');
    brand.className = 'title-brand';
    brand.innerHTML = '<h1><em>Paused</em></h1>';
    const hint = document.createElement('footer');
    hint.className = 'title-hint';
    hint.innerHTML =
      '<span><kbd>↑</kbd><kbd>↓</kbd> Choose</span><span><kbd>Enter</kbd> Confirm</span>' +
      '<span><kbd>Esc</kbd> Back</span>';
    this.root.append(brand, columnsOf(PAGE_NAMES.map((name) => pages[name])), hint);
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
    this.party.update();
    this.pages.show('main');
  }

  /** The room changed under the menu, so the multiplayer page is drawn again. */
  refresh(): void {
    this.party.update();
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
    main.append(
      menuList([
        { numeral: 'I', label: 'Resume', action: () => this.hide() },
        { numeral: 'II', label: 'Multiplayer', opens: 'party' },
        { numeral: 'III', label: 'Save game', opens: 'saves' },
        { numeral: 'IV', label: 'Load game', opens: 'loads' },
        { numeral: 'V', label: 'Controls', opens: 'controls' },
        { numeral: 'VI', label: 'Graphics', opens: 'graphics' },
        { numeral: 'VII', label: 'Options', opens: 'settings' },
        { numeral: 'VIII', label: 'Quit to main menu', action: () => this.actions.quit() },
      ]),
    );
    return main;
  }

  private buildSaves(): HTMLElement {
    const root = page('title-page pause-saves');
    const menu = menuList(
      [
        { numeral: 'I', label: 'Save', action: () => this.run(() => this.actions.save()) },
        { numeral: 'II', label: 'Export', opens: 'export' },
        { numeral: 'III', label: 'Copy seed', action: () => void this.copy(this.seed, `Copied · ${this.seed}`) },
      ],
      'Save game',
    );
    menu.append(this.status(), backButton(() => this.pages.back()));
    root.append(menu);
    return root;
  }

  private buildLoads(): HTMLElement {
    const root = page('title-page pause-loads');
    const menu = menuList(
      [
        { numeral: 'I', label: 'Load', action: () => this.run(() => this.resumeWith(this.actions.load())) },
        { numeral: 'II', label: 'Import', opens: 'import' },
        { numeral: 'III', label: 'New city', action: () => this.actions.regenerate() },
      ],
      'Load game',
    );
    menu.append(this.status(), backButton(() => this.pages.back()));
    root.append(menu);
    return root;
  }

  private buildExport(): HTMLElement {
    const root = page('title-page pause-transfer');
    const sheet = card('', 'Export');
    const row = document.createElement('div');
    row.className = 'pause-row';
    row.append(button('title-back', 'Copy', () => void this.copy(this.exported.value, 'Copied.')));
    sheet.append(this.exported, row, this.status(), backButton(() => this.pages.back()));
    root.append(sheet);
    return root;
  }

  private buildImport(): HTMLElement {
    const root = page('title-page pause-transfer');
    const sheet = card('', 'Import');
    const row = document.createElement('div');
    row.className = 'pause-row';
    row.append(
      button('title-back', 'Paste', () => void this.paste()),
      button('title-cta', 'Load', () => this.run(() => this.resumeWith(this.actions.importText(this.imported.value)))),
    );
    sheet.append(this.imported, row, this.status(), backButton(() => this.pages.back()));
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

  /** The export column opens on the session as it stands, already on the clipboard. */
  private exportSave(): void {
    this.exported.value = this.actions.exportText();
    void this.copy(this.exported.value, 'Copied.');
  }

  private importPage(): void {
    this.imported.value = '';
    this.say('');
  }

  /** Put text on the clipboard. The browser may refuse, so the text stays where it can be copied by hand. */
  private async copy(text: string, done: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.say(done);
    } catch {
      this.say('Clipboard blocked. Copy by hand.');
    }
  }

  private async paste(): Promise<void> {
    try {
      this.imported.value = await navigator.clipboard.readText();
      this.say('Pasted.');
    } catch {
      this.say('Clipboard blocked. Paste by hand.');
    }
  }
}

/** The box a save is read out of or pasted into. */
function saveText(readOnly: boolean): HTMLTextAreaElement {
  const text = document.createElement('textarea');
  text.className = 'pause-text';
  text.spellcheck = false;
  text.readOnly = readOnly;
  if (!readOnly) text.dataset.nav = '';
  text.setAttribute('aria-label', 'Save text');
  return text;
}
