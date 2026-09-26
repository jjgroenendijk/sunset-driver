import { describe, expect, it } from 'vitest';
import { Keyboard } from '../../../src/ui/input/keyboard.ts';

/** A mouse event with the button that changed and the buttons now down. */
function mouse(type: string, button: number, buttons: number): Event {
  return Object.assign(new Event(type), { pointerType: 'mouse', button, buttons });
}

/** The mouse buttons of spec section 11.5: left fires, right aims, and the two together. */
describe('the mouse buttons', () => {
  it('fires with the left button while the right one is held', () => {
    const page = new EventTarget();
    const canvas = new EventTarget();
    const keyboard = new Keyboard(page as unknown as Window);
    keyboard.listenMouse(canvas as unknown as HTMLCanvasElement);
    canvas.dispatchEvent(mouse('pointerdown', 2, 2));
    expect(keyboard.sample()).toMatchObject({ aim: true, fire: false });
    // The browser sends no second pointerdown: a chorded press is a move.
    canvas.dispatchEvent(mouse('pointermove', 0, 3));
    expect(keyboard.sample()).toMatchObject({ aim: true, fire: true });
    page.dispatchEvent(mouse('pointermove', 0, 2));
    expect(keyboard.sample()).toMatchObject({ aim: true, fire: false });
    page.dispatchEvent(mouse('pointerup', 2, 0));
    expect(keyboard.sample()).toMatchObject({ aim: false, fire: false });
  });

  it('never presses a button off the canvas, and ignores a finger', () => {
    const page = new EventTarget();
    const canvas = new EventTarget();
    const keyboard = new Keyboard(page as unknown as Window);
    keyboard.listenMouse(canvas as unknown as HTMLCanvasElement);
    page.dispatchEvent(mouse('pointermove', 0, 1));
    expect(keyboard.sample().fire).toBe(false);
    canvas.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerType: 'touch', button: 0, buttons: 1 }));
    expect(keyboard.sample().fire).toBe(false);
  });
});
