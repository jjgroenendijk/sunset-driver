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

/**
 * How loud the game is (spec section 15). Off is not a gain of zero: the audio
 * graph is torn down, so a muted session synthesises nothing at all.
 */
export type SoundLevel = 'off' | 'quiet' | 'normal' | 'loud';

export interface Settings {
  buildingView: BuildingView;
  sound: SoundLevel;
}

/** See-through is what GTA Chinatown Wars does, and it keeps the camera where it is. */
export const DEFAULT_SETTINGS: Settings = { buildingView: 'see-through', sound: 'normal' };

/** Each level, in the order a menu lists them, with the master volume it means. */
export const SOUND_LEVELS: readonly { value: SoundLevel; label: string; note: string; volume: number }[] = [
  { value: 'off', label: 'Off', note: 'Nothing is synthesised at all', volume: 0 },
  { value: 'quiet', label: 'Quiet', note: 'Under a conversation', volume: 0.3 },
  { value: 'normal', label: 'Normal', note: 'The engine, the street and the shooting', volume: 0.6 },
  { value: 'loud', label: 'Loud', note: 'As loud as the mix goes', volume: 1 },
];

/** The master volume a level means, 0 to 1. */
export function volumeOf(level: SoundLevel): number {
  return SOUND_LEVELS.find((choice) => choice.value === level)?.volume ?? 0.6;
}

/** Each choice of {@link BuildingView}, in the order a menu lists them, with what it is called there. */
export const BUILDING_VIEWS: readonly { value: BuildingView; label: string; note: string }[] = [
  { value: 'see-through', label: 'See-through', note: 'A building in the way turns to a ghost' },
  { value: 'pull-back', label: 'Pull back', note: 'The camera moves over the roofs first' },
  { value: 'whole', label: 'Off', note: 'Every building is drawn whole' },
];

/** What a menu page reads a setting from and hands a new choice to. */
export interface SettingChoice<T> {
  current(): T;
  choose(value: T): void;
}

export type BuildingViewChoice = SettingChoice<BuildingView>;
export type SoundChoice = SettingChoice<SoundLevel>;

/** The settings kept in a store, with the default for anything missing or not understood. */
export function readSettings(store: KeyValueStore): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    raw = {};
  }
  const held = raw as { buildingView?: unknown; sound?: unknown } | null;
  const view = held?.buildingView;
  const sound = held?.sound;
  return {
    buildingView: BUILDING_VIEWS.some((choice) => choice.value === view)
      ? (view as BuildingView)
      : DEFAULT_SETTINGS.buildingView,
    sound: SOUND_LEVELS.some((choice) => choice.value === sound) ? (sound as SoundLevel) : DEFAULT_SETTINGS.sound,
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
