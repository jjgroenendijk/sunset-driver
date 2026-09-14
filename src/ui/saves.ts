/**
 * The saves in the browser (spec section 16.4): one per seed, in local storage,
 * and the note that carries a session across a page load.
 *
 * Both read a {@link KeyValueStore} rather than `localStorage` itself, so the
 * tests hand them a map. The game hands them `localStorage` for the saves and
 * `sessionStorage` for the note, which is gone when the tab closes.
 */
import { normaliseAppearance, type CharacterAppearance } from '../sim/character.ts';
import { saveFromJson, type SaveFile } from '../sim/save.ts';

/** The part of the Web Storage interface the saves use. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const SAVE_PREFIX = 'sunset-driver.save.';
const START_KEY = 'sunset-driver.start';

/** The storage key of a seed's save. A seed is any text, so it is encoded. */
export function saveKey(seed: string): string {
  return SAVE_PREFIX + encodeURIComponent(seed);
}

/** One save per seed: a second save of the same seed replaces the first. */
export class SaveSlots {
  private readonly store: KeyValueStore;

  constructor(store: KeyValueStore) {
    this.store = store;
  }

  /** Keep a save. Throws where the browser refuses it, such as a full storage. */
  write(save: SaveFile): void {
    this.store.setItem(saveKey(save.seed), JSON.stringify(save));
  }

  /** The save of a seed, or null where there is none. Throws a `SaveError` where it is damaged. */
  read(seed: string): SaveFile | null {
    const json = this.store.getItem(saveKey(seed));
    return json === null ? null : saveFromJson(json);
  }

  has(seed: string): boolean {
    return this.store.getItem(saveKey(seed)) !== null;
  }
}

/**
 * How the next page load starts: straight into a seed with a look, from that
 * seed's save or afresh, without the title screen. An import of another seed's
 * save and Regenerate both need a world the page has not built, and building it
 * from a clean page is what a new session already does.
 */
export interface PendingStart {
  seed: string;
  character: CharacterAppearance;
  /** True to load the seed's save once the world stands, false for a new session. */
  load: boolean;
}

export function setPendingStart(store: KeyValueStore, start: PendingStart): void {
  store.setItem(START_KEY, JSON.stringify(start));
}

/** The pending start, once: it is removed as it is read, so a second load goes to the title. */
export function takePendingStart(store: KeyValueStore): PendingStart | null {
  const json = store.getItem(START_KEY);
  if (json === null) return null;
  store.removeItem(START_KEY);
  try {
    const value = JSON.parse(json) as Partial<PendingStart> | null;
    if (typeof value?.seed !== 'string' || value.seed.length === 0) return null;
    return { seed: value.seed, character: normaliseAppearance(value.character), load: value.load === true };
  } catch {
    return null;
  }
}
