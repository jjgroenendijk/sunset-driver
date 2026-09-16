import { SOUND_LEVELS, type SoundChoice } from './settings.ts';
import { buildChoicePage } from './title-choice.ts';

/**
 * The Sound page of the title screen and of the pause menu: how loud the game
 * is (spec section 15). Off tears the audio graph down rather than turning it
 * to zero, so nothing is synthesised at all.
 */
export function buildSoundPage(setting: SoundChoice, back: () => void): HTMLElement {
  return buildChoicePage('title-sound', 'How loud the city is', SOUND_LEVELS, setting, back);
}
