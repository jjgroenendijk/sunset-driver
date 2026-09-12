import { randomSeedString, seedFromString } from '../core/seed.ts';
import {
  CHARACTER_CHOICES,
  type CharacterChoiceKey,
  type CharacterAppearance,
  cycleChoice,
  normaliseAppearance,
  optionLabel,
  randomAppearance,
} from '../sim/character.ts';
import { CONTROLS } from './controls.ts';
import { SeedPreview } from './seed-preview.ts';
import type { WorldDescription } from '../world/types.ts';

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

/**
 * The title screen of spec section 12: seed entry, seed randomisation, a map
 * of the seed, character creation, continue and the control list. The character
 * is previewed in the scene, so every change is reported through `onPreview`;
 * the map is drawn by `seed-preview.ts` into the panel itself.
 */
export class TitleScreen {
  private readonly root: HTMLElement;
  private readonly seedInput: HTMLInputElement;
  private readonly preview: SeedPreview;
  private readonly valueLabels: HTMLElement[] = [];
  private readonly onPreview: (appearance: CharacterAppearance) => void;
  private character: CharacterAppearance;
  private resolve: ((choice: TitleChoice) => void) | null = null;

  constructor(parent: HTMLElement, initial: TitleChoice, onPreview: (appearance: CharacterAppearance) => void) {
    this.character = normaliseAppearance(initial.character);
    this.onPreview = onPreview;

    this.root = document.createElement('section');
    this.root.className = 'title';

    const heading = document.createElement('h1');
    heading.textContent = 'Sunset Driver';
    this.root.append(heading);

    const panel = document.createElement('div');
    panel.className = 'title-panel';
    this.root.append(panel);

    this.seedInput = document.createElement('input');
    panel.append(this.buildSeedRow(initial.seed));
    this.preview = new SeedPreview(panel);

    const choices = document.createElement('div');
    choices.className = 'title-choices';
    for (const choice of CHARACTER_CHOICES) {
      const row = document.createElement('div');
      row.className = 'title-row';

      const label = document.createElement('span');
      label.className = 'title-label';
      label.textContent = choice.label;

      const value = document.createElement('span');
      value.className = 'title-value';
      this.valueLabels.push(value);

      row.append(label, this.stepButton('◀', choice.key, -1), value, this.stepButton('▶', choice.key, 1));
      choices.append(row);
    }
    panel.append(choices);

    const surprise = document.createElement('button');
    surprise.type = 'button';
    surprise.className = 'title-secondary';
    surprise.textContent = 'Random look';
    surprise.addEventListener('click', () => {
      this.apply(randomAppearance(seedFromString(randomSeedString())));
    });
    panel.append(surprise);

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'title-play';
    play.textContent = 'Continue';
    play.addEventListener('click', () => this.finish());
    panel.append(play);

    panel.append(this.buildControls());
    parent.append(this.root);

    this.refresh();
    this.onPreview(this.character);
  }

  /** Resolves once the player presses Continue. */
  wait(): Promise<TitleChoice> {
    return new Promise<TitleChoice>((resolve) => {
      this.resolve = resolve;
    });
  }

  destroy(): void {
    this.root.remove();
  }

  private buildSeedRow(seed: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'title-row';

    const label = document.createElement('label');
    label.className = 'title-label';
    label.textContent = 'Seed';
    label.htmlFor = 'seed-input';

    this.seedInput.id = 'seed-input';
    this.seedInput.className = 'title-seed';
    this.seedInput.value = seed;
    this.seedInput.spellcheck = false;
    // Enter builds the map rather than starting the game: a seed typed in is a
    // seed the player wants to look at before they commit to it. Continue is
    // what starts the session.
    this.seedInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void this.buildPreview();
    });
    // `change` fires when the field is left as well, so a seed typed and
    // clicked away from is previewed too.
    this.seedInput.addEventListener('change', () => void this.buildPreview());

    const dice = document.createElement('button');
    dice.type = 'button';
    dice.className = 'title-dice';
    dice.textContent = '\u{1F3B2}';
    dice.title = 'Roll a new seed';
    dice.setAttribute('aria-label', 'Roll a new seed');
    dice.addEventListener('click', () => {
      this.seedInput.value = randomSeedString();
      void this.buildPreview();
    });

    const build = document.createElement('button');
    build.type = 'button';
    build.className = 'title-secondary';
    build.textContent = 'Build map';
    build.addEventListener('click', () => void this.buildPreview());

    row.append(label, this.seedInput, dice, build);
    return row;
  }

  private stepButton(text: string, key: CharacterChoiceKey, delta: number): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'title-step';
    button.textContent = text;
    button.addEventListener('click', () => this.apply(cycleChoice(this.character, key, delta)));
    return button;
  }

  private buildControls(): HTMLElement {
    const list = document.createElement('dl');
    list.className = 'title-controls';
    for (const binding of CONTROLS) {
      const action = document.createElement('dt');
      action.textContent = binding.action;
      const keys = document.createElement('dd');
      keys.textContent = binding.keys;
      list.append(action, keys);
    }
    return list;
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

  /** The seed in the box, or a fresh one where the box was left empty. */
  private seed(): string {
    const typed = this.seedInput.value.trim();
    if (typed.length > 0) return typed;
    const fresh = randomSeedString();
    this.seedInput.value = fresh;
    return fresh;
  }

  /** Build the seed in the box and show its map. */
  private async buildPreview(): Promise<void> {
    await this.preview.build(seedFromString(this.seed()));
  }

  private finish(): void {
    const seed = this.seed();
    const world = this.preview.world;
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.({
      seed,
      character: this.character,
      world: world && world.seed === seedFromString(seed) ? world : null,
    });
  }
}
