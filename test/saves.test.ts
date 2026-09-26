import { describe, expect, it } from 'vitest';
import { seedFromString } from '../src/core/rng.ts';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../src/sim/clock.ts';
import { DEFAULT_APPEARANCE } from '../src/sim/character.ts';
import { createSave, SaveError } from '../src/sim/save.ts';
import { createSimState } from '../src/sim/simulation.ts';
import {
  SaveSlots,
  saveKey,
  saveNote,
  savedAtKey,
  setPendingStart,
  takePendingStart,
  type KeyListStore,
} from '../src/ui/saves.ts';
import { stableJson } from './helpers.ts';

/** A storage held in a map, as `localStorage` holds it in the browser. */
function memoryStore(): KeyListStore & { size(): number } {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    size: () => items.size,
  };
}

/** Spec section 16.4: local browser saves, one per seed. */
describe('save slots', () => {
  it('keeps one save per seed, the last one written', () => {
    const store = memoryStore();
    const slots = new SaveSlots(store);
    const state = createSimState(seedFromString('sunset'));
    expect(slots.read('sunset')).toBeNull();
    slots.write(createSave('sunset', state));
    state.money = 7;
    slots.write(createSave('sunset', state));
    slots.write(createSave('harbour', createSimState(seedFromString('harbour'))));
    // Two saves and the time each was written at.
    expect(store.size()).toBe(4);
    expect(slots.has('sunset')).toBe(true);
    expect(stableJson(slots.read('sunset')?.state)).toBe(stableJson(state));
    expect(slots.read('Sunset')).toBeNull();
  });

  it('reports a damaged save rather than loading it', () => {
    const store = memoryStore();
    store.setItem(saveKey('sunset'), '{"format":"sunset-driver-save"');
    expect(() => new SaveSlots(store).read('sunset')).toThrow(SaveError);
  });

  it('lists the saves of this browser, newest first', () => {
    const store = memoryStore();
    const slots = new SaveSlots(store);
    const early = createSimState(seedFromString('sunset'));
    early.tick = 2 * TICKS_PER_DAY + 7 * TICKS_PER_HOUR + TICKS_PER_HOUR / 2;
    early.money = 1234.4;
    slots.write(createSave('sunset', early), 1_000);
    slots.write(createSave('harbour', createSimState(seedFromString('harbour'))), 2_000);
    expect(slots.list().map((save) => save.seed)).toEqual(['harbour', 'sunset']);
    const sunset = slots.list().find((save) => save.seed === 'sunset');
    expect(sunset && saveNote(sunset)).toBe('Day 3 · 07:30 · $1,234');
    expect(sunset?.character).toEqual(early.character);
  });

  it('skips a save it cannot start, breaks a tie by seed and puts one with no time last', () => {
    const store = memoryStore();
    const slots = new SaveSlots(store);
    for (const seed of ['sunset', 'harbour', 'lagoon']) {
      slots.write(createSave(seed, createSimState(seedFromString(seed))), 1_000);
    }
    store.setItem(savedAtKey('lagoon'), 'not a number');
    store.setItem(saveKey('wrecked'), '{"format":"sunset-driver-save","version":0}');
    expect(slots.list().map((save) => save.seed)).toEqual(['harbour', 'sunset', 'lagoon']);
  });

  it('hands a pending start over once', () => {
    const store = memoryStore();
    expect(takePendingStart(store)).toBeNull();
    setPendingStart(store, { seed: 'harbour', character: DEFAULT_APPEARANCE, load: true });
    expect(takePendingStart(store)).toEqual({ seed: 'harbour', character: DEFAULT_APPEARANCE, load: true });
    expect(takePendingStart(store)).toBeNull();
    store.setItem('sunset-driver.start', 'not json');
    expect(takePendingStart(store)).toBeNull();
    expect(store.size()).toBe(0);
  });
});
