/**
 * What the phone's play pad (`src/ui/input/touch-play.ts`) hands the keys: a
 * stick that stands in for the walking keys, buttons that hold a key, and taps
 * that press one for a single sample.
 */
import { describe, expect, it } from 'vitest';
import { Keyboard } from '../../../src/ui/input/keyboard.ts';

function keys(): Keyboard {
  return new Keyboard(new EventTarget() as unknown as Window);
}

describe('the play pad', () => {
  it('drives with the stick as the keys would, and stops when it is let go', () => {
    const keyboard = keys();
    keyboard.stick(0.5, 1);
    expect(keyboard.sample()).toMatchObject({ throttle: 1, steer: 0.5 });
    keyboard.stick(0, 0);
    expect(keyboard.sample()).toMatchObject({ throttle: 0, steer: 0 });
  });

  it('walks the stick relative to the view, as the keys walk', () => {
    const keyboard = keys();
    keyboard.turn = Math.PI / 2;
    keyboard.stick(0, 1);
    const frame = keyboard.sample();
    expect(frame.throttle).toBeCloseTo(0);
    expect(frame.steer).toBeCloseTo(-1);
  });

  it('holds a key for as long as the button is down', () => {
    const keyboard = keys();
    keyboard.press('Mouse0');
    keyboard.press('KeyE');
    expect(keyboard.sample()).toMatchObject({ fire: true, interact: true });
    expect(keyboard.sample()).toMatchObject({ fire: true, interact: true });
    keyboard.release('Mouse0');
    keyboard.release('KeyE');
    expect(keyboard.sample()).toMatchObject({ fire: false, interact: false });
  });

  it('presses a tapped row for one sample', () => {
    const keyboard = keys();
    keyboard.pulse('Digit2');
    expect(keyboard.sample()).toMatchObject({ travel: 2, buy: 2 });
    expect(keyboard.sample()).toMatchObject({ travel: 0, buy: 0 });
    // The same row tapped again is a second choice, not a key still held.
    keyboard.pulse('Digit2');
    expect(keyboard.sample().travel).toBe(2);
  });

  it('turns the radio and the weapon one step a tap', () => {
    const keyboard = keys();
    keyboard.pulse('BracketRight');
    keyboard.nextWeapon();
    expect(keyboard.sample()).toMatchObject({ station: 1, cycle: 1 });
    expect(keyboard.sample()).toMatchObject({ station: 0, cycle: 0 });
  });
});
