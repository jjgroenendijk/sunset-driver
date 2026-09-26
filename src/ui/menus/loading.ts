/**
 * The screen between the title screen and the street (spec section 12).
 *
 * It replaces the one line of text that used to stand there for two seconds
 * with the seed being built, the step being taken and how far through it is.
 * Every step it shows is a real one: the world, the ground under the player,
 * and the shaders the first frame needs. Nothing here guesses at progress.
 *
 * It is opaque, so the title scene behind it is never seen once Start is
 * pressed, and it hands the city over by fading out rather than by
 * disappearing between two frames.
 */

/** Milliseconds the screen takes to fade away. The same number is in `title.css`. */
const FADE_MS = 600;

export class LoadingScreen {
  private readonly root: HTMLElement;
  private readonly step: HTMLElement;
  private readonly fill: HTMLElement;
  /** True where the player asked the browser for less motion; then nothing fades. */
  private readonly still: boolean;

  constructor(parent: HTMLElement, seed: string) {
    this.still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.root = document.createElement('section');
    this.root.className = 'loading';
    this.root.setAttribute('role', 'status');

    const city = document.createElement('p');
    city.className = 'loading-seed';
    city.textContent = `The city of ${seed}`;

    this.step = document.createElement('p');
    this.step.className = 'loading-step';

    const bar = document.createElement('div');
    bar.className = 'loading-bar';
    this.fill = document.createElement('div');
    this.fill.className = 'loading-fill';
    bar.append(this.fill);

    this.root.append(city, this.step, bar);
    parent.append(this.root);
  }

  /** Say what is being done and how far through the whole wait it is, 0 to 1. */
  say(text: string, through: number): void {
    this.step.textContent = text;
    this.fill.style.width = `${Math.round(Math.min(Math.max(through, 0), 1) * 100)}%`;
  }

  /** The session cannot start. The screen says why and stays where it is. */
  fail(text: string): void {
    this.root.classList.add('loading-failed');
    this.step.textContent = text;
    this.fill.style.width = '100%';
  }

  /**
   * Hand the city over: let the first frame of the session be drawn under the
   * screen, then fade the screen off it.
   *
   * The wait for a frame is what makes the fade show the city rather than the
   * black the renderer starts on.
   */
  async reveal(): Promise<void> {
    await nextFrame();
    if (this.still) {
      this.root.remove();
      return;
    }
    this.root.classList.add('loading-gone');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FADE_MS + 100);
      this.root.addEventListener(
        'transitionend',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    this.root.remove();
  }
}

/** Resolve after the browser has painted: the second frame starts once the first is on screen. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
