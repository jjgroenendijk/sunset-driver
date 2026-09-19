import { randomSeedString, readSeedCode, seedFromString } from '../core/seed.ts';
import {
  CHARACTER_CHOICES,
  type CharacterChoiceKey,
  type CharacterAppearance,
  cycleChoice,
  optionLabel,
  randomAppearance,
} from '../sim/character.ts';
import type { WorldSource } from '../render/world-source.ts';
import type { WorldDescription } from '../world/types.ts';
import { SeedPreview } from './seed-preview.ts';
import { button, card, page } from './title-parts.ts';

/** What the New game page hands back: a seed, a look, and the world built for the seed if any. */
export interface SetupChoice {
  seed: string;
  character: CharacterAppearance;
  world: WorldDescription | null;
  /** The starting money the money code set, or undefined for the usual amount. */
  money?: number;
}

/**
 * The New game page of the title screen: the city card with the seed and its
 * map on the left, the driver card with the look on the right, and the
 * character itself turning in the scene between them. Every change of look is
 * reported through `onPreview`, because the scene draws the character.
 */
export class NewGamePage {
  readonly root: HTMLElement;
  private readonly seedInput: HTMLInputElement;
  private readonly preview: SeedPreview;
  private readonly valueLabels: HTMLElement[] = [];
  private readonly onPreview: (appearance: CharacterAppearance) => void;
  private character: CharacterAppearance;
  /** Set once the money code is typed, and kept for the rest of the page. */
  private money: number | undefined;

  constructor(
    seed: string,
    character: CharacterAppearance,
    worlds: WorldSource,
    onPreview: (appearance: CharacterAppearance) => void,
    actions: { back(): void; start(): void; joining?: boolean },
  ) {
    this.character = character;
    this.onPreview = onPreview;
    this.root = page('title-page title-setup');

    // A joiner drives in the host's city: the seed comes with the link, and
    // another one would be refused at the handshake. So a joiner is shown no
    // city card at all, only the driver.
    const joining = actions.joining === true;
    const city = card('I', 'City');
    this.seedInput = document.createElement('input');
    city.append(this.buildSeedRow(seed));
    this.preview = new SeedPreview(city, worlds, () => void this.buildPreview());

    const driver = card(joining ? 'I' : 'II', 'Driver');
    for (const choice of CHARACTER_CHOICES) driver.append(this.buildChoiceRow(choice.key, choice.label));
    driver.append(button('title-link', 'Random', () => this.apply(randomLook())));

    const foot = document.createElement('div');
    foot.className = 'title-setup-foot';
    const start = button('title-cta', joining ? 'Join' : 'Play', actions.start);
    start.dataset.autofocus = '';
    foot.append(button('title-back', 'Back', actions.back), start);

    if (joining) this.root.append(driver, foot);
    else this.root.append(city, driver, foot);
    this.refresh();
  }

  /** The seed in the box, the look, and the preview's world where it belongs to that seed. */
  choice(): SetupChoice {
    const seed = this.seed();
    const world = this.preview.world;
    return {
      seed,
      character: this.character,
      world: world && world.seed === seedFromString(seed) ? world : null,
      money: this.money,
    };
  }

  private buildSeedRow(seed: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'title-seed-row';

    const label = document.createElement('label');
    label.className = 'title-field-label';
    label.textContent = 'Seed';
    label.htmlFor = 'seed-input';

    this.seedInput.id = 'seed-input';
    this.seedInput.className = 'title-seed';
    this.seedInput.value = seed;
    this.seedInput.spellcheck = false;
    this.seedInput.autocomplete = 'off';
    this.seedInput.dataset.nav = '';
    // Enter builds the map rather than starting the game: a seed typed in is a
    // seed the player wants to look at before they commit to it. Play is what
    // starts the session.
    this.seedInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void this.buildPreview();
    });
    // `change` fires when the field is left as well, so a seed typed and
    // clicked away from is previewed too.
    this.seedInput.addEventListener('change', () => void this.buildPreview());

    const dice = button('title-icon', '⚄', () => {
      this.seedInput.value = randomSeedString();
      void this.buildPreview();
    });
    dice.title = 'Roll a new seed';
    dice.setAttribute('aria-label', 'Roll a new seed');

    row.append(label, this.seedInput, dice);
    return row;
  }

  /**
   * One detail of the look. The row itself takes the focus, so the arrow keys
   * walk down the rows and left and right change the detail; the two buttons
   * are for the mouse.
   */
  private buildChoiceRow(key: CharacterChoiceKey, text: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'title-choice';
    row.tabIndex = 0;
    row.dataset.nav = '';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', text);

    const label = document.createElement('span');
    label.className = 'title-field-label';
    label.textContent = text;

    const value = document.createElement('span');
    value.className = 'title-choice-value';
    value.setAttribute('aria-live', 'polite');
    this.valueLabels.push(value);

    const step = (delta: number): void => this.apply(cycleChoice(this.character, key, delta));
    const less = button('title-step', '◀', () => step(-1));
    const more = button('title-step', '▶', () => step(1));
    // The row is what the arrow keys and the pointer focus, not the buttons in it.
    for (const b of [less, more]) {
      b.tabIndex = -1;
      delete b.dataset.nav;
    }
    less.setAttribute('aria-label', `Previous ${text.toLowerCase()}`);
    more.setAttribute('aria-label', `Next ${text.toLowerCase()}`);

    row.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      step(event.key === 'ArrowLeft' ? -1 : 1);
    });

    row.append(label, less, value, more);
    return row;
  }

  private apply(appearance: CharacterAppearance): void {
    this.character = appearance;
    this.refresh();
    this.onPreview(appearance);
  }

  private refresh(): void {
    for (let i = 0; i < CHARACTER_CHOICES.length; i++) {
      const choice = CHARACTER_CHOICES[i];
      const label = this.valueLabels[i];
      if (choice && label) label.textContent = optionLabel(this.character, choice.key);
    }
  }

  /**
   * The seed in the box, or a fresh one where the box was left empty. The
   * money code is swapped in the box for the random seed it stands for.
   */
  private seed(): string {
    const typed = this.seedInput.value.trim();
    const code = readSeedCode(typed);
    if (code.money !== undefined) {
      this.money = code.money;
      this.seedInput.value = code.seed;
      return code.seed;
    }
    if (typed.length > 0) return typed;
    const fresh = randomSeedString();
    this.seedInput.value = fresh;
    return fresh;
  }

  /** Build the seed in the box and show its map. */
  private async buildPreview(): Promise<void> {
    await this.preview.build(seedFromString(this.seed()));
  }
}

function randomLook(): CharacterAppearance {
  return randomAppearance(seedFromString(randomSeedString()));
}
