import { gameTime } from '../sim/clock.ts';
import type { SimState } from '../sim/simulation.ts';
import { conditionOf } from '../sim/damage.ts';
import { MAX_HEALTH } from '../sim/on-foot.ts';
import { specOf } from '../sim/vehicle.ts';
import { currentSlot, currentWeapon, poolOf, reloading } from '../sim/weapon.ts';
import { weatherAt } from '../sim/weather.ts';

/**
 * The HUD of spec section 12: health, money, the weapon and its ammunition, the
 * heat level and the current objective, over the canvas as DOM.
 *
 * It stands in two places. The status block at the top left is what a developer
 * reads — the seed, the game clock, the weather, the draw calls, the quality
 * tier and what is being driven. The panel at the bottom left is the game's own HUD, and it
 * is the part spec section 12 describes.
 *
 * Every field is written only when its text changes, so a frame that moves
 * nothing rewrites nothing. A DOM write forces the browser to lay the overlay
 * out again, and doing that sixty times a second for numbers that stand still
 * is a frame the city could have spent on itself.
 */
export class Hud {
  private readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly draws: HTMLElement;
  private readonly status: HTMLElement;
  private readonly healthBar: HTMLElement;
  private readonly healthText: HTMLElement;
  private readonly money: HTMLElement;
  private readonly weapon: HTMLElement;
  private readonly heat: HTMLElement;
  private readonly objective: HTMLElement;
  private readonly fate: HTMLElement;
  private shownClock = '';
  private shownStatus = '';
  private shownDraws = '';
  private shownHealth = -1;
  private shownMoney = -1;
  private shownWeapon = '';
  private shownHeat = '';
  private shownObjective = '';
  private shownFate = '';

  constructor(parent: HTMLElement, seed: string) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    const seedEl = document.createElement('div');
    seedEl.className = 'hud-seed';
    seedEl.textContent = `seed ${seed}`;
    this.clock = document.createElement('div');
    this.clock.className = 'hud-clock';
    this.draws = document.createElement('div');
    this.draws.className = 'hud-seed';
    this.status = document.createElement('div');
    this.status.className = 'hud-clock';
    this.root.append(seedEl, this.clock, this.status, this.draws);

    this.panel = document.createElement('div');
    this.panel.className = 'hud-panel';
    // Health as a bar rather than a number: what a player needs off a glance is
    // how much is left, not how many points it is (spec section 11.5).
    const health = document.createElement('div');
    health.className = 'hud-health';
    this.healthBar = document.createElement('div');
    this.healthBar.className = 'hud-health-fill';
    this.healthText = document.createElement('span');
    this.healthText.className = 'hud-health-text';
    health.append(this.healthBar, this.healthText);
    this.money = document.createElement('div');
    this.money.className = 'hud-money';
    this.weapon = document.createElement('div');
    this.weapon.className = 'hud-weapon';
    this.heat = document.createElement('div');
    this.heat.className = 'hud-heat';
    this.objective = document.createElement('div');
    this.objective.className = 'hud-objective';
    this.fate = document.createElement('div');
    this.fate.className = 'hud-fate';
    this.fate.hidden = true;
    this.panel.append(this.fate, health, this.money, this.weapon, this.heat, this.objective);
    parent.append(this.root, this.panel);
  }

  /**
   * `drawCalls` is what the dearest chunk on screen costs (spec section 9.2),
   * `lights` is what the scene is lit by (spec section 10.5), `streaming` how
   * many chunks are still being built (spec section 9.1) and `tier` the
   * quality tier the frame is drawn at (spec section 9.2).
   */
  update(state: SimState, drawCalls: number, lights: number, streaming: number, tier: string): void {
    const t = gameTime(state.tick);
    const hh = String(t.hour).padStart(2, '0');
    const mm = String(t.minute).padStart(2, '0');
    // The weather beside the clock (spec section 13.4), with how wet the road
    // is: the grip a corner is taken with is the number, not the word.
    const weather = weatherAt(state.seed, state.tick);
    const wet = Math.round(weather.wetness * 100);
    const clock = `day ${t.day + 1}  ${hh}:${mm}  ${weather.kind}  wet ${wet}%`;
    if (clock !== this.shownClock) {
      this.shownClock = clock;
      this.clock.textContent = clock;
    }

    const p = state.player;
    // What is being driven and what is left of it (spec section 11.3), so the
    // debug picker's choice and the damage states are both readable while they
    // are being driven through.
    const kmh = Math.round(Math.abs(p.speed) * 3.6);
    const status = p.driving
      ? `${kmh} km/h  ${specOf(state.vehicle.cls).name}  ${conditionOf(state.vehicle.damage)}`
      : `${kmh} km/h  on foot`;
    if (status !== this.shownStatus) {
      this.shownStatus = status;
      this.status.textContent = status;
    }

    // The queue is shown only while it holds something: a settled city says
    // nothing about streaming, which is what a settled city should say.
    const queue = streaming > 0 ? `  ${streaming} streaming` : '';
    const draws = `${drawCalls} draws/chunk  ${lights} lights  ${tier}${queue}`;
    if (draws !== this.shownDraws) {
      this.shownDraws = draws;
      this.draws.textContent = draws;
    }

    const hp = Math.max(0, Math.round(p.health));
    if (hp !== this.shownHealth) {
      this.shownHealth = hp;
      this.healthBar.style.width = `${(hp / MAX_HEALTH) * 100}%`;
      this.healthText.textContent = `${hp}`;
      // The bar turns as it empties, so a player in trouble sees it without
      // reading the number.
      this.healthBar.classList.toggle('hud-health-low', hp <= MAX_HEALTH * 0.3);
    }

    const money = Math.round(state.money);
    if (money !== this.shownMoney) {
      this.shownMoney = money;
      this.money.textContent = `$${money.toLocaleString('en-US')}`;
    }

    const armed = weaponLine(state);
    if (armed !== this.shownWeapon) {
      this.shownWeapon = armed;
      this.weapon.textContent = armed;
    }

    // Heat is shown only once something has raised it (spec sections 11.4, 14),
    // so a session that has drawn no attention says nothing about attention.
    const heat = state.heat > 0 ? heatLine(state.heat) : '';
    if (heat !== this.shownHeat) {
      this.shownHeat = heat;
      this.heat.textContent = heat;
      this.heat.hidden = heat === '';
    }

    if (state.objective !== this.shownObjective) {
      this.shownObjective = state.objective;
      this.objective.textContent = state.objective;
      this.objective.hidden = state.objective === '';
    }

    const fate = fateLine(state);
    if (fate !== this.shownFate) {
      this.shownFate = fate;
      this.fate.textContent = fate;
      this.fate.hidden = fate === '';
    }
  }

  destroy(): void {
    this.root.remove();
    this.panel.remove();
  }
}

/**
 * The weapon and the ammunition of spec section 12: what is in the player's
 * hands, the rounds in its magazine and the pool behind them. A melee weapon has
 * neither, so it is named and nothing else, and a weapon being reloaded says so.
 */
export function weaponLine(state: SimState): string {
  const spec = currentWeapon(state.loadout);
  if (spec.capacity === 0) return spec.name;
  if (reloading(state.loadout)) return `${spec.name}  reloading`;
  return `${spec.name}  ${currentSlot(state.loadout).loaded}/${poolOf(state.loadout, spec)}`;
}

/** Ticks the HUD says how the last run ended for: four seconds. */
export const FATE_TICKS = 240;

/**
 * How the last run ended and what it cost (spec section 11.7), for
 * {@link FATE_TICKS} after the respawn, and empty otherwise. It is what tells a
 * player why they are standing somewhere else.
 */
export function fateLine(state: SimState): string {
  const last = state.respawn;
  if (last === null || state.tick - last.tick > FATE_TICKS) return '';
  const what = last.cause === 'death' ? 'Wasted  hospital fee' : 'Busted  bribe';
  return `${what} $${last.cost.toLocaleString('en-US')}`;
}

/**
 * Heat as stars, the way the spec section 14 police system will read it: one
 * star a whole point, so the line grows as the attention does. The number
 * follows, because a fraction of a star is not a star.
 */
export function heatLine(heat: number): string {
  const stars = Math.min(HEAT_STARS, Math.floor(heat));
  return `${'★'.repeat(stars)}${'☆'.repeat(Math.max(0, Math.min(HEAT_STARS, Math.ceil(heat)) - stars))}  heat ${heat.toFixed(1)}`;
}

/** The most stars the HUD draws. */
export const HEAT_STARS = 6;
