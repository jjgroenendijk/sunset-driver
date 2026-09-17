import type { FreeCameraInput } from '../render/free-camera.ts';
import type { InputFrame } from '../sim/input.ts';

/**
 * How many rows of a panel the number keys reach, which is how many a panel
 * shows: the metro's destinations (spec section 13.3) and a shop's counter
 * (spec section 16.1) are both read off these keys.
 */
export const CHOICE_KEYS = 9;

/**
 * Keyboard state sampled once per simulation tick into an InputFrame.
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
  }

  private is(code: string): boolean {
    return this.down.has(code);
  }

  sample(): InputFrame {
    // One edge of the number keys, read once and handed to both panels that
    // take them: the metro of spec section 13.3 and the shop counters of 16.1.
    // A player inside a shop may not take the metro, so only one can act on it.
    const chosen = this.choice();
    // The sprint key doubles as the sell key at a dealer's corner (spec section
    // 16.2): a number alone buys the good, and the same number with it held
    // sells the holding. A player standing still to deal is not sprinting.
    const selling = this.is('ShiftLeft') || this.is('ShiftRight');
    const forward = this.is('KeyW') || this.is('ArrowUp');
    const back = this.is('KeyS') || this.is('ArrowDown');
    const left = this.is('KeyA') || this.is('ArrowLeft');
    const right = this.is('KeyD') || this.is('ArrowRight');
    return {
      throttle: (forward ? 1 : 0) - (back ? 1 : 0),
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      handbrake: this.is('Space'),
      horn: this.is('KeyH'),
      sprint: selling,
      jump: this.is('Space'),
      interact: this.is('KeyE'),
      fire: this.is('KeyF'),
      aim: this.is('KeyQ'),
      reload: this.is('KeyR'),
      cycle: this.is('KeyC'),
      station: this.dial(),
      travel: chosen,
      buy: chosen,
      trade: selling ? -chosen : chosen,
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
