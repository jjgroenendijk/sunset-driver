/**
 * The buttons a session is driven from on a phone, and the few things a page
 * has to say to a touch browser before any of it works.
 *
 * A phone reaches none of the keys `controls.ts` lists. The pause menu is a
 * button in the top corner, and a tap on the minimap opens the map
 * (`main.ts`). The free camera and full screen are items of the pause menu,
 * because a player rarely wants them and the corner has little room. While
 * the camera flies, a Land button beside Menu ends the flight. The street
 * itself is played from the pad of `touch-play.ts` (`docs/menus.md`).
 */
import type { PerspectiveCamera } from 'three';
import type { PauseExtra } from '../menus/pause.ts';
import type { FreeCameraControls } from './free-camera.ts';
import {
  fullscreenRoute,
  HOME_SCREEN_HINT,
  readFullscreenProbe,
  toggleFullscreen,
  type FullscreenRoute,
} from './fullscreen.ts';

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

/**
 * The Menu button in a corner, over the canvas, and Land beside it while the
 * camera flies. A button that would do nothing is hidden rather than shown.
 */
class TouchBar {
  private readonly land: HTMLButtonElement;
  private readonly free: FreeCameraControls;

  constructor(parent: HTMLElement, free: FreeCameraControls, camera: PerspectiveCamera, menu: () => void) {
    this.free = free;
    const root = document.createElement('nav');
    root.className = 'touch-bar';
    root.setAttribute('aria-label', 'Game controls');
    this.land = tap('Land', () => free.toggle(camera));
    root.append(this.land, tap('Menu', menu));
    parent.append(root);
    this.sync();
  }

  /** Show Land only while the camera is detached, however the flight began. */
  sync(): void {
    this.land.hidden = !this.free.detached;
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
 * The items a phone adds to the pause menu: the flight, and full screen where
 * the page does not already have it. On an iPhone full screen cannot be taken,
 * so the item shows how to add the game to the Home Screen instead, until the
 * note is tapped away or its time runs out. A session played with the keys
 * gets none: it has a key for each.
 */
export function touchPauseItems(
  touch: boolean,
  parent: HTMLElement,
  free: FreeCameraControls,
  camera: PerspectiveCamera,
): PauseExtra[] {
  if (!touch) return [];
  const items: PauseExtra[] = [{ label: 'Fly over the city', action: () => free.toggle(camera) }];
  const full = fullAction(parent, fullscreenRoute(readFullscreenProbe(window)));
  if (full) items.push({ label: 'Full screen', action: full });
  return items;
}

/** What the Full screen item does, or null where the page already has the screen. */
function fullAction(parent: HTMLElement, route: FullscreenRoute): (() => void) | null {
  if (route === 'none') return null;
  if (route === 'api') return () => toggleFullscreen(document);
  const note = document.createElement('p');
  note.className = 'touch-note';
  note.textContent = HOME_SCREEN_HINT;
  note.hidden = true;
  parent.append(note);
  let timer = 0;
  const hide = (): void => {
    note.hidden = true;
    window.clearTimeout(timer);
  };
  note.addEventListener('click', hide);
  return () => {
    if (!note.hidden) return hide();
    note.hidden = false;
    timer = window.setTimeout(hide, NOTE_MS);
  };
}

/** Milliseconds the Home Screen note stays up untouched. */
const NOTE_MS = 8000;

/** Raise the bar over a session and keep its Land button in step with the flight. */
export function mountTouchBar(
  parent: HTMLElement,
  free: FreeCameraControls,
  camera: PerspectiveCamera,
  menu: () => void,
): void {
  const bar = new TouchBar(parent, free, camera, menu);
  free.onChange = () => bar.sync();
}
