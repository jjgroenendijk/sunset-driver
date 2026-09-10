import { gameTime } from '../sim/clock.ts';
import type { SimState } from '../sim/simulation.ts';

/** Minimal DOM overlay: seed and game clock. Grows into the full HUD. */
export class Hud {
  private readonly root: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly seedEl: HTMLElement;

  constructor(parent: HTMLElement, seed: string) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.seedEl = document.createElement('div');
    this.seedEl.className = 'hud-seed';
    this.seedEl.textContent = `seed ${seed}`;
    this.clock = document.createElement('div');
    this.clock.className = 'hud-clock';
    this.root.append(this.seedEl, this.clock);
    parent.append(this.root);
  }

  update(state: SimState): void {
    const t = gameTime(state.tick);
    const hh = String(t.hour).padStart(2, '0');
    const mm = String(t.minute).padStart(2, '0');
    this.clock.textContent = `day ${t.day + 1}  ${hh}:${mm}`;
  }
}
