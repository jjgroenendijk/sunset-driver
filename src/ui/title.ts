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

/** What the player settled on before the session starts. */
export interface TitleChoice {
  seed: string;
  character: CharacterAppearance;
}

/**
 * The title screen of spec section 12: seed entry, seed randomisation,
 * character creation, continue and the control list. The character is previewed
 * in the scene, so every change is reported through `onPreview`.
 */
export class TitleScreen {
  private readonly root: HTMLElement;
  private readonly seedInput: HTMLInputElement;
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
    this.seedInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.finish();
    });

    const randomise = document.createElement('button');
    randomise.type = 'button';
    randomise.className = 'title-secondary';
    randomise.textContent = 'Randomise';
    randomise.addEventListener('click', () => {
      this.seedInput.value = randomSeedString();
    });

    row.append(label, this.seedInput, randomise);
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

  private finish(): void {
    const typed = this.seedInput.value.trim();
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.({ seed: typed.length > 0 ? typed : randomSeedString(), character: this.character });
  }
}
