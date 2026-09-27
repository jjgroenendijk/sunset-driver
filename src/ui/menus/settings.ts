/**
 * The player's settings, kept in the browser beside the saves (`saves.ts`).
 *
 * A setting belongs to the browser and not to a save: it holds for every seed.
 * What is read back is checked, so a value an older build wrote, or a hand
 * edit, falls back to the default rather than breaking the page.
 */
import { DEFAULT_GORE, goreOf, type Gore } from '../../render/people/gore.ts';
import { CAMERA_VIEWS, type CameraView } from '../../render/camera/camera-view.ts';
import { DEFAULT_GRAPHICS, readGraphics, type GraphicsChoice } from '../../render/frame/graphics.ts';
import { DEFAULT_FRAME_CAP, frameCapOf } from '../../pace.ts';
import type { KeyValueStore } from './saves.ts';

const SETTINGS_KEY = 'sunset-driver.settings';

export interface Settings {
  /** Top down, the view the game is played in, or one of the two chase views. */
  view: CameraView;
  /** True while the audio of spec section 15 is off. A muted game synthesises nothing at all. */
  muted: boolean;
  /** True where the minimap keeps north up rather than turning with the player (spec section 12). */
  northUp: boolean;
  /** How much blood is drawn. It changes the picture only, never the record. */
  gore: Gore;
  /** The Graphics menu: Auto, or the knobs of a tier set by hand (spec section 9.2). */
  graphics: GraphicsChoice;
  /** The most frames drawn a second, 0 for as many as the display refreshes (`pace.ts`). */
  frameCap: number;
}

export const DEFAULT_SETTINGS: Settings = {
  view: 'top-down',
  muted: false,
  northUp: false,
  gore: DEFAULT_GORE,
  graphics: DEFAULT_GRAPHICS,
  frameCap: DEFAULT_FRAME_CAP,
};

/** What a menu page reads a setting of several choices from and hands a new choice to. */
export interface Choice<T> {
  current(): T;
  choose(value: T): void;
}

/** A setting that is on or off, drawn as a checkbox in the Settings column. */
export interface ToggleChoice {
  on(): boolean;
  set(on: boolean): void;
}

/** A setting of several steps, named at the end of its row. A press or the side arrows move it. */
export interface CycleChoice {
  label(): string;
  move(by: 1 | -1): void;
}

/**
 * What the Graphics column reads and hands a new choice to. While Auto is on,
 * `current` answers the knobs of the tier the monitor stands at, so the menu
 * shows what is being drawn.
 */
export type GraphicsMenu = Choice<GraphicsChoice>;

/** Every setting a menu offers, handed to the title screen and the pause menu alike. */
export interface MenuSettings {
  view: Choice<CameraView>;
  /** On while the audio of spec section 15 plays. */
  sound: ToggleChoice;
  /** On while the minimap keeps north up. */
  northUp: ToggleChoice;
  /** How much blood is drawn. */
  gore: Choice<Gore>;
  graphics: GraphicsMenu;
  /** The most frames drawn a second. */
  frameRate: CycleChoice;
}

/** The settings kept in a store, with the default for anything missing or not understood. */
export function readSettings(store: KeyValueStore): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    raw = {};
  }
  const held = raw as {
    view?: unknown;
    muted?: unknown;
    northUp?: unknown;
    gore?: unknown;
    graphics?: unknown;
    frameCap?: unknown;
  } | null;
  const seen = CAMERA_VIEWS.some((choice) => choice.value === held?.view);
  return {
    view: seen ? (held?.view as CameraView) : DEFAULT_SETTINGS.view,
    muted: typeof held?.muted === 'boolean' ? held.muted : DEFAULT_SETTINGS.muted,
    northUp: typeof held?.northUp === 'boolean' ? held.northUp : DEFAULT_SETTINGS.northUp,
    gore: goreOf(held?.gore),
    graphics: readGraphics(held?.graphics),
    frameCap: frameCapOf(held?.frameCap),
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
