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
  { action: 'Enter or leave vehicle, shop, safehouse, deal or job board, hotwire', keys: 'E' },
  { action: 'Fire, swing', keys: 'F' },
  { action: 'Aim', keys: 'Q' },
  { action: 'Reload', keys: 'R' },
  { action: 'Cycle weapon', keys: 'C' },
  { action: 'Radio: next, previous station', keys: '] and [' },
  { action: 'Metro, shop, safehouse, dealer or contact: the row on the panel', keys: '1 to 9' },
  { action: 'Dealer: sell the lot on that row', keys: 'Shift and 1 to 9' },
  { action: 'Pause menu', keys: 'Esc' },
  { action: 'Map', keys: 'M' },
  { action: 'Map: zoom, centre on me, legend', keys: '+ − Space L' },
  { action: 'Minimap north up', keys: 'N' },
  { action: 'Vehicle picker', keys: 'V' },
  { action: 'Weapon picker', keys: 'G' },
  { action: 'Debug: die', keys: 'K' },
  { action: 'Debug: arrest', keys: 'B' },
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
  { action: 'Fly the camera', keys: 'Stick' },
  { action: 'Look around', keys: 'Drag' },
  { action: 'Set the speed', keys: 'Pinch' },
  { action: 'Rise and fall', keys: '▲ or ▼' },
  { action: 'Six times the speed', keys: 'Fast' },
  { action: 'Start or end the flight', keys: 'Fly or Land' },
  { action: 'Pause menu, map', keys: 'Menu or Map' },
];
