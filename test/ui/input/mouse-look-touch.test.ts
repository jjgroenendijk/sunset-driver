/**
 * The drag that turns the first person view on a touch screen, which has no
 * pointer lock: one finger on the canvas turns the camera, and nothing else
 * does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FollowCamera } from '../../../src/render/camera/camera.ts';
import { MouseLook } from '../../../src/ui/input/mouse-look.ts';
import { TOUCH_LOOK_GAIN } from '../../../src/ui/input/touch.ts';

type Handler = (event: Partial<PointerEvent>) => void;

/** A canvas that keeps its listeners, so a test can move a finger over it. */
function fakeCanvas(): { canvas: HTMLCanvasElement; fire: (type: string, event: Partial<PointerEvent>) => void } {
  const handlers: [string, Handler][] = [];
  const canvas = {
    addEventListener: (type: string, handler: Handler) => handlers.push([type, handler]),
    setPointerCapture: (): void => {},
    requestPointerLock: (): Promise<void> => Promise.resolve(),
  };
  const fire = (type: string, event: Partial<PointerEvent>): void => {
    for (const [t, handler] of handlers) if (t === type) handler({ stopImmediatePropagation: () => {}, ...event });
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, fire };
}

/** A touch look over a fake canvas, and every turn handed to the camera. */
function touchLook(): { look: MouseLook; fire: ReturnType<typeof fakeCanvas>['fire']; turns: number[][] } {
  const turns: number[][] = [];
  const camera = { look: (dx: number, dy: number) => turns.push([dx, dy]) } as unknown as FollowCamera;
  const { canvas, fire } = fakeCanvas();
  return { look: new MouseLook(canvas, camera, true), fire, turns };
}

/** Drag one finger 10 px right and 5 px down. */
function drag(fire: ReturnType<typeof fakeCanvas>['fire']): void {
  fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100 });
  fire('pointermove', { pointerType: 'touch', pointerId: 1, clientX: 110, clientY: 105 });
  fire('pointerup', { pointerType: 'touch', pointerId: 1 });
}

beforeEach(() => {
  (globalThis as { document?: unknown }).document = {
    body: { append: (): void => {} },
    createElement: (): object => ({ hidden: true, className: '', textContent: '' }),
    addEventListener: (): void => {},
  };
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe('the touch drag of the first person view', () => {
  it('turns the camera by the drag, faster than a mouse pixel', () => {
    const { look, fire, turns } = touchLook();
    look.update(false, false, false, true);
    expect(look.active).toBe(true);
    drag(fire);
    expect(turns).toEqual([[10 * TOUCH_LOOK_GAIN, 5 * TOUCH_LOOK_GAIN]]);
  });

  it('does nothing outside first person, or while the free camera flies', () => {
    const { look, fire, turns } = touchLook();
    look.update(true, false, false, false);
    expect(look.active).toBe(false);
    drag(fire);
    look.update(false, true, false, true);
    expect(look.active).toBe(false);
    drag(fire);
    expect(turns).toEqual([]);
  });
});
