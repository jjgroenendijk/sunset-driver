/** One row of the binding list shown on the title screen and in the README. */
export interface ControlBinding {
  action: string;
  keys: string;
}

/**
 * The bindings `Keyboard` reads, in the order they are shown. Keep this table
 * and `Keyboard.sample` in step: nothing else should describe the bindings.
 */
export const CONTROLS: readonly ControlBinding[] = [
  { action: 'Move, drive', keys: 'W A S D or arrows' },
  { action: 'Sprint', keys: 'Shift' },
  { action: 'Handbrake, jump', keys: 'Space' },
  { action: 'Horn', keys: 'H' },
  { action: 'Interact, enter vehicle', keys: 'E' },
  { action: 'Fire', keys: 'F' },
];
