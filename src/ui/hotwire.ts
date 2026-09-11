/**
 * The hotwire minigame on screen (spec section 11.4).
 *
 * The rules are in `src/sim/theft.ts` and this draws them: the pins still to
 * set, the window to stop the marker in, the marker sweeping the bar, and the
 * alarm if the vehicle has one. It reads the record and writes nothing back, so
 * the minigame is played by the simulation and only watched here.
 *
 * The panel stands over the bottom of the screen rather than beside the player,
 * because the camera looks down from 60 m and a bar drawn at the car would be a
 * few pixels across.
 */
import { TICK_RATE } from '../sim/clock.ts';
import {
  HOTWIRE_CAP,
  HOTWIRE_PINS,
  markerAt,
  TARGET_HALF,
  targetFor,
  type TheftState,
} from '../sim/theft.ts';

export class HotwireBar {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly window: HTMLElement;
  private readonly marker: HTMLElement;
  private readonly pins: HTMLElement[] = [];
  private shownLabel = '';
  /**
   * The attempt and the pin the window on screen was drawn for. It carries the
   * attempt as well as the pin, because a second attempt starts at the same
   * pin as the first and asks for a different window.
   */
  private shownPin = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hotwire';
    this.root.hidden = true;

    this.label = document.createElement('div');
    this.label.className = 'hotwire-label';

    const pins = document.createElement('div');
    pins.className = 'hotwire-pins';
    for (let i = 0; i < HOTWIRE_PINS; i++) {
      const pin = document.createElement('span');
      pin.className = 'hotwire-pin';
      this.pins.push(pin);
      pins.append(pin);
    }

    const bar = document.createElement('div');
    bar.className = 'hotwire-bar';
    this.window = document.createElement('div');
    this.window.className = 'hotwire-window';
    this.window.style.width = `${TARGET_HALF * 200}%`;
    this.marker = document.createElement('div');
    this.marker.className = 'hotwire-marker';
    bar.append(this.window, this.marker);

    this.root.append(this.label, pins, bar);
    parent.append(this.root);
  }

  /**
   * Draw the attempt in progress, or take the panel away when there is none.
   * `seed` and `tick` are what the window and the marker are a function of, so
   * what is drawn is exactly what the simulation is asking for.
   */
  update(theft: TheftState | null, seed: number, tick: number): void {
    if (theft === null || theft.open) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;

    const left = Math.max(0, HOTWIRE_CAP - (tick - theft.startedTick));
    const label = theft.alarm
      ? `Alarm  ${(left / TICK_RATE).toFixed(1)} s`
      : `Hotwire  ${(left / TICK_RATE).toFixed(1)} s`;
    if (label !== this.shownLabel) {
      this.shownLabel = label;
      this.label.textContent = label;
    }
    this.root.classList.toggle('hotwire-alarm', theft.alarm);

    const pin = `${theft.startedTick}:${theft.pins}`;
    if (pin !== this.shownPin) {
      this.shownPin = pin;
      for (let i = 0; i < this.pins.length; i++) {
        (this.pins[i] as HTMLElement).classList.toggle('hotwire-pin-set', i < theft.pins);
      }
      const target = targetFor(seed, theft.startedTick, theft.pins);
      this.window.style.left = `${(target - TARGET_HALF) * 100}%`;
    }
    this.marker.style.left = `${markerAt(theft, tick) * 100}%`;
  }

  destroy(): void {
    this.root.remove();
  }
}
