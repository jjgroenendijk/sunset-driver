/**
 * The saves in the browser (spec section 16.4): one per seed, in local storage,
 * and the note that carries a session across a page load.
 *
 * Both read a {@link KeyValueStore} rather than `localStorage` itself, so the
 * tests hand them a map. The game hands them `localStorage` for the saves and
 * `sessionStorage` for the note, which is gone when the tab closes.
 */
import { gameTime } from '../sim/clock.ts';
import { normaliseAppearance, type CharacterAppearance } from '../sim/character.ts';
import { saveFromJson, type SaveFile } from '../sim/save.ts';

/** The part of the Web Storage interface the saves use. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A store whose keys can be walked, as `localStorage` walks them: the saves are listed from this. */
export interface KeyListStore extends KeyValueStore {
  readonly length: number;
  key(index: number): string | null;
}

const SAVE_PREFIX = 'sunset-driver.save.';
const TIME_PREFIX = 'sunset-driver.saved.';
const START_KEY = 'sunset-driver.start';

/** The storage key of a seed's save. A seed is any text, so it is encoded. */
export function saveKey(seed: string): string {
  return SAVE_PREFIX + encodeURIComponent(seed);
}

/**
 * The storage key of the wall-clock time a seed's save was written. It is kept
 * beside the save rather than in it: the record is the simulation, and the
 * simulation never reads the clock on the wall. The title screen lists the
 * saves newest first, and this is the only thing that says which is newest.
 */
export function savedAtKey(seed: string): string {
  return TIME_PREFIX + encodeURIComponent(seed);
}

/** What the title screen shows for one save, without loading it. */
export interface SaveSummary {
  seed: string;
  /** The day the session was on, counting from one, as the pause menu counts it. */
  day: number;
  hour: number;
  minute: number;
  money: number;
  /** The driver of the saved session, so the menu starts the seed with the right look. */
  character: CharacterAppearance;
  /** When it was written, in epoch milliseconds, or 0 where the browser lost that. */
  writtenAt: number;
}

/** One line for a save: where the session was when it was written. */
export function saveNote(summary: SaveSummary): string {
  const hour = String(summary.hour).padStart(2, '0');
  const minute = String(summary.minute).padStart(2, '0');
  return `Day ${summary.day} · ${hour}:${minute} · $${Math.round(summary.money).toLocaleString('en-US')}`;
}

/** One save per seed: a second save of the same seed replaces the first. */
export class SaveSlots {
  private readonly store: KeyListStore;

  constructor(store: KeyListStore) {
    this.store = store;
  }

  /** Keep a save, and the time it was kept at. Throws where the browser refuses it, such as a full storage. */
  write(save: SaveFile, writtenAt: number = Date.now()): void {
    this.store.setItem(saveKey(save.seed), JSON.stringify(save));
    this.store.setItem(savedAtKey(save.seed), String(writtenAt));
  }

  /**
   * Every save in this browser, newest first, and only the ones this version
   * can play: a damaged or older save is skipped rather than offered and then
   * refused. Two saves written in the same millisecond are ordered by seed, so
   * the list never changes order on its own.
   */
  list(): SaveSummary[] {
    const summaries: SaveSummary[] = [];
    for (let at = 0; at < this.store.length; at++) {
      const key = this.store.key(at);
      if (key === null || !key.startsWith(SAVE_PREFIX)) continue;
      const json = this.store.getItem(key);
      if (json === null) continue;
      let save: SaveFile;
      try {
        save = saveFromJson(json);
      } catch {
        continue;
      }
      const time = gameTime(save.state.tick);
      summaries.push({
        seed: save.seed,
        day: time.day + 1,
        hour: time.hour,
        minute: time.minute,
        money: save.state.money,
        character: save.state.character,
        writtenAt: this.writtenAt(save.seed),
      });
    }
    summaries.sort((a, b) => b.writtenAt - a.writtenAt || (a.seed < b.seed ? -1 : 1));
    return summaries;
  }

  /** When a seed's save was written, or 0 where nothing says. */
  private writtenAt(seed: string): number {
    const text = this.store.getItem(savedAtKey(seed));
    const at = text === null ? Number.NaN : Number(text);
    return Number.isFinite(at) ? at : 0;
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
