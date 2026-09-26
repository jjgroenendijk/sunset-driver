/**
 * The crosshair of spec section 11.5: where the mouse aims, how wide the next
 * round may stray, the target the aim was pulled onto, and a mark when a round
 * lands.
 *
 * It reads the record and writes nothing back. The frame works out where on
 * the page each part stands, because that takes the camera; this only places
 * them. A field is written only when it changes, as the HUD's are.
 */
import { struck, type Tracer } from '../sim/tracer.ts';

/** Milliseconds the hit marker shows for after a round lands. */
const HIT_SHOW_MS = 160;

/** Pixels the ticks stand off the middle at the least, so a tight aim still reads. */
const MIN_GAP = 4;

/** Pixels the ticks stand off the middle at the most, so a sprayed gun does not fill the screen. */
const MAX_GAP = 90;

/** What the frame hands the crosshair: page pixels, or undefined for a part not shown. */
export interface CrosshairView {
  at: { x: number; y: number } | undefined;
  /** Pixels from the middle to each tick: the spread of the next round at the aim point. */
  gap: number;
  /** Where the target the aim was pulled onto stands, or undefined where it was not pulled. */
  lock: { x: number; y: number } | undefined;
  aiming: boolean;
}

export class Crosshair {
  private readonly root: HTMLElement;
  private readonly lock: HTMLElement;
  private shown = '';
  private lockShown = '';
  /** The tick of the newest tracer read, so a hit is marked once. */
  private seen = -1;
  private hitUntil = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'crosshair';
    for (const side of ['n', 'e', 's', 'w']) {
      const tick = document.createElement('div');
      tick.className = `crosshair-tick crosshair-${side}`;
      this.root.append(tick);
    }
    const dot = document.createElement('div');
    dot.className = 'crosshair-dot';
    this.root.append(dot);
    this.lock = document.createElement('div');
    this.lock.className = 'crosshair-lock';
    this.root.hidden = true;
    this.lock.hidden = true;
    parent.append(this.root, this.lock);
  }

  /**
   * Place the crosshair for this frame. `tracers` and `tick` are the record's,
   * read for the rounds that landed since the last frame; `now` is the page's
   * clock in milliseconds, which only times the hit marker.
   */
  update(view: CrosshairView, tracers: readonly Tracer[], tick: number, now: number): void {
    if (tick < this.seen) this.seen = tick - 1;
    for (let i = 0; i < tracers.length; i++) {
      const t = tracers[i] as Tracer;
      if (t.by !== 'player') continue;
      if (t.tick > this.seen && t.tick <= tick && struck(t.end)) this.hitUntil = now + HIT_SHOW_MS;
    }
    this.seen = tick;
    const hit = now < this.hitUntil;

    this.place(view, hit);
    const lock = view.at === undefined ? undefined : view.lock;
    const lockKey = lock === undefined ? '' : `${Math.round(lock.x)},${Math.round(lock.y)}`;
    if (lockKey !== this.lockShown) {
      this.lockShown = lockKey;
      this.lock.hidden = lock === undefined;
      if (lock !== undefined) this.lock.style.transform = `translate(${Math.round(lock.x)}px, ${Math.round(lock.y)}px)`;
    }
  }

  /** Move the cross, open it to the gap and mark a hit, redrawing only on a change. */
  private place(view: CrosshairView, hit: boolean): void {
    const at = view.at;
    const gap = Math.round(Math.min(MAX_GAP, Math.max(MIN_GAP, view.gap)));
    const key = at === undefined ? '' : `${Math.round(at.x)},${Math.round(at.y)},${gap},${hit},${view.aiming}`;
    if (key === this.shown) return;
    this.shown = key;
    this.root.hidden = at === undefined;
    if (at === undefined) return;
    const turn = hit ? ' rotate(45deg)' : '';
    this.root.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)${turn}`;
    this.root.style.setProperty('--gap', `${gap}px`);
    this.root.classList.toggle('crosshair-hit', hit);
    this.root.classList.toggle('crosshair-aiming', view.aiming);
  }

  /** Hide it: the camera is detached, a menu is open or the weapon in hand is not a gun. */
  hide(): void {
    this.update({ at: undefined, gap: 0, lock: undefined, aiming: false }, [], this.seen, 0);
  }
}
