/**
 * The mouse over the game's canvas, and what it points at on the map (spec
 * section 11.5).
 *
 * The frame asks this where the pointer stands on the ground once a frame and
 * hands the answer to the keyboard, which samples it into every input frame
 * of the ticks that follow. The pickup under the pointer is found from the
 * same ray, so the two never disagree about where the mouse is.
 */
import { Plane, Raycaster, Vector2, Vector3, type Camera } from 'three';

/**
 * Metres above the player's feet the pointer is laid on: about chest height,
 * where a round flies, so the pointer on a car or a person is the pointer on
 * what the round would meet.
 */
export const AIM_PLANE_HEIGHT = 1.2;

/** A point on the screen, in the page's CSS pixels. */
export interface ScreenPoint {
  x: number;
  y: number;
}

export class PointerAim {
  /** Where the mouse is, in the camera's -1 to 1 frame, and in page pixels. */
  readonly at = new Vector2();
  readonly client: ScreenPoint = { x: 0, y: 0 };
  /** Whether the pointer is over the canvas. */
  over = false;
  /** Whether that pointer is a mouse: a finger on a touch screen aims nothing. */
  mouse = false;
  readonly ray = new Raycaster();
  private readonly canvas: HTMLCanvasElement;
  private readonly plane = new Plane(new Vector3(0, 1, 0), 0);
  private readonly hit = new Vector3();
  private readonly v = new Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('pointermove', (event) => {
      const rect = canvas.getBoundingClientRect();
      this.at.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.client.x = event.clientX;
      this.client.y = event.clientY;
      this.over = true;
      this.mouse = event.pointerType === 'mouse';
    });
    canvas.addEventListener('pointerleave', () => {
      this.over = false;
    });
  }

  /** Cast the ray from the camera through the pointer. Call once a frame, after the camera moved. */
  cast(camera: Camera): void {
    this.ray.setFromCamera(this.at, camera);
  }

  /**
   * The map point the mouse points at, laid on a level {@link AIM_PLANE_HEIGHT}
   * over `height`, or undefined where there is no mouse over the canvas. Read
   * after {@link PointerAim.cast}.
   */
  ground(height: number): { x: number; y: number } | undefined {
    if (!this.over || !this.mouse) return undefined;
    this.plane.constant = -(height + AIM_PLANE_HEIGHT);
    if (this.ray.ray.intersectPlane(this.plane, this.hit) === null) return undefined;
    return { x: this.hit.x, y: this.hit.z };
  }

  /** Where a point of the world, in map metres with `h` its height, is drawn on the page. */
  screenOf(camera: Camera, x: number, h: number, y: number): ScreenPoint {
    const rect = this.canvas.getBoundingClientRect();
    this.v.set(x, h, y).project(camera);
    return {
      x: rect.left + ((this.v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - this.v.y) / 2) * rect.height,
    };
  }

  /** Show or hide the page's own cursor over the canvas, which the crosshair stands in for. */
  hideCursor(hidden: boolean): void {
    const want = hidden ? 'none' : '';
    if (this.canvas.style.cursor !== want) this.canvas.style.cursor = want;
  }
}
