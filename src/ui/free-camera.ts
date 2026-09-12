/**
 * The mouse half of the developer free camera. `render/free-camera.ts` is
 * where it stands and where it looks; this is what the browser tells it.
 *
 * The pointer is locked while the camera is detached, so the mouse reports a
 * movement rather than a place and the view can turn without end. Leaving the
 * lock does not give the camera back: the browser takes the lock away on
 * Escape and whenever the window loses focus, and a camera that dropped back to
 * the player there would end a flight on a key the player never meant for it.
 * The camera is detached and given back by {@link FREE_CAMERA_KEY} alone. While
 * it is detached without the lock the keys still fly it and the mouse does
 * nothing; a click on the canvas asks for the lock again.
 *
 * The hint over the canvas says which of those two states the camera is in and
 * which key ends the flight, because nothing else on screen would say so.
 *
 * `docs/dev-tooling.md` holds the keys. The movement keys are sampled by
 * `Keyboard.freeCamera`, because `keyboard.ts` is where a key is read.
 */
import type { PerspectiveCamera } from 'three';
import { FreeCamera } from '../render/free-camera.ts';

/** The key that detaches the camera and gives it back. */
export const FREE_CAMERA_KEY = 'Backquote';

/** Pointer lock, the mouse look and the wheel, around one {@link FreeCamera}. */
export class FreeCameraControls {
  readonly camera = new FreeCamera();
  private readonly canvas: HTMLCanvasElement;
  private readonly hint: HTMLElement;
  private on = false;
  private locked = false;
  private shownHint = '';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.hint = document.createElement('div');
    this.hint.className = 'free-camera-hint';
    this.hint.hidden = true;
    document.body.append(this.hint);
    canvas.addEventListener('mousemove', (event) => {
      if (this.locked) this.camera.look(event.movementX, event.movementY);
    });
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.on) return;
        // The page would scroll otherwise, and the notch is what sets the speed.
        event.preventDefault();
        this.camera.scaleSpeed(event.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );
    // The lock is asked for on a click, because the browser grants it only to a
    // gesture, and it refuses one for about a second after Escape took it away.
    canvas.addEventListener('mousedown', () => {
      if (this.on && !this.locked) this.lock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.showHint();
    });
  }

  /** True while the keys drive the camera and the player is given nothing. */
  get detached(): boolean {
    return this.on;
  }

  /**
   * Detach the camera from the player, or give it back. It takes over from
   * where the game camera stands, so the first frame of the flight is the frame
   * that was on screen.
   */
  toggle(from: PerspectiveCamera): void {
    if (this.on) {
      this.release();
      return;
    }
    this.camera.from(from);
    this.on = true;
    this.showHint();
    this.lock();
  }

  /** Give the camera back to the player and let the pointer go. */
  release(): void {
    this.on = false;
    this.showHint();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /**
   * Ask for the lock. A browser that refuses it — too soon after Escape, or
   * because the click was not a gesture it trusts — leaves the flight running
   * with the keys alone, so the rejection is nothing to report.
   */
  private lock(): void {
    void Promise.resolve(this.canvas.requestPointerLock() as unknown).catch(() => {});
  }

  /** The line over the canvas, written only when it changes. */
  private showHint(): void {
    const text = !this.on
      ? ''
      : this.locked
        ? 'Free camera — press ` to return to the player'
        : 'Free camera — click to look around, ` to return to the player';
    if (text === this.shownHint) return;
    this.shownHint = text;
    this.hint.hidden = text === '';
    if (text !== '') this.hint.textContent = text;
  }
}
