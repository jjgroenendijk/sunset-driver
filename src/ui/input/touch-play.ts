/**
 * The on-screen controls that play the game with two thumbs.
 *
 * A phone reaches none of the keys of `controls.ts`, so a session on one is
 * given a pad while the camera follows the player: a stick under the left
 * thumb, and the buttons of the street under the right one. The stick walks
 * the way the view faces on foot and steers and drives in a vehicle, as
 * `W A S D` do. Each button holds the key a keyboard would, through
 * `Keyboard.press`, so the simulation reads one input frame whatever made it.
 *
 * The fly pad of `touch-fly.ts` takes the screen while the free camera is
 * detached, and this one is put away. The arithmetic of the stick is in
 * `touch.ts` and tested there; this is the browser half alone.
 */
import type { Keyboard } from './keyboard.ts';
import { stickVector } from './touch.ts';

/** A held button: the key it holds on foot, and the one it holds in a vehicle. */
interface ButtonSpec {
  foot: string;
  drive: string;
  /** The label on foot, and in a vehicle. */
  labels: readonly [string, string];
  /** The extra class that places the button in the cluster. */
  place: string;
}

/**
 * The held buttons, under the right thumb. Fire is the largest and nearest the
 * corner, where the thumb rests. Space is both the jump and the handbrake, so
 * that button is only relabelled; the other one is the sprint on foot and the
 * horn in a vehicle, because a driver has no legs to run with.
 */
const BUTTONS: readonly ButtonSpec[] = [
  { foot: 'Mouse0', drive: 'Mouse0', labels: ['Fire', 'Fire'], place: 'touch-fire' },
  { foot: 'Space', drive: 'Space', labels: ['Jump', 'Brake'], place: 'touch-jump' },
  { foot: 'KeyE', drive: 'KeyE', labels: ['Use', 'Exit'], place: 'touch-use' },
  { foot: 'ShiftLeft', drive: 'KeyH', labels: ['Run', 'Horn'], place: 'touch-run' },
  { foot: 'KeyR', drive: 'KeyR', labels: ['Load', 'Load'], place: 'touch-load' },
];

/** A button of the pad, and the key its finger is holding, or '' while it is up. */
interface Button {
  spec: ButtonSpec;
  el: HTMLButtonElement;
  pointer: number;
  code: string;
}

/** Pixels the knob may travel from the middle of the pad it is drawn in. */
const KNOB_TRAVEL = 30;

export class TouchPlay {
  private readonly root: HTMLElement;
  private readonly keyboard: Keyboard;
  private readonly knob: HTMLElement;
  private readonly buttons: Button[];
  private readonly radio: HTMLButtonElement;
  private readonly cluster: HTMLElement;
  /** The thumb on the stick, where it went down, and where it has reached. */
  private thumb: { id: number; fromX: number; fromY: number; x: number; y: number } | null = null;
  private driving = false;
  private live = false;
  private counter = false;

  constructor(parent: HTMLElement, keyboard: Keyboard) {
    this.keyboard = keyboard;
    this.root = document.createElement('div');
    this.root.className = 'touch-play';
    this.root.hidden = true;

    const pad = document.createElement('div');
    pad.className = 'touch-stick';
    pad.setAttribute('aria-label', 'Drag to walk or drive');
    this.knob = document.createElement('span');
    this.knob.className = 'touch-knob';
    pad.append(this.knob);
    this.bindStick(pad);

    const cluster = document.createElement('div');
    cluster.className = 'touch-cluster';
    this.cluster = cluster;
    this.buttons = BUTTONS.map((spec) => this.buildButton(spec));
    // The weapon and the radio are steps rather than holds, so a tap is enough.
    const weapon = tapButton('Gun', 'touch-gun', () => keyboard.nextWeapon());
    this.radio = tapButton('Radio', 'touch-radio', () => keyboard.pulse('BracketRight'));
    cluster.append(...this.buttons.map((b) => b.el), weapon, this.radio);

    this.root.append(pad, cluster);
    parent.append(this.root);
    this.relabel();
  }

  /**
   * Bring the pad in step with the frame: shown while the player is being
   * played rather than flown over or paused, and labelled for foot or wheel.
   * Put away, it lets go of every finger, so nothing stays held behind a menu.
   * While a shop's counter or a deal is open the buttons are put away alone:
   * the counter stands in their corner, and the stick still walks out.
   */
  update(driving: boolean, live: boolean, counter = false): void {
    if (live !== this.live) {
      this.live = live;
      this.root.hidden = !live;
      if (!live) this.forget();
    }
    if (counter !== this.counter) {
      this.counter = counter;
      this.cluster.hidden = counter;
      if (counter) for (const button of this.buttons) this.release(button);
    }
    if (driving === this.driving) return;
    this.driving = driving;
    this.relabel();
  }

  private relabel(): void {
    for (const button of this.buttons) button.el.textContent = button.spec.labels[this.driving ? 1 : 0];
    this.radio.hidden = !this.driving;
  }

  /** Let go of the stick and every button. */
  private forget(): void {
    this.thumb = null;
    this.moveStick();
    for (const button of this.buttons) this.release(button);
  }

  /**
   * The stick. It takes its centre from wherever the thumb lands rather than
   * from the middle of the pad, as the fly pad's does: the thumb cannot see
   * the spot it is covering.
   */
  private bindStick(pad: HTMLElement): void {
    pad.addEventListener('pointerdown', (event) => {
      if (this.thumb) return;
      pad.setPointerCapture(event.pointerId);
      this.thumb = { id: event.pointerId, fromX: event.clientX, fromY: event.clientY, x: event.clientX, y: event.clientY };
      this.moveStick();
    });
    pad.addEventListener('pointermove', (event) => {
      if (this.thumb?.id !== event.pointerId) return;
      this.thumb.x = event.clientX;
      this.thumb.y = event.clientY;
      this.moveStick();
    });
    const drop = (event: PointerEvent): void => {
      if (this.thumb?.id !== event.pointerId) return;
      this.thumb = null;
      this.moveStick();
    };
    pad.addEventListener('pointerup', drop);
    pad.addEventListener('pointercancel', drop);
  }

  /** Hand the stick to the keys, and draw the knob where the thumb has pushed it. */
  private moveStick(): void {
    const push = this.thumb ? stickVector(this.thumb.x - this.thumb.fromX, this.thumb.y - this.thumb.fromY) : null;
    this.keyboard.stick(push?.x ?? 0, push?.y ?? 0);
    const x = (push?.x ?? 0) * KNOB_TRAVEL;
    const y = -(push?.y ?? 0) * KNOB_TRAVEL;
    this.knob.style.transform = `translate(calc(-50% + ${x.toFixed(1)}px), calc(-50% + ${y.toFixed(1)}px))`;
  }

  /**
   * A button that holds its key while a finger is on it. It captures the
   * pointer, so a thumb that slides off still holds it and the release lands
   * here. The key is chosen when the finger goes down and let go as that key,
   * so a player who gets out with Horn held does not leave the horn stuck.
   */
  private buildButton(spec: ButtonSpec): Button {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `touch-key ${spec.place}`;
    const button: Button = { spec, el, pointer: -1, code: '' };
    el.addEventListener('pointerdown', (event) => {
      if (button.pointer >= 0) return;
      el.setPointerCapture(event.pointerId);
      button.pointer = event.pointerId;
      button.code = this.driving ? spec.drive : spec.foot;
      this.keyboard.press(button.code);
      el.classList.add('touch-key-held');
    });
    const drop = (event: PointerEvent): void => {
      if (button.pointer === event.pointerId) this.release(button);
    };
    el.addEventListener('pointerup', drop);
    el.addEventListener('pointercancel', drop);
    // A long press would open the page's own menu over the game.
    el.addEventListener('contextmenu', (event) => event.preventDefault());
    return button;
  }

  private release(button: Button): void {
    if (button.code !== '') this.keyboard.release(button.code);
    button.pointer = -1;
    button.code = '';
    button.el.classList.remove('touch-key-held');
  }
}

function tapButton(text: string, place: string, action: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `touch-key ${place}`;
  el.textContent = text;
  el.addEventListener('click', action);
  return el;
}
