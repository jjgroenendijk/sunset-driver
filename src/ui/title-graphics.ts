import { choiceOf, presetOf, STEPPED, type GraphicsChoice, type SteppedKnob } from '../render/graphics.ts';
import { QUALITY_TIERS, type QualityTier } from '../render/quality.ts';
import type { CycleChoice, GraphicsMenu, ToggleChoice } from './settings.ts';
import { backButton, menuList, page, type MenuItem } from './title-parts.ts';

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];

/** What each automatic tier is called in the Preset row. */
const PRESETS = ['Full', 'High', 'Medium', 'Low'];

/**
 * The Graphics column of the title screen and of the pause menu (spec section
 * 9.2). Auto lets the frame-time monitor pick the tier. Preset sets every knob
 * to one of its tiers at once, and each knob below it can be set by hand.
 * Setting a preset or a knob turns Auto off, from what Auto was drawing. A
 * change takes effect on the next frame.
 */
export function buildGraphicsPage(setting: GraphicsMenu, back: () => void): HTMLElement {
  const root = page('title-page title-graphics');
  const set = (change: Partial<GraphicsChoice>): void =>
    setting.choose({ ...setting.current(), auto: false, ...change });
  const flag = (key: 'bloom' | 'smaa'): ToggleChoice => ({
    on: () => setting.current()[key],
    set: (on) => set({ [key]: on }),
  });
  const knob = (key: SteppedKnob): CycleChoice => ({
    label: () => (STEPPED[key][setting.current()[key]] as { label: string }).label,
    move: (by) => set({ [key]: wrap(setting.current()[key] + by, STEPPED[key].length) }),
  });
  const auto: ToggleChoice = {
    on: () => setting.current().auto,
    set: (on) => setting.choose({ ...setting.current(), auto: on }),
  };
  const preset: CycleChoice = {
    label: () => {
      const at = presetOf(setting.current());
      return at === undefined ? 'Custom' : (PRESETS[at] as string);
    },
    move: (by) => {
      const at = presetOf(setting.current());
      const to = at === undefined ? 0 : wrap(at + by, QUALITY_TIERS.length);
      setting.choose(choiceOf(QUALITY_TIERS[to] as QualityTier));
    },
  };
  const rows: Omit<MenuItem, 'numeral'>[] = [
    { label: 'Auto', toggle: auto },
    { label: 'Preset', cycle: preset },
    { label: 'Resolution', cycle: knob('resolution') },
    { label: 'Bloom', toggle: flag('bloom') },
    { label: 'Anti-aliasing', toggle: flag('smaa') },
    { label: 'Draw distance', cycle: knob('distance') },
    { label: 'Shadows', cycle: knob('shadows') },
    { label: 'Reflections', cycle: knob('reflections') },
    { label: 'Detail', cycle: knob('detail') },
  ];
  const menu = menuList(
    rows.map((row, i) => ({ ...row, numeral: NUMERALS[i] as string })),
    'Graphics',
  );
  menu.append(backButton(back));
  root.append(menu);
  return root;
}

function wrap(at: number, length: number): number {
  return (at + length) % length;
}
