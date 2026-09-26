/**
 * The mouse look of the chase views (spec section 10.7): pointer lock on the
 * game's canvas, and the mouse's movement handed to the game camera.
 *
 * The lock is asked for when the view key steps into a chase view, and on a
 * click on the canvas while a chase view has no lock. The browser grants it
 * only to a key press or a click. The click that takes the lock is spent on
 * it, so it does not also fire. The lock is let go when the view goes back to
 * top down, and when a menu, the map or a shop counter wants the pointer.
 *
 * The browser keeps the Escape that takes the lock away, so the page never sees
 * that key. A lock taken away while this still wants it — by Escape, or by a
 * switch to another window — therefore calls `onLost`, which opens the pause
 * menu as the key would have. Resume asks for the lock again (`resume`).
 *
 * The developer free camera of `free-camera.ts` locks the same canvas. While
 * it is detached it owns the movement, and this hands none to the camera.
 *
 * A touch screen has no lock and no mouse. There a finger dragged over the
 * canvas turns the first person view instead; the stick and the buttons are
 * elements of their own over it. A tap on a counter's row is not a drag on the
 * canvas, so a counter leaves the drag on: it is how the room is seen past it.
 */
import type { FollowCamera } from '../../render/camera/camera.ts';
import { TOUCH_LOOK_GAIN } from './touch.ts';

export class MouseLook {
  private readonly canvas: HTMLCanvasElement;
  private readonly hint: HTMLElement;
  /** True while the frame says a chase view is on screen and nothing wants the pointer. */
  private wanted = false;
  /** True while the camera is detached, so the movement is the free camera's. */
  private flying = false;
  private locked = false;
  /** True while the lock held is one this asked for, and the view still wants it. */
  private asked = false;
  /** True while a chase view is on screen and only the pause menu wants the pointer. */
  private ready = false;
  /** Called when the browser took away a lock the view still wants. */
  onLost: (() => void) | null = null;
  private shownHint = '';
  /** A touch screen has no lock to ask for, so it never wants one. */
  private readonly touch: boolean;
  /** The finger dragging the view on a touch screen, and where it was last. */
  private finger: { id: number; x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement, camera: FollowCamera, touch = false) {
    this.canvas = canvas;
    this.touch = touch;
    this.hint = document.createElement('div');
    this.hint.className = 'free-camera-hint';
    this.hint.hidden = true;
    document.body.append(this.hint);
    canvas.addEventListener('mousemove', (event) => {
      if (this.locked && this.wanted && !this.flying) camera.look(event.movementX, event.movementY);
    });
    // In the capture phase, so the click that asks for the lock is taken
    // before `keyboard.ts` reads it as a shot.
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType !== 'mouse' || !this.wanted || this.flying || this.locked) return;
        event.stopImmediatePropagation();
        this.lock();
      },
      { capture: true },
    );
    if (touch) this.bindDrag(canvas, camera);
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked && this.asked && this.wanted && !this.flying) this.onLost?.();
      if (!this.locked) this.asked = false;
      this.showHint();
    });
  }

  /** True while the mouse, or on a touch screen a drag, turns the view. */
  get active(): boolean {
    return (this.locked || this.touch) && this.wanted && !this.flying;
  }

  /**
   * Say, once a frame, whether a chase view is on screen with nothing over it,
   * whether the pause menu is the only thing over it, and whether the free
   * camera is detached. A lock this holds is let go when the view no longer
   * wants it, and that release is not a lost lock. `dragged` is what a touch
   * screen reads instead of `wanted`: a first person view with no menu over it.
   */
  update(wanted: boolean, flying: boolean, paused = false, dragged = false): void {
    this.wanted = this.touch ? dragged : wanted;
    this.ready = (wanted || paused) && !this.touch;
    this.flying = flying;
    if (!this.wanted || flying) {
      this.asked = false;
      this.finger = null;
    }
    if (!wanted && !flying && this.locked) document.exitPointerLock();
    this.showHint();
  }

  /**
   * Ask for the lock. The view key calls this as it steps into a chase view,
   * since a key press is a gesture the browser trusts. A refusal — too soon
   * after Escape took the lock away — leaves the click to ask again.
   */
  lock(): void {
    if (this.locked || this.touch) return;
    this.asked = true;
    void Promise.resolve(this.canvas.requestPointerLock() as unknown).catch(() => {});
  }

  /**
   * The pause menu closed on a press of Resume or Escape: ask for the lock
   * again if the view under the menu wants it. The press is a gesture the
   * browser trusts, so no click is needed. A refusal leaves the hint up.
   */
  resume(): void {
    if (this.ready && !this.flying) this.lock();
  }

  /**
   * One finger on the canvas turns the view as the mouse would, faster by
   * `TOUCH_LOOK_GAIN`, since a thumb has only the screen to cross. A second
   * finger is left alone.
   */
  private bindDrag(canvas: HTMLCanvasElement, camera: FollowCamera): void {
    canvas.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' || this.finger || !this.active) return;
      canvas.setPointerCapture(event.pointerId);
      this.finger = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointermove', (event) => {
      const finger = this.finger;
      if (finger?.id !== event.pointerId) return;
      if (this.active) camera.look((event.clientX - finger.x) * TOUCH_LOOK_GAIN, (event.clientY - finger.y) * TOUCH_LOOK_GAIN);
      finger.x = event.clientX;
      finger.y = event.clientY;
    });
    const drop = (event: PointerEvent): void => {
      if (this.finger?.id === event.pointerId) this.finger = null;
    };
    canvas.addEventListener('pointerup', drop);
    canvas.addEventListener('pointercancel', drop);
  }

  /** The line over the canvas that says a click turns the mouse look on, written only when it changes. */
  private showHint(): void {
    const text = this.wanted && !this.flying && !this.locked && !this.touch ? 'Click to look around with the mouse' : '';
    if (text === this.shownHint) return;
    this.shownHint = text;
    this.hint.hidden = text === '';
    if (text !== '') this.hint.textContent = text;
  }
}
