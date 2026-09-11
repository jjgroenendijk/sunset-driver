import { gameTime } from '../sim/clock.ts';
import type { SimState } from '../sim/simulation.ts';
import { specOf } from '../sim/vehicle.ts';

/** Minimal DOM overlay: seed, game clock and draw calls. Grows into the full HUD. */
export class Hud {
  private readonly root: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly seedEl: HTMLElement;
  private readonly draws: HTMLElement;
  private readonly speed: HTMLElement;
  private shownSpeed = -1;
  private shownVehicle = '';
  private shownDraws = -1;
  private shownLights = -1;
  private shownStreaming = -1;
  private shownTier = '';

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
    // The speedometer of spec section 12, until the full HUD lands.
    this.speed = document.createElement('div');
    this.speed.className = 'hud-clock';
    this.root.append(this.seedEl, this.clock, this.speed, this.draws);
    parent.append(this.root);
  }

  /**
   * `drawCalls` is what the dearest chunk on screen costs (spec section 9.2),
   * `lights` is what the scene is lit by (spec section 10.5), `streaming` how
   * many chunks are still being built (spec section 9.1) and `tier` the
   * quality tier the frame is drawn at (spec section 9.2). The line is written
   * only when one of them changes, so the overlay is not rewritten every frame
   * for numbers that stand still.
   */
  update(state: SimState, drawCalls: number, lights: number, streaming: number, tier: string): void {
    const t = gameTime(state.tick);
    const hh = String(t.hour).padStart(2, '0');
    const mm = String(t.minute).padStart(2, '0');
    this.clock.textContent = `day ${t.day + 1}  ${hh}:${mm}`;
    const kmh = Math.round(Math.abs(state.player.speed) * 3.6);
    // The name of what is being driven, so the debug picker's choice of spec
    // section 11.3 is readable while driving it.
    const driving = specOf(state.vehicle.cls).name;
    if (kmh !== this.shownSpeed || driving !== this.shownVehicle) {
      this.shownSpeed = kmh;
      this.shownVehicle = driving;
      this.speed.textContent = `${kmh} km/h  ${driving}`;
    }
    if (
      drawCalls === this.shownDraws &&
      lights === this.shownLights &&
      streaming === this.shownStreaming &&
      tier === this.shownTier
    ) {
      return;
    }
    this.shownDraws = drawCalls;
    this.shownLights = lights;
    this.shownStreaming = streaming;
    this.shownTier = tier;
    // The queue is shown only while it holds something: a settled city says
    // nothing about streaming, which is what a settled city should say.
    const queue = streaming > 0 ? `  ${streaming} streaming` : '';
    this.draws.textContent = `${drawCalls} draws/chunk  ${lights} lights  ${tier}${queue}`;
  }
}
