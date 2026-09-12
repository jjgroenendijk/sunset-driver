import type { FreeCameraInput } from '../render/free-camera.ts';
import type { InputFrame } from '../sim/input.ts';

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

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      if (e.repeat) return;
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
    const forward = this.is('KeyW') || this.is('ArrowUp');
    const back = this.is('KeyS') || this.is('ArrowDown');
    const left = this.is('KeyA') || this.is('ArrowLeft');
    const right = this.is('KeyD') || this.is('ArrowRight');
    return {
      throttle: (forward ? 1 : 0) - (back ? 1 : 0),
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      handbrake: this.is('Space'),
      horn: this.is('KeyH'),
      sprint: this.is('ShiftLeft') || this.is('ShiftRight'),
      jump: this.is('Space'),
      interact: this.is('KeyE'),
      fire: this.is('KeyF'),
      aim: this.is('KeyQ'),
      reload: this.is('KeyR'),
      cycle: this.is('KeyC'),
    };
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
