import type { FreeCameraInput } from '../render/free-camera.ts';
import type { InputFrame } from '../sim/input.ts';

/**
 * How many rows of a panel the number keys reach, which is how many a panel
 * shows: the metro's destinations (spec section 13.3) and a shop's counter
 * (spec section 16.1) are both read off these keys.
 */
export const CHOICE_KEYS = 9;

/** The codes the mouse buttons are kept under beside the keys. */
const FIRE_BUTTON = 'Mouse0';
const AIM_BUTTON = 'Mouse2';

/** Each mouse button kept, and its bit in a pointer event's `buttons`. */
const MOUSE_BITS: readonly (readonly [string, number])[] = [
  [FIRE_BUTTON, 1],
  [AIM_BUTTON, 2],
];

/**
 * Pixels of wheel travel one weapon step takes. A mouse notch is about 100,
 * and a trackpad sends a swipe as many small events, so they are added up.
 */
const WHEEL_STEP = 100;
/** Pixels a wheel event in lines or in pages counts as. */
const WHEEL_LINE = 33;
const WHEEL_PAGE = 800;

/**
 * The walking axes turned by a view's yaw. Up the screen is `-z` turned by
 * `yaw`, and the walk of `walker-body.ts` reads the steering axis as `+x` and
 * the forward axis as `-z`, so the pair is turned into those map axes. A yaw
 * of 0 hands the keys through as they are.
 */
export function turned(throttle: number, steer: number, yaw: number): { throttle: number; steer: number } {
  if (yaw === 0) return { throttle, steer };
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { throttle: steer * s + throttle * c, steer: steer * c - throttle * s };
}

/**
 * Keyboard and mouse state sampled once per simulation tick into an InputFrame.
 * `controls.ts` is the one list of the bindings; this must stay in step with it.
 *
 * `freeCamera` is the one exception: those keys drive the developer camera of
 * `docs/dev-tooling.md` and are read only while it is detached, which is also
 * why they are free to reuse the keys the player drives with.
 */
export class Keyboard {
  private readonly down = new Set<string>();
  /** The number key a choice was last read from, so holding it asks once. */
  private choiceHeld = '';
  /** Whether a dial key was down last tick, so a held key turns the dial once. */
  private stationHeld = 0;
  /** The map point under the mouse, which the frame writes; undefined while it is off the map. */
  private point: { x: number; y: number } | undefined = undefined;
  /**
   * True while a shop counter is open. The arrow keys then walk its rows and
   * `Enter` buys one, so they leave the player where they stand; `W A S D`
   * still walk. The frame writes it.
   */
  menu = false;
  /** Which of the counter's keys were down last frame, so a held key moves the cursor once. */
  private menuHeld = { up: false, down: false, enter: false };
  /**
   * The heading of the view, as a yaw: 0 while the camera looks north. The
   * walking keys are turned by it, so `W` walks up the screen whichever way
   * the camera faces. The frame writes it, and 0 while the player drives.
   */
  turn = 0;
  /** A row picked off a panel with the mouse or `Enter`, handed to the next sample. */
  private picked = 0;
  /** A press of the interact key made on a panel, handed to the next sample. */
  private tapped = false;
  /** Wheel travel not yet taken as a weapon step, and the steps waiting for the next sample. */
  private wheel = 0;
  private steps = 0;

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      // A key typed into a text box is text, not a control: a seed or a save
      // being typed must not drive the car, and must keep its spaces and arrows.
      if (e.repeat || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      this.down.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
    // A button let go anywhere is let go, even off the canvas it went down on.
    target.addEventListener('pointerup', (e) => this.buttons(e, false));
    target.addEventListener('pointermove', (e) => {
      if (e.button !== -1) this.buttons(e, false);
    });
  }

  /**
   * Bring the mouse buttons in step with a pointer event's `buttons`. A press
   * with another button already down fires no `pointerdown`: the browser sends
   * a `pointermove` whose `button` is the one that changed. So both events come
   * here, and the bits say what is down. `press` is false off the canvas, where
   * a button may be let go but not pressed.
   */
  private buttons(e: PointerEvent, press: boolean): void {
    if (e.pointerType !== 'mouse') return;
    for (const [code, bit] of MOUSE_BITS) {
      if ((e.buttons & bit) === 0) this.down.delete(code);
      else if (press) this.down.add(code);
    }
  }

  /**
   * Take the mouse buttons pressed on the game's canvas: the left one fires and
   * the right one aims (spec section 11.5), and no key does either. Only a mouse counts. A finger on a
   * touch screen is the touch pad of `touch.ts`, and a tap must not fire.
   */
  listenMouse(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e) => this.buttons(e, true));
    // A second button pressed while one is held arrives as a move.
    canvas.addEventListener('pointermove', (e) => {
      if (e.button !== -1) this.buttons(e, true);
    });
    // The right button aims, so the page's own menu must not open over the game.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // The wheel steps through the weapons carried: down for the next, up for
    // the one before (spec section 11.6).
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const scale = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? WHEEL_PAGE : 1;
        this.wheel += e.deltaY * scale;
        while (Math.abs(this.wheel) >= WHEEL_STEP) {
          const step = Math.sign(this.wheel);
          this.wheel -= step * WHEEL_STEP;
          // One step waits at a time, so a fast spin does not queue a run of them.
          this.steps = step;
        }
      },
      { passive: false },
    );
  }

  /** Drop the wheel travel not yet taken, while nothing samples the keys. */
  forgetWheel(): void {
    this.wheel = 0;
    this.steps = 0;
  }

  /**
   * Where the mouse points on the map, in map metres, or undefined where it is
   * not over the map. The frame writes it once a frame from the camera, which
   * this class does not know.
   */
  pointAt(x: number, y: number): void {
    this.point = { x, y };
  }

  /** The mouse has left the map. */
  unpoint(): void {
    this.point = undefined;
  }

  private is(code: string): boolean {
    return this.down.has(code);
  }

  /**
   * Buy a row of the counter on screen, counted from 1, as its number key
   * would. A click and `Enter` both come here, so a row past the ninth, which
   * no number key reaches, is bought the same way.
   */
  choose(row: number): void {
    this.picked = row;
  }

  /** Press the interact key once, as the leave button of a panel does. */
  tapInteract(): void {
    this.tapped = true;
  }

  /**
   * The counter's own keys, read once a frame: the step the cursor takes, and
   * whether `Enter` was pressed. Each key counts once however long it is held.
   */
  menuKeys(): { step: number; enter: boolean } {
    const up = this.is('ArrowUp');
    const down = this.is('ArrowDown');
    const enter = this.is('Enter') || this.is('NumpadEnter');
    const held = this.menuHeld;
    const step = (down && !held.down ? 1 : 0) - (up && !held.up ? 1 : 0);
    const pressed = enter && !held.enter;
    this.menuHeld = { up, down, enter };
    return { step, enter: pressed };
  }

  sample(): InputFrame {
    // One edge of the number keys, read once and handed to both panels that
    // take them: the metro of spec section 13.3 and the shop counters of 16.1.
    // A player inside a shop may not take the metro, so only one can act on it.
    const chosen = this.choice();
    // A row picked off the panel is a buy, and only a buy: the metro's list
    // takes no clicks.
    const picked = this.picked;
    this.picked = 0;
    const tapped = this.tapped;
    this.tapped = false;
    const cycle = this.steps;
    this.steps = 0;
    // The sprint key doubles as the sell key at a dealer's corner (spec section
    // 16.2): a number alone buys the good, and the same number with it held
    // sells the holding. A player standing still to deal is not sprinting.
    const selling = this.is('ShiftLeft') || this.is('ShiftRight');
    // Up and down are the counter's while it is open.
    const forward = this.is('KeyW') || (!this.menu && this.is('ArrowUp'));
    const back = this.is('KeyS') || (!this.menu && this.is('ArrowDown'));
    const left = this.is('KeyA') || this.is('ArrowLeft');
    const right = this.is('KeyD') || this.is('ArrowRight');
    const { throttle, steer } = turned((forward ? 1 : 0) - (back ? 1 : 0), (right ? 1 : 0) - (left ? 1 : 0), this.turn);
    return {
      throttle,
      steer,
      handbrake: this.is('Space'),
      horn: this.is('KeyH'),
      sprint: selling,
      jump: this.is('Space'),
      interact: this.is('KeyE') || tapped,
      fire: this.is(FIRE_BUTTON),
      aim: this.is(AIM_BUTTON),
      pointing: this.point !== undefined,
      pointX: this.point?.x ?? 0,
      pointY: this.point?.y ?? 0,
      reload: this.is('KeyR'),
      cycle,
      station: this.dial(),
      travel: chosen,
      buy: picked > 0 ? picked : chosen,
      trade: selling ? -chosen : chosen,
      surrender: this.is('KeyX'),
    };
  }

  /**
   * The turn of the radio dial (spec section 15). A held key turns it once, as
   * the number keys of the metro panel ask once: the dial has ten positions and
   * a level would run round them all in a fifth of a second.
   */
  private dial(): number {
    const turn = (this.is('BracketRight') ? 1 : 0) - (this.is('BracketLeft') ? 1 : 0);
    if (turn === this.stationHeld) return 0;
    this.stationHeld = turn;
    return turn;
  }

  /**
   * The row a number key asks for: a place in the list the panel on screen
   * shows, counted from 1, and 0 for no choice.
   *
   * A held key asks once. A panel lists what the record holds, so the same key
   * held down would leave a player riding the metro line back and forth, or
   * buying the same row of a counter sixty times a second, as long as their
   * finger was on it.
   */
  private choice(): number {
    for (let i = 1; i <= CHOICE_KEYS; i++) {
      const code = `Digit${i}`;
      if (!this.is(code)) continue;
      if (this.choiceHeld === code) return 0;
      this.choiceHeld = code;
      return i;
    }
    this.choiceHeld = '';
    return 0;
  }

  /**
   * The developer free camera's keys: `W A S D` across the camera's own plane,
   * `R` and `F` up and down, `Shift` for the fast speed. Sampled once a frame
   * rather than once a tick, because the camera is render state.
   */
  freeCamera(): FreeCameraInput {
    const forward = this.is('KeyW') || this.is('ArrowUp');
    const back = this.is('KeyS') || this.is('ArrowDown');
    const left = this.is('KeyA') || this.is('ArrowLeft');
    const right = this.is('KeyD') || this.is('ArrowRight');
    return {
      forward: (forward ? 1 : 0) - (back ? 1 : 0),
      right: (right ? 1 : 0) - (left ? 1 : 0),
      up: (this.is('KeyR') ? 1 : 0) - (this.is('KeyF') ? 1 : 0),
      fast: this.is('ShiftLeft') || this.is('ShiftRight'),
    };
  }
}
