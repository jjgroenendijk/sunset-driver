/** One row of the binding list shown on the title screen and in the README. */
export interface ControlBinding {
  action: string;
  keys: string;
}

/**
 * Every binding, in the order they are shown. Keep this table and
 * `Keyboard.sample` in step: nothing else should describe the bindings.
 *
 * The rows down to `Cycle weapon` are the per-tick input frame `Keyboard`
 * samples. The rows after them open and close something on screen rather than
 * driving the simulation, so `main.ts` listens for them itself.
 */
export const CONTROLS: readonly ControlBinding[] = [
  { action: 'Move, drive', keys: 'W A S D or arrows' },
  { action: 'Sprint', keys: 'Shift' },
  { action: 'Handbrake, jump', keys: 'Space' },
  { action: 'Horn', keys: 'H' },
  { action: 'Enter or leave vehicle, hotwire, interact', keys: 'E' },
  { action: 'Fire, swing', keys: 'F' },
  { action: 'Aim', keys: 'Q' },
  { action: 'Reload', keys: 'R' },
  { action: 'Cycle weapon', keys: 'C' },
  { action: 'Vehicle picker', keys: 'V' },
  { action: 'Weapon picker', keys: 'G' },
];
