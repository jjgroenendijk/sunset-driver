import type { OnAirLine } from '../audio/game-audio.ts';
import { gameTime } from '../sim/clock.ts';
import type { SimState } from '../sim/simulation.ts';
import { conditionOf } from '../sim/damage.ts';
import { MAX_HEALTH } from '../sim/on-foot.ts';
import { specOf } from '../sim/vehicle.ts';
import { currentSlot, currentWeapon, poolOf, reloading } from '../sim/weapon.ts';
import { weatherAt } from '../sim/weather.ts';

/**
 * The key that shows and hides the developer block. Listed in `controls.ts`.
 * It sets `dev-info` on the body, and `hud.css` shows the block by that class.
 */
export const DEV_INFO_KEY = 'F3';

/**
 * One line of text on the HUD. It keeps what it last wrote and writes only a
 * change: a DOM write lays the whole overlay out again, and doing that sixty
 * times a second for numbers that stand still is a frame the city could have
 * spent on itself. An empty line hides its element.
 */
class Field {
  readonly el: HTMLElement;
  private readonly hideEmpty: boolean;
  private shown: string | null = null;

  constructor(parent: HTMLElement, className: string, hideEmpty = true) {
    this.el = document.createElement('div');
    this.el.className = className;
    this.el.hidden = hideEmpty;
    this.hideEmpty = hideEmpty;
    parent.append(this.el);
  }

  /** Write `text`, if it is not what the element already says. */
  set(text: string): void {
    if (text === this.shown) return;
    this.shown = text;
    this.el.textContent = text;
    if (this.hideEmpty) this.el.hidden = text === '';
  }
}

function box(parent: HTMLElement, className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  parent.append(el);
  return el;
}

/**
 * The HUD of spec section 12: health, money, the weapon and its ammunition, the
 * heat level and the current objective, over the canvas as DOM.
 *
 * It is laid out the way open-world games lay theirs out, so a player finds
 * each thing where they already look for it:
 *
 * - top right, the clock, the money, the weapon and the wanted stars;
 * - bottom left, the health ring round the minimap (`minimap.ts`);
 * - bottom right, the speedometer, while the player drives;
 * - top left, the objective and what the ground underfoot is;
 * - top centre, the radio station; the middle, Wasted or Busted.
 *
 * The developer block — seed, weather numbers, draw calls, quality tier — is
 * hidden until {@link DEV_INFO_KEY} is pressed.
 */
export class Hud {
  private readonly parts: HTMLElement[] = [];
  private readonly clock: Field;
  private readonly day: Field;
  private readonly money: Field;
  private readonly weaponName: Field;
  private readonly ammo: Field;
  private readonly stars: HTMLElement;
  private readonly starEls: HTMLElement[] = [];
  private readonly ring: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly kmh: Field;
  private readonly vehicle: Field;
  private readonly condition: Field;
  private readonly conditionFill: HTMLElement;
  private readonly objective: Field;
  private readonly turf: Field;
  private readonly happening: Field;
  private readonly radio: Field;
  private readonly fate: HTMLElement;
  private readonly fateTitle: Field;
  private readonly fateCost: Field;
  private readonly devClock: Field;
  private readonly devStatus: Field;
  private readonly devDraws: Field;
  private shownHealth = -1;
  private shownStars = '';
  private shownIntegrity = -1;

  constructor(parent: HTMLElement, seed: string) {
    const part = (className: string): HTMLElement => {
      const el = document.createElement('div');
      el.className = className;
      this.parts.push(el);
      parent.append(el);
      return el;
    };

    // Top left: the developer block over the objective tracker.
    const left = part('hud-left');
    const dev = box(left, 'hud-dev');
    new Field(dev, 'hud-dev-seed', false).set(`seed ${seed}`);
    this.devClock = new Field(dev, 'hud-dev-line', false);
    this.devStatus = new Field(dev, 'hud-dev-line', false);
    this.devDraws = new Field(dev, 'hud-dev-line', false);
    this.objective = new Field(left, 'hud-objective');
    // Whose ground the player is standing on (spec section 17.2), and what the
    // city has on there (spec section 20.5): the context of the objective.
    this.turf = new Field(left, 'hud-turf');
    this.happening = new Field(left, 'hud-happening');

    // Top right: the stack a player reads at a glance.
    const right = part('hud-right');
    const time = box(right, 'hud-time');
    this.clock = new Field(time, 'hud-clock', false);
    this.day = new Field(time, 'hud-day', false);
    this.money = new Field(right, 'hud-money', false);
    const weapon = box(right, 'hud-weapon');
    this.weaponName = new Field(weapon, 'hud-weapon-name', false);
    this.ammo = new Field(weapon, 'hud-ammo');
    // Heat as stars (spec section 14), shown only once something has raised it,
    // so a session that has drawn no attention says nothing about attention.
    this.stars = box(right, 'hud-stars');
    this.stars.hidden = true;
    for (let i = 0; i < HEAT_STARS; i++) this.starEls.push(box(this.stars, 'hud-star'));

    // Health as a ring round the minimap rather than a number: what a player
    // needs off a glance is how much is left (spec section 11.5).
    this.ring = part('hud-ring');

    // Bottom right: the speedometer, and what is left of the vehicle (spec
    // section 11.3), only while the player drives.
    this.speed = part('hud-speed');
    this.speed.hidden = true;
    const dial = box(this.speed, 'hud-speed-dial');
    this.kmh = new Field(dial, 'hud-kmh', false);
    new Field(dial, 'hud-kmh-unit', false).set('km/h');
    this.vehicle = new Field(this.speed, 'hud-vehicle', false);
    const bar = box(this.speed, 'hud-condition');
    this.conditionFill = box(bar, 'hud-condition-fill');
    this.condition = new Field(this.speed, 'hud-condition-text');

    // The radio of spec section 15: the station, and the line of an ident or of
    // a harm-reduction announcement while one is being read (spec section 19).
    this.radio = new Field(part('hud-top'), 'hud-radio');

    // How the last run ended (spec section 11.7), in the middle of the screen.
    this.fate = part('hud-fate');
    this.fate.hidden = true;
    this.fateTitle = new Field(this.fate, 'hud-fate-title', false);
    this.fateCost = new Field(this.fate, 'hud-fate-cost', false);
  }

  /**
   * `drawCalls` is what the dearest chunk on screen costs (spec section 9.2),
   * `lights` is what the scene is lit by (spec section 10.5), `streaming` how
   * many chunks are still being built (spec section 9.1) and `tier` the
   * quality tier the frame is drawn at (spec section 9.2). `onAir` is what the
   * radio of spec section 15 is playing, or null while nothing is. `turf` is
   * what the factions of spec section 17.2 say about the block underfoot, and
   * is empty on ground nobody runs.
   */
  update(
    state: SimState,
    drawCalls: number,
    lights: number,
    streaming: number,
    tier: string,
    onAir: OnAirLine | null = null,
    turf = '',
    happening = '',
  ): void {
    const t = gameTime(state.tick);
    const hh = String(t.hour).padStart(2, '0');
    const mm = String(t.minute).padStart(2, '0');
    const weather = weatherAt(state.seed, state.tick);
    this.clock.set(`${hh}:${mm}`);
    this.day.set(`Day ${t.day + 1} · ${weather.kind}`);

    const p = state.player;
    const hp = Math.max(0, Math.round(p.health));
    if (hp !== this.shownHealth) {
      this.shownHealth = hp;
      this.ring.style.setProperty('--hp', `${(hp / MAX_HEALTH) * 100}%`);
      // The ring turns as it empties, so a player in trouble sees it.
      this.ring.classList.toggle('hud-ring-low', hp <= MAX_HEALTH * 0.3);
    }

    this.money.set(`$${Math.round(state.money).toLocaleString('en-US')}`);
    const armed = weaponParts(state);
    this.weaponName.set(armed.name);
    this.ammo.set(armed.ammo);

    const stars = state.heat > 0 ? heatStars(state.heat).join(' ') : '';
    if (stars !== this.shownStars) {
      this.shownStars = stars;
      this.stars.hidden = stars === '';
      const kinds = stars === '' ? [] : stars.split(' ');
      this.starEls.forEach((el, i) => {
        el.className = `hud-star hud-star-${kinds[i] ?? 'empty'}`;
      });
    }

    // The speedometer, and what is being driven and what is left of it.
    const kmh = Math.round(Math.abs(p.speed) * 3.6);
    if (this.speed.hidden === p.driving) this.speed.hidden = !p.driving;
    if (p.driving) {
      this.kmh.set(String(kmh));
      this.vehicle.set(specOf(state.vehicle.cls).name);
      const damage = state.vehicle.damage;
      const integrity = damage.stage === 'burnt' ? 0 : Math.round(damage.integrity * 100);
      if (integrity !== this.shownIntegrity) {
        this.shownIntegrity = integrity;
        this.conditionFill.style.width = `${integrity}%`;
        this.conditionFill.classList.toggle('hud-condition-low', integrity <= 30);
      }
      this.condition.set(damage.stage === 'burning' || damage.stage === 'burnt' ? conditionOf(damage) : '');
    }

    this.objective.set(state.objective);
    this.turf.set(turf);
    this.happening.set(happening);
    this.radio.set(radioLine(onAir));

    const fate = fateLine(state);
    if (this.fate.hidden !== (fate === '')) this.fate.hidden = fate === '';
    if (fate !== '') {
      const split = fate.indexOf('  ');
      this.fateTitle.set(fate.slice(0, split));
      this.fateCost.set(fate.slice(split + 2));
    }

    // The developer block. It is written while hidden too, so it is right the
    // moment it is shown; a hidden element costs no layout.
    const wet = Math.round(weather.wetness * 100);
    this.devClock.set(`day ${t.day + 1}  ${hh}:${mm}  ${weather.kind}  wet ${wet}%`);
    const moving = p.driving
      ? `${specOf(state.vehicle.cls).name}  ${conditionOf(state.vehicle.damage)}`
      : 'on foot';
    const heat = state.heat > 0 ? `  ${heatLine(state.heat)}` : '';
    this.devStatus.set(`${kmh} km/h  ${moving}${heat}`);
    // The queue is shown only while it holds something: a settled city says
    // nothing about streaming, which is what a settled city should say.
    const queue = streaming > 0 ? `  ${streaming} streaming` : '';
    this.devDraws.set(`${drawCalls} draws/chunk  ${lights} lights  ${tier}${queue}`);
  }

  destroy(): void {
    for (const el of this.parts) el.remove();
  }
}

/**
 * The radio line of spec section 15: the station on the dial, and under it the
 * ident or the harm-reduction announcement being read (spec section 19). A
 * station playing a song is the station's name alone.
 */
export function radioLine(onAir: OnAirLine | null): string {
  if (onAir === null) return '';
  if (onAir.text === '') return `♪ ${onAir.name}`;
  return onAir.from === '' ? `♪ ${onAir.text}` : `♪ ${onAir.text} — ${onAir.from}`;
}

/**
 * The weapon and the ammunition of spec section 12: what is in the player's
 * hands, and the rounds in its magazine over the pool behind them. A melee
 * weapon has no ammunition, and a weapon being reloaded says so instead.
 */
export function weaponParts(state: SimState): { name: string; ammo: string } {
  const spec = currentWeapon(state.loadout);
  if (spec.capacity === 0) return { name: spec.name, ammo: '' };
  if (reloading(state.loadout)) return { name: spec.name, ammo: 'reloading' };
  return { name: spec.name, ammo: `${currentSlot(state.loadout).loaded} / ${poolOf(state.loadout, spec)}` };
}

/** Ticks the HUD says how the last run ended for: four seconds. */
export const FATE_TICKS = 240;

/**
 * How the last run ended and what it cost (spec section 11.7), for
 * {@link FATE_TICKS} after the respawn, and empty otherwise. It is what tells a
 * player why they are standing somewhere else. The HUD sets the word before the
 * two spaces as the title and the rest under it.
 */
export function fateLine(state: SimState): string {
  const last = state.respawn;
  if (last === null || state.tick - last.tick > FATE_TICKS) return '';
  const what = last.cause === 'death' ? 'Wasted  hospital fee' : 'Busted  bribe';
  return `${what} $${last.cost.toLocaleString('en-US')}`;
}

/**
 * The wanted stars of spec section 14, one slot for each of
 * {@link HEAT_STARS}: a whole point of heat is a full star, and a fraction of
 * one is a star that is filling, which the HUD makes blink.
 */
export function heatStars(heat: number): ('full' | 'part' | 'empty')[] {
  const full = Math.min(HEAT_STARS, Math.floor(heat));
  const lit = Math.min(HEAT_STARS, Math.ceil(heat));
  const out: ('full' | 'part' | 'empty')[] = [];
  for (let i = 0; i < HEAT_STARS; i++) out.push(i < full ? 'full' : i < lit ? 'part' : 'empty');
  return out;
}

/**
 * Heat as a line of text: a full star `★` for each whole point and `☆` for the
 * one filling, then the number, because a fraction of a star is not a star.
 */
export function heatLine(heat: number): string {
  const stars = heatStars(heat).map((kind) => (kind === 'full' ? '★' : kind === 'part' ? '☆' : '')).join('');
  return `${stars}  heat ${heat.toFixed(1)}`;
}

/** The most stars the HUD draws. */
export const HEAT_STARS = 6;
