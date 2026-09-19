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
 * driving the simulation, so `keys.ts` listens for them.
 */
export const CONTROLS: readonly ControlBinding[] = [
  { action: 'Move, drive', keys: 'W A S D or arrows' },
  { action: 'Sprint', keys: 'Shift' },
  { action: 'Handbrake, jump', keys: 'Space' },
  { action: 'Horn', keys: 'H' },
  { action: 'Enter, use, hotwire', keys: 'E' },
  { action: 'Fire, swing', keys: 'Left click' },
  { action: 'Aim', keys: 'Right click' },
  { action: 'Reload', keys: 'R' },
  { action: 'Cycle weapon', keys: 'Mouse wheel' },
  { action: 'Give up (1–2 stars)', keys: 'X' },
  { action: 'Radio', keys: '] and [' },
  { action: 'Pick a row', keys: '1 to 9' },
  { action: 'Shop: choose, buy', keys: '↑ ↓ Enter or click' },
  { action: 'Sell all', keys: 'Shift and 1 to 9' },
  { action: 'Pause', keys: 'Esc' },
  { action: 'Map', keys: 'M' },
  { action: 'Map zoom, centre, legend', keys: '+ − Space L' },
  { action: 'Camera view', keys: 'C' },
  { action: 'Look around (chase views)', keys: 'Mouse' },
  { action: 'Vehicles', keys: 'V' },
  { action: 'Weapons', keys: 'G' },
  { action: 'Debug info', keys: 'F3' },
  { action: 'Debug die', keys: 'K' },
  { action: 'Debug arrest', keys: 'B' },
];

/**
 * What a finger does instead, while the free camera has the screen
 * (`touch-fly.ts`). A phone is shown this list rather than the keys: it reaches
 * none of them, and the flight is all it is offered (`docs/menus.md`).
 *
 * `keys` is prose here rather than key caps, so `keyParts` draws each word as a
 * cap and the page reads as a list of gestures.
 */
export const TOUCH_CONTROLS: readonly ControlBinding[] = [
  { action: 'Fly', keys: 'Stick' },
  { action: 'Look', keys: 'Drag' },
  { action: 'Speed', keys: 'Pinch' },
  { action: 'Rise, fall', keys: '▲ or ▼' },
  { action: 'Boost', keys: 'Fast' },
  { action: 'Take off, land', keys: 'Fly or Land' },
  { action: 'Pause, map', keys: 'Menu or Map' },
];
