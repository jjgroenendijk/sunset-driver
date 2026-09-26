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
 */
import type { FollowCamera } from '../../render/camera/camera.ts';

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
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked && this.asked && this.wanted && !this.flying) this.onLost?.();
      if (!this.locked) this.asked = false;
      this.showHint();
    });
  }

  /** True while the mouse turns the view. */
  get active(): boolean {
    return this.locked && this.wanted && !this.flying;
  }

  /**
   * Say, once a frame, whether a chase view is on screen with nothing over it,
   * whether the pause menu is the only thing over it, and whether the free
   * camera is detached. A lock this holds is let go when the view no longer
   * wants it, and that release is not a lost lock.
   */
  update(wanted: boolean, flying: boolean, paused = false): void {
    this.wanted = wanted && !this.touch;
    this.ready = (wanted || paused) && !this.touch;
    this.flying = flying;
    if (!this.wanted || flying) this.asked = false;
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

  /** The line over the canvas that says a click turns the mouse look on, written only when it changes. */
  private showHint(): void {
    const text = this.wanted && !this.flying && !this.locked ? 'Click to look around with the mouse' : '';
    if (text === this.shownHint) return;
    this.shownHint = text;
    this.hint.hidden = text === '';
    if (text !== '') this.hint.textContent = text;
  }
}
