/**
 * The prompt that says what the interact key would do to a vehicle now (spec
 * sections 11.2, 11.4, 11.5): `E  Get in`, `E  Hotwire`, `E  Get out`.
 *
 * The rule is `vehicleAction` in `src/sim/interact.ts`, and this draws it. It
 * stands at the bottom of the screen, below where the door panels and the
 * arrest bar stand, and writes only when the action changes.
 */
import { vehicleAction } from '../sim/interact.ts';
import type { SimState } from '../sim/simulation.ts';

/** The key that acts, as `controls.ts` lists it. */
const INTERACT_KEY = 'E';

export class InteractPrompt {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private shown = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'interact';
    this.root.hidden = true;
    const key = document.createElement('kbd');
    key.className = 'interact-key';
    key.textContent = INTERACT_KEY;
    this.label = document.createElement('span');
    this.label.className = 'interact-label';
    this.root.append(key, this.label);
    parent.append(this.root);
  }

  /** Show the action a press would take, or hide where it would take none. */
  update(state: SimState): void {
    const action = vehicleAction(state) ?? '';
    if (action === this.shown) return;
    this.shown = action;
    this.root.hidden = action === '';
    this.label.textContent = action;
  }

  destroy(): void {
    this.root.remove();
  }
}
