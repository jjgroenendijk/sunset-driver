import { describe, expect, it } from 'vitest';
import { seedFromString } from '../src/core/rng.ts';
import { DEFAULT_APPEARANCE } from '../src/sim/character.ts';
import { createSave, SaveError } from '../src/sim/save.ts';
import { createSimState } from '../src/sim/simulation.ts';
import { SaveSlots, saveKey, setPendingStart, takePendingStart, type KeyValueStore } from '../src/ui/saves.ts';
import { stableJson } from './helpers.ts';

/** A storage held in a map, as `localStorage` holds it in the browser. */
function memoryStore(): KeyValueStore & { size(): number } {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
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
    expect(store.size()).toBe(2);
    expect(slots.has('sunset')).toBe(true);
    expect(stableJson(slots.read('sunset')?.state)).toBe(stableJson(state));
    expect(slots.read('Sunset')).toBeNull();
  });

  it('reports a damaged save rather than loading it', () => {
    const store = memoryStore();
    store.setItem(saveKey('sunset'), '{"format":"sunset-driver-save"');
    expect(() => new SaveSlots(store).read('sunset')).toThrow(SaveError);
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
