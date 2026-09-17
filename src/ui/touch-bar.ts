/**
 * The buttons a session is driven from on a phone, and the few things a page
 * has to say to a touch browser before any of it works.
 *
 * A phone reaches none of the keys `controls.ts` lists, so the three that open
 * something on screen — the pause menu, the map and the free camera — are put
 * in a corner as buttons. Everything else on the street stays a key: a phone is
 * for looking at the city (`docs/menus.md`), not for driving through it.
 */
import type { PerspectiveCamera } from 'three';
import type { FreeCameraControls } from './free-camera.ts';

/** What the bar's three buttons do, and how it reads the flight's state back. */
export interface TouchActions {
  menu(): void;
  map(): void;
  fly(): void;
  flying(): boolean;
}

/**
 * Tell the page it is being used with a finger.
 *
 * `body.touch` is what `touch.css` hangs the larger tap targets and the hidden
 * key hints on. The three `gesture*` events are Safari's own pinch zoom of the
 * whole page: `touch-action` holds off the scrolling and the double-tap, and
 * these are what is left. A page that zooms under the thumbs puts the canvas
 * half off screen with no way back.
 */
export function markTouchUi(doc: Document): void {
  doc.body.classList.add('touch');
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    doc.addEventListener(name, (event) => event.preventDefault(), { passive: false });
  }
}

/** Three round buttons in a corner, over the canvas. */
export class TouchBar {
  private readonly fly: HTMLButtonElement;
  private readonly actions: TouchActions;

  constructor(parent: HTMLElement, actions: TouchActions) {
    this.actions = actions;
    const root = document.createElement('nav');
    root.className = 'touch-bar';
    root.setAttribute('aria-label', 'Game controls');
    this.fly = tap('Fly', () => actions.fly());
    root.append(tap('Menu', () => actions.menu()), tap('Map', () => actions.map()), this.fly);
    parent.append(root);
    this.sync();
  }

  /**
   * Write the flight's state onto the button. The pad of `touch-fly.ts` has a
   * Done button of its own, so the flight can end without this being pressed,
   * and the label would otherwise still offer what is already happening.
   */
  sync(): void {
    const flying = this.actions.flying();
    this.fly.textContent = flying ? 'Land' : 'Fly';
    this.fly.classList.toggle('touch-key-held', flying);
  }
}

function tap(text: string, action: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'touch-key touch-bar-key';
  el.textContent = text;
  el.addEventListener('click', action);
  return el;
}

/**
 * Raise the bar over a session and keep its Fly button in step with the
 * flight, however the flight was started or ended.
 */
export function mountTouchBar(
  parent: HTMLElement,
  free: FreeCameraControls,
  camera: PerspectiveCamera,
  actions: { menu(): void; map(): void },
): void {
  const bar = new TouchBar(parent, {
    ...actions,
    fly: () => free.toggle(camera),
    flying: () => free.detached,
  });
  free.onChange = () => bar.sync();
}
