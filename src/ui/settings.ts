/**
 * The player's settings, kept in the browser beside the saves (`saves.ts`).
 *
 * A setting belongs to the browser and not to a save: it holds for every seed.
 * What is read back is checked, so a value an older build wrote, or a hand
 * edit, falls back to the default rather than breaking the page.
 */
import type { KeyValueStore } from './saves.ts';

const SETTINGS_KEY = 'sunset-driver.settings';

/**
 * What happens when a building stands between the camera and the player (spec
 * section 10.7): the building turns see-through, the camera also pulls back
 * over the roofs, or nothing happens and every building is drawn whole.
 */
export type BuildingView = 'see-through' | 'pull-back' | 'whole';

export interface Settings {
  buildingView: BuildingView;
  /** True while the audio of spec section 15 is off. A muted game synthesises nothing at all. */
  muted: boolean;
  /** True where the minimap keeps north up rather than turning with the player (spec section 12). */
  northUp: boolean;
}

/** See-through is what GTA Chinatown Wars does, and it keeps the camera where it is. */
export const DEFAULT_SETTINGS: Settings = { buildingView: 'see-through', muted: false, northUp: false };

/** Each choice of {@link BuildingView}, in the order a menu lists them, with what it is called there. */
export const BUILDING_VIEWS: readonly { value: BuildingView; label: string }[] = [
  { value: 'see-through', label: 'See-through' },
  { value: 'pull-back', label: 'Pull back' },
  { value: 'whole', label: 'Off' },
];

/** What a menu page reads a setting from and hands a new choice to. */
export interface BuildingViewChoice {
  current(): BuildingView;
  choose(view: BuildingView): void;
}

/** A setting that is on or off, drawn as a checkbox in the Settings column. */
export interface ToggleChoice {
  on(): boolean;
  set(on: boolean): void;
}

/** Every setting a menu offers, handed to the title screen and the pause menu alike. */
export interface MenuSettings {
  buildingView: BuildingViewChoice;
  /** On while the audio of spec section 15 plays. */
  sound: ToggleChoice;
  /** On while the minimap keeps north up. */
  northUp: ToggleChoice;
}

/** The settings kept in a store, with the default for anything missing or not understood. */
export function readSettings(store: KeyValueStore): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    raw = {};
  }
  const held = raw as { buildingView?: unknown; muted?: unknown; northUp?: unknown } | null;
  const known = BUILDING_VIEWS.some((choice) => choice.value === held?.buildingView);
  return {
    buildingView: known ? (held?.buildingView as BuildingView) : DEFAULT_SETTINGS.buildingView,
    muted: typeof held?.muted === 'boolean' ? held.muted : DEFAULT_SETTINGS.muted,
    northUp: typeof held?.northUp === 'boolean' ? held.northUp : DEFAULT_SETTINGS.northUp,
  };
}

/** Keep the settings. A browser that refuses the write keeps them for this page only. */
export function writeSettings(store: KeyValueStore, settings: Settings): void {
  try {
    store.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage is full or blocked. The setting still holds until the page closes.
  }
}
