/**
 * The on-screen controls that fly the free camera with two thumbs.
 *
 * A phone has no keyboard to hold `W` on and no pointer lock to turn the view
 * with — iOS Safari has never had one — so the flight of `docs/dev-tooling.md`
 * is given a pad instead: a stick under the left thumb that moves the camera,
 * the whole screen behind it as a surface the right thumb turns the view on, a
 * pinch that sets the speed, and buttons that rise, fall and go fast.
 *
 * The arithmetic is in `touch.ts` and tested there. This is the browser half:
 * which finger is doing what, and where the knob is drawn.
 *
 * Every finger is a pointer event. iOS Safari reports touches as pointers, so
 * nothing here reads `TouchEvent`, and `touch-action: none` in `touch.css` is
 * what stops the page scrolling and zooming under the thumbs instead.
 */
import { SPEED_STEP, type FreeCamera, type FreeCameraInput } from '../render/free-camera.ts';
import { pinchNotches, stickVector, TOUCH_LOOK_GAIN } from './touch.ts';

/** A finger the pad is following, and where it was last seen. */
interface Finger {
  id: number;
  x: number;
  y: number;
}

/** A round button of the pad, and what holding it asks for. */
interface Key {
  el: HTMLButtonElement;
  /** The pointer holding it down, or -1. A finger that slides off still holds it. */
  held: number;
}

export class TouchFly {
  readonly root: HTMLElement;
  private readonly camera: FreeCamera;
  private readonly knob: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly up: Key;
  private readonly down: Key;
  private readonly fastKey: HTMLButtonElement;
  /** The thumb on the stick, where it went down, and where it has reached. */
  private stick: { id: number; fromX: number; fromY: number; x: number; y: number } | null = null;
  /** The fingers turning the view, in the order they landed. Two of them pinch. */
  private look: Finger[] = [];
  /** How far apart the two pinching fingers were when the pinch was last read. */
  private pinch = 0;
  private fast = false;
  private shownSpeed = '';

  constructor(parent: HTMLElement, camera: FreeCamera) {
    this.camera = camera;
    this.root = document.createElement('div');
    this.root.className = 'touch-fly';
    this.root.hidden = true;

    const surface = document.createElement('div');
    surface.className = 'touch-look';
    surface.setAttribute('aria-label', 'Drag to look around, pinch to change the speed');
    this.bindLook(surface);

    const pad = document.createElement('div');
    pad.className = 'touch-stick';
    pad.setAttribute('aria-label', 'Drag to fly');
    this.knob = document.createElement('span');
    this.knob.className = 'touch-knob';
    pad.append(this.knob);
    this.bindStick(pad);

    // The three keys the right hand reaches without leaving the looking
    // surface: they sit in a column against the edge it drags on.
    this.up = this.buildKey('▲', 'Rise');
    this.down = this.buildKey('▼', 'Descend');
    this.fastKey = this.buildToggle();
    const side = document.createElement('div');
    side.className = 'touch-side';
    side.append(this.up.el, this.down.el, this.fastKey);

    this.readout = document.createElement('div');
    this.readout.className = 'touch-readout';

    this.root.append(surface, pad, side, this.readout);
    parent.append(this.root);
  }

  /** Put the pad on screen, or take it off and let every finger go. */
  set shown(on: boolean) {
    this.root.hidden = !on;
    if (!on) this.forget();
  }

  /**
   * What the thumbs are asking of the camera this frame, over the keys a
   * keyboard would have contributed. A phone sends no keys, and a tablet with
   * one attached may use both.
   */
  input(keys: FreeCameraInput): FreeCameraInput {
    if (this.root.hidden) return keys;
    const push = this.stick ? stickVector(this.stick.x - this.stick.fromX, this.stick.y - this.stick.fromY) : null;
    const lift = (this.up.held >= 0 ? 1 : 0) - (this.down.held >= 0 ? 1 : 0);
    this.showSpeed();
    return {
      forward: clampAxis(keys.forward + (push?.y ?? 0)),
      right: clampAxis(keys.right + (push?.x ?? 0)),
      up: clampAxis(keys.up + lift),
      fast: keys.fast || this.fast,
    };
  }

  /** Let go of every finger, so nothing is left held when the pad goes away. */
  private forget(): void {
    this.stick = null;
    this.look = [];
    this.pinch = 0;
    this.moveKnob();
    this.releaseKey(this.up);
    this.releaseKey(this.down);
  }

  /**
   * The stick. It takes its centre from wherever the thumb lands rather than
   * from the middle of the pad, so the thumb does not have to find a spot it
   * cannot see under itself.
   */
  private bindStick(pad: HTMLElement): void {
    pad.addEventListener('pointerdown', (event) => {
      if (this.stick) return;
      pad.setPointerCapture(event.pointerId);
      this.stick = { id: event.pointerId, fromX: event.clientX, fromY: event.clientY, x: event.clientX, y: event.clientY };
      this.moveKnob();
    });
    pad.addEventListener('pointermove', (event) => {
      if (this.stick?.id !== event.pointerId) return;
      this.stick.x = event.clientX;
      this.stick.y = event.clientY;
      this.moveKnob();
    });
    const drop = (event: PointerEvent): void => {
      if (this.stick?.id !== event.pointerId) return;
      this.stick = null;
      this.moveKnob();
    };
    pad.addEventListener('pointerup', drop);
    pad.addEventListener('pointercancel', drop);
  }

  /** The knob, drawn where the thumb has pushed the stick to. */
  private moveKnob(): void {
    const push = this.stick ? stickVector(this.stick.x - this.stick.fromX, this.stick.y - this.stick.fromY) : null;
    const x = (push?.x ?? 0) * KNOB_TRAVEL;
    const y = -(push?.y ?? 0) * KNOB_TRAVEL;
    this.knob.style.transform = `translate(calc(-50% + ${x.toFixed(1)}px), calc(-50% + ${y.toFixed(1)}px))`;
  }

  /**
   * The looking surface. One finger turns the view; a second one on the same
   * surface makes it a pinch, which sets the speed and turns nothing, because
   * a pinch that also swung the camera would leave the view somewhere else
   * every time the speed was changed.
   */
  private bindLook(surface: HTMLElement): void {
    surface.addEventListener('pointerdown', (event) => {
      if (this.look.length >= 2) return;
      surface.setPointerCapture(event.pointerId);
      this.look.push({ id: event.pointerId, x: event.clientX, y: event.clientY });
      this.pinch = this.gap();
    });
    surface.addEventListener('pointermove', (event) => {
      const finger = this.look.find((f) => f.id === event.pointerId);
      if (!finger) return;
      const dx = event.clientX - finger.x;
      const dy = event.clientY - finger.y;
      finger.x = event.clientX;
      finger.y = event.clientY;
      if (this.look.length === 1) {
        this.camera.look(dx * TOUCH_LOOK_GAIN, dy * TOUCH_LOOK_GAIN);
        return;
      }
      const gap = this.gap();
      this.camera.scaleSpeed(pinchNotches(this.pinch, gap, SPEED_STEP));
      this.pinch = gap;
    });
    const drop = (event: PointerEvent): void => {
      this.look = this.look.filter((f) => f.id !== event.pointerId);
      this.pinch = this.gap();
    };
    surface.addEventListener('pointerup', drop);
    surface.addEventListener('pointercancel', drop);
  }

  /** How far apart the two pinching fingers are, or 0 while there are not two. */
  private gap(): number {
    const [a, b] = this.look;
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  /**
   * A button that acts while it is held. `click` would not do: a thumb has to
   * be able to rest on Rise while the other one turns the view.
   */
  private buildKey(glyph: string, label: string): Key {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'touch-key';
    el.textContent = glyph;
    el.setAttribute('aria-label', label);
    const key: Key = { el, held: -1 };
    el.addEventListener('pointerdown', (event) => {
      if (key.held >= 0) return;
      // The capture is what makes a thumb that slides off the button keep
      // holding it, and what guarantees the release lands here.
      el.setPointerCapture(event.pointerId);
      key.held = event.pointerId;
      el.classList.add('touch-key-held');
    });
    const drop = (event: PointerEvent): void => {
      if (key.held !== event.pointerId) return;
      this.releaseKey(key);
    };
    el.addEventListener('pointerup', drop);
    el.addEventListener('pointercancel', drop);
    return key;
  }

  private releaseKey(key: Key): void {
    key.held = -1;
    key.el.classList.remove('touch-key-held');
  }

  /** Fast is a toggle rather than a hold: both thumbs are already busy. */
  private buildToggle(): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'touch-key touch-fast';
    el.textContent = 'Fast';
    el.setAttribute('aria-pressed', 'false');
    el.addEventListener('click', () => {
      this.fast = !this.fast;
      el.setAttribute('aria-pressed', String(this.fast));
      el.classList.toggle('touch-key-held', this.fast);
    });
    return el;
  }

  /** The speed, written only when the number on screen changes. */
  private showSpeed(): void {
    const text = `${Math.round(this.camera.speed)} m/s`;
    if (text === this.shownSpeed) return;
    this.shownSpeed = text;
    this.readout.textContent = text;
  }
}

/** Pixels the knob may travel from the middle of the pad it is drawn in. */
const KNOB_TRAVEL = 30;

function clampAxis(value: number): number {
  return Math.min(1, Math.max(-1, value));
}
