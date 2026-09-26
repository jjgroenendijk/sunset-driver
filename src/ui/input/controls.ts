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
  { action: 'Sprint; descend in an aircraft', keys: 'Shift' },
  { action: 'Handbrake, jump; climb in an aircraft', keys: 'Space' },
  { action: 'Horn', keys: 'H' },
  { action: 'Open or shut the bonnet', keys: 'O' },
  { action: 'Enter, use, hotwire', keys: 'E' },
  { action: 'Fire, swing', keys: 'Left click' },
  { action: 'Aim', keys: 'Right click' },
  { action: 'Reload', keys: 'R' },
  { action: 'Cycle weapon', keys: 'Mouse wheel' },
  { action: 'Give up (1–2 stars)', keys: 'X' },
  { action: 'Radio', keys: '] and [' },
  { action: 'Pick a row', keys: '1 to 9' },
  { action: 'Shop, dealer: choose, buy', keys: '↑ ↓ Enter or click' },
  { action: 'Dealer: sell all', keys: 'Shift and Enter, or Shift and 1 to 9' },
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
 * What a finger does instead. A phone is shown this list rather than the keys,
 * since it reaches none of them: the play pad of `touch-play.ts` while the
 * camera follows the player, and the fly pad of `touch-fly.ts` while the free
 * camera has the screen (`docs/menus.md`).
 *
 * `keys` is prose here rather than key caps, so `keyParts` draws each word as a
 * cap and the page reads as a list of gestures.
 */
export const TOUCH_CONTROLS: readonly ControlBinding[] = [
  { action: 'Walk, drive', keys: 'Stick' },
  { action: 'Enter, use, hotwire', keys: 'Use' },
  { action: 'Fire, swing', keys: 'Fire' },
  { action: 'Jump; handbrake', keys: 'Jump or Brake' },
  { action: 'Sprint; horn', keys: 'Run or Horn' },
  { action: 'Reload, cycle weapon', keys: 'Load or Gun' },
  { action: 'Pick a row', keys: 'Tap' },
  { action: 'Fly over the city', keys: 'Fly' },
  { action: 'Fly: look, speed', keys: 'Drag or Pinch' },
  { action: 'Fly: rise, fall, boost', keys: '▲ ▼ Fast' },
  { action: 'Pause, map, full screen', keys: 'Menu Map Full' },
];
