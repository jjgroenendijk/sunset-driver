/**
 * The mouse half of the developer free camera. `render/free-camera.ts` is
 * where it stands and where it looks; this is what the browser tells it.
 *
 * The pointer is locked while the camera is detached, so the mouse reports a
 * movement rather than a place and the view can turn without end. Leaving the
 * lock — pressing Escape, or the window losing focus — gives the camera back to
 * the player, so there is no way to be left flying with no pointer.
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
  private on = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('mousemove', (event) => {
      if (this.on) this.camera.look(event.movementX, event.movementY);
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
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== this.canvas) this.on = false;
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
    void this.canvas.requestPointerLock();
  }

  /** Give the camera back to the player and let the pointer go. */
  release(): void {
    this.on = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
}
