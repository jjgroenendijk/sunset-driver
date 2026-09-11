import { gameTime } from '../sim/clock.ts';
import type { SimState } from '../sim/simulation.ts';

/** Minimal DOM overlay: seed, game clock and draw calls. Grows into the full HUD. */
export class Hud {
  private readonly root: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly seedEl: HTMLElement;
  private readonly draws: HTMLElement;
  private shownDraws = -1;
  private shownLights = -1;

  constructor(parent: HTMLElement, seed: string) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.seedEl = document.createElement('div');
    this.seedEl.className = 'hud-seed';
    this.seedEl.textContent = `seed ${seed}`;
    this.clock = document.createElement('div');
    this.clock.className = 'hud-clock';
    this.draws = document.createElement('div');
    this.draws.className = 'hud-seed';
    this.root.append(this.seedEl, this.clock, this.draws);
    parent.append(this.root);
  }

  /**
   * `drawCalls` is what the dearest chunk on screen costs (spec section 9.2)
   * and `lights` is what the scene is lit by (spec section 10.5). Both are
   * written only when they change, so the overlay is not rewritten every frame
   * for numbers that move once a minute.
   */
  update(state: SimState, drawCalls: number, lights: number): void {
    const t = gameTime(state.tick);
    const hh = String(t.hour).padStart(2, '0');
    const mm = String(t.minute).padStart(2, '0');
    this.clock.textContent = `day ${t.day + 1}  ${hh}:${mm}`;
    if (drawCalls === this.shownDraws && lights === this.shownLights) return;
    this.shownDraws = drawCalls;
    this.shownLights = lights;
    this.draws.textContent = `${drawCalls} draws/chunk  ${lights} lights`;
  }
}
