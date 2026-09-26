/**
 * The pointer lock of the chase views (spec section 10.7): a lock the browser
 * takes away opens the pause menu, a lock the game lets go does not, and
 * Resume asks for it again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FollowCamera } from '../../../src/render/camera/camera.ts';
import { MouseLook } from '../../../src/ui/input/mouse-look.ts';

type Listener = () => void;

/** A document with just enough of pointer lock for `MouseLook`. */
class FakeDocument {
  pointerLockElement: unknown = null;
  readonly listeners: Listener[] = [];
  readonly body = { append: (): void => {} };
  createElement(): object {
    return { hidden: true, className: '', textContent: '' };
  }
  addEventListener(type: string, listener: Listener): void {
    if (type === 'pointerlockchange') this.listeners.push(listener);
  }
  /** Hand the lock to `element`, or take it away, and say so. */
  change(element: unknown): void {
    this.pointerLockElement = element;
    for (const listener of this.listeners) listener();
  }
  exitPointerLock(): void {
    this.change(null);
  }
}

let doc: FakeDocument;
let asked = 0;
const canvas = {
  addEventListener: (): void => {},
  requestPointerLock: (): Promise<void> => {
    asked++;
    doc.change(canvas);
    return Promise.resolve();
  },
};
const camera = { look: (): void => {} } as unknown as FollowCamera;

/** A mouse look in a chase view, holding the lock it asked for. */
function locked(): { look: MouseLook; lost: () => number } {
  const look = new MouseLook(canvas as unknown as HTMLCanvasElement, camera);
  let lost = 0;
  look.onLost = () => lost++;
  look.update(true, false);
  look.lock();
  return { look, lost: () => lost };
}

beforeEach(() => {
  doc = new FakeDocument();
  asked = 0;
  (globalThis as { document?: unknown }).document = doc;
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe('the pointer lock of the chase views', () => {
  it('opens the pause menu when the browser takes the lock away', () => {
    const { lost } = locked();
    doc.change(null);
    expect(lost()).toBe(1);
  });

  it('does not open it when the game lets the lock go for the map or a menu', () => {
    const { look, lost } = locked();
    look.update(false, false);
    expect(doc.pointerLockElement).toBeNull();
    expect(lost()).toBe(0);
  });

  it('does not open it when the free camera gives its own lock back', () => {
    const { look, lost } = locked();
    look.update(true, true);
    doc.change(null);
    expect(lost()).toBe(0);
  });

  it('asks for the lock again on Resume, only when the view under the menu wants it', () => {
    const { look } = locked();
    doc.change(null);
    look.update(false, false, true);
    look.resume();
    expect(asked).toBe(2);
    doc.change(null);
    look.update(false, false, false);
    look.resume();
    expect(asked).toBe(2);
  });
});
