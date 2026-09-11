import { gameTime } from '../sim/clock.ts';
import type { SimState } from '../sim/simulation.ts';
import { conditionOf } from '../sim/damage.ts';
import { specOf } from '../sim/vehicle.ts';
import { currentSlot, currentWeapon, poolOf, reloading } from '../sim/weapon.ts';

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
    const p = state.player;
    const kmh = Math.round(Math.abs(p.speed) * 3.6);
    // What is being driven and what is left of it (spec section 11.3), so the
    // debug picker's choice and the damage states are both readable while they
    // are being driven through. On foot it says so instead, with the health of
    // spec section 11.5, until the full HUD lands.
    //
    // Heat is shown only once something has raised it (spec sections 11.4, 14),
    // so a session that has drawn no attention says nothing about attention.
    const heat = state.heat > 0 ? `  heat ${state.heat.toFixed(1)}` : '';
    const doing =
      (p.driving
        ? `${specOf(state.vehicle.cls).name}  ${conditionOf(state.vehicle.damage)}`
        : `on foot  ${Math.round(p.health)} hp`) +
      `  ${armed(state)}` +
      heat;
    if (kmh !== this.shownSpeed || doing !== this.shownVehicle) {
      this.shownSpeed = kmh;
      this.shownVehicle = doing;
      this.speed.textContent = `${kmh} km/h  ${doing}`;
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

/**
 * The weapon and the ammunition of spec section 12: what is in the player's
 * hands, the rounds in its magazine and the pool behind them. A melee weapon has
 * neither, so it is named and nothing else, and a weapon being reloaded says so.
 */
function armed(state: SimState): string {
  const spec = currentWeapon(state.loadout);
  if (spec.capacity === 0) return spec.name;
  if (reloading(state.loadout)) return `${spec.name}  reloading`;
  return `${spec.name}  ${currentSlot(state.loadout).loaded}/${poolOf(state.loadout, spec)}`;
}
