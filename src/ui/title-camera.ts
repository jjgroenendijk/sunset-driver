import { BUILDING_VIEWS, type BuildingViewChoice } from './settings.ts';
import { buildChoicePage } from './title-choice.ts';

/**
 * The Camera page of the title screen and of the pause menu: what happens when
 * a building stands between the camera and the player (spec section 10.7).
 */
export function buildCameraPage(setting: BuildingViewChoice, back: () => void): HTMLElement {
  return buildChoicePage('title-camera', 'When a building is in the way', BUILDING_VIEWS, setting, back);
}
