import { gameTime } from '../sim/clock.ts';
import type { SimState } from '../sim/simulation.ts';

/** Minimal DOM overlay: seed, game clock and draw calls. Grows into the full HUD. */
export class Hud {
  private readonly root: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly seedEl: HTMLElement;
  private readonly draws: HTMLElement;
  private shown = -1;
  private queued = -1;

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
   * and `streaming` how many chunks are still being built (spec section 9.1).
   * The line is written only when one of them changes, so the overlay is not
   * rewritten every frame for numbers that stand still.
   */
  update(state: SimState, drawCalls: number, streaming = 0): void {
    const t = gameTime(state.tick);
    const hh = String(t.hour).padStart(2, '0');
    const mm = String(t.minute).padStart(2, '0');
    this.clock.textContent = `day ${t.day + 1}  ${hh}:${mm}`;
    if (drawCalls === this.shown && streaming === this.queued) return;
    this.shown = drawCalls;
    this.queued = streaming;
    const queue = streaming > 0 ? `  ${streaming} streaming` : '';
    this.draws.textContent = `${drawCalls} draws/chunk${queue}`;
  }
}
