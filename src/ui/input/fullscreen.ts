/**
 * Full screen on a phone.
 *
 * Android Chrome and iPad Safari give any page the Fullscreen API, and a tap
 * on the Full button asks for it. iPhone Safari gives it to a video alone: a
 * page there is full screen only when it is opened from the Home Screen, as a
 * web app, which `manifest.webmanifest` and the `apple-mobile-web-app-*` tags
 * in `index.html` ask for. So on an iPhone the button says how to do that.
 * A page already opened from the Home Screen has nothing to ask for.
 *
 * The decision is {@link fullscreenRoute}, tested without a DOM; the rest is
 * the browser half.
 */

/** What the browser is asked about itself. `readFullscreenProbe` reads it. */
export interface FullscreenProbe {
  /** The Fullscreen API is there and allowed, prefixed or not. */
  api: boolean;
  /** The page runs as a web app from the Home Screen, with no browser around it. */
  standalone: boolean;
}

/**
 * How this browser reaches full screen: through the API, through the Home
 * Screen, or not at all, because it is already there.
 */
export type FullscreenRoute = 'api' | 'home-screen' | 'none';

export function fullscreenRoute(probe: FullscreenProbe): FullscreenRoute {
  if (probe.standalone) return 'none';
  return probe.api ? 'api' : 'home-screen';
}

/** The prefixed names Safari used before the API lost its prefix. */
interface WebkitDocument {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}
interface WebkitElement {
  webkitRequestFullscreen?: () => void;
}

export function readFullscreenProbe(win: Window): FullscreenProbe {
  const doc = win.document as Document & WebkitDocument;
  const nav = win.navigator as Navigator & { standalone?: boolean };
  return {
    api: doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true,
    standalone:
      nav.standalone === true ||
      win.matchMedia('(display-mode: fullscreen)').matches ||
      win.matchMedia('(display-mode: standalone)').matches,
  };
}

/** Whether the page holds the screen now. */
function isFullscreen(doc: Document): boolean {
  const webkit = doc as Document & WebkitDocument;
  return (doc.fullscreenElement ?? webkit.webkitFullscreenElement ?? null) !== null;
}

/**
 * Take the screen, or give it back. It must run inside the tap's own handler:
 * the browser grants full screen only to a gesture.
 */
export function toggleFullscreen(doc: Document): void {
  const webkit = doc as Document & WebkitDocument;
  if (isFullscreen(doc)) {
    if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => undefined);
    else webkit.webkitExitFullscreen?.();
    return;
  }
  const root = doc.documentElement as HTMLElement & WebkitElement;
  if (root.requestFullscreen) void root.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
  else root.webkitRequestFullscreen?.();
}

/** What the iPhone is told, since it has no way to take the screen itself. */
export const HOME_SCREEN_HINT =
  'To play full screen on an iPhone, tap Share, then Add to Home Screen, and open the game from there.';
