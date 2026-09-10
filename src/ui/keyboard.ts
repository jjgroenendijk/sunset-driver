import type { InputFrame } from '../sim/input';

/**
 * Keyboard state sampled once per simulation tick into an InputFrame.
 * Bindings: WASD / arrows to drive, Space handbrake, Shift sprint, H horn, E interact, F fire.
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
    };
  }
}
