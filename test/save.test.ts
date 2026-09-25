import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedFromString } from '../src/core/rng.ts';
import { sortedKeys } from '../src/core/sort.ts';
import type { InputFrame } from '../src/sim/input.ts';
import { initPhysics, SimPhysics } from '../src/sim/physics.ts';
import { dropWeapon } from '../src/sim/pickup.ts';
import {
  createSave,
  restoreSimState,
  SAVE_FORMAT,
  SAVE_VERSION,
  saveFromJson,
  saveFromText,
  SaveError,
  saveToText,
  type SaveFile,
} from '../src/sim/save.ts';
import { cloneSimState, createSimState, stepSim, type SimState } from '../src/sim/simulation.ts';
import { fitAttachment, giveWeapon } from '../src/sim/weapon.ts';
import { inputStream, stableJson } from './helpers.ts';
import { hills, TICKS } from './sim-harness.ts';

/** The seeds the saves are played on; one of them is not plain ASCII. */
const SEEDS = ['sunset', 'nöörd-7'];

/** A session played for a while, with something in every part of the record a fresh one leaves empty. */
function played(seedText: string): { state: SimState; physics: SimPhysics; inputs: InputFrame[] } {
  const state = createSimState(seedFromString(seedText));
  const physics = new SimPhysics(hills(), state);
  physics.spawn(state, 0, 0, 0);
  giveWeapon(state.loadout, 'ak-47');
  fitAttachment(state.loadout, 'ak-47', 'suppressor');
  dropWeapon(state, 'glock-17', 17, 34, [], 12, -4, 1);
  state.waypoint = { x: 140, y: -60 };
  state.objective = 'Lose the tail';
  const inputs = inputStream(state.seed, TICKS * 2);
  for (const frame of inputs.slice(0, TICKS)) stepSim(state, frame, physics);
  return { state, physics, inputs: inputs.slice(TICKS) };
}

/**
 * The version the record's shape was last pinned at, and a hash of that shape.
 * Raise both together: see the test that reads them.
 */
const PINNED = { version: 23, shape: 'bf512d15e90957b4' };

/**
 * One line per field a save is checked for, the way `conform` in `save.ts`
 * checks it: the path and the type, and an array by its first element.
 */
function shapeOf(value: unknown, path: string, out: string[]): string[] {
  if (value === null) out.push(`${path}: null`);
  else if (Array.isArray(value)) {
    out.push(`${path}: array`);
    if (value.length > 0) shapeOf(value[0], `${path}[]`, out);
  } else if (typeof value === 'object') {
    out.push(`${path}: object`);
    const record = value as Record<string, unknown>;
    for (const key of sortedKeys(record)) shapeOf(record[key], `${path}.${key}`, out);
  } else out.push(`${path}: ${typeof value}`);
  return out;
}

/** A short hash of the shape of a fresh record, the template every save is read against. */
function recordShape(): string {
  const lines = shapeOf(cloneSimState(createSimState(seedFromString('sunset'))), 'state', []);
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/** Load a save into a session built afresh, the way the game loads one, and play a stream on it. */
function continueFrom(save: SaveFile, inputs: readonly InputFrame[]): SimState {
  const state = createSimState(0);
  restoreSimState(state, save);
  const physics = new SimPhysics(hills(), state);
  for (const frame of inputs) stepSim(state, frame, physics);
  physics.dispose();
  return state;
}

/** Spec sections 12 and 16.4: a save goes out through the clipboard and comes back as the same session. */
describe('saves', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('restores an identical record through export and import', () => {
    for (const seed of SEEDS) {
      const { state, physics } = played(seed);
      const text = saveToText(createSave(seed, state));
      expect(text.startsWith(`${SAVE_FORMAT}.`)).toBe(true);
      // Pasted through a mail, with its lines broken.
      const imported = saveFromText(`  ${text.replace(/(.{76})/g, '$1\n')}\n`);
      const into = createSimState(99);
      restoreSimState(into, imported);
      expect(imported.seed).toBe(seed);
      expect(stableJson(into)).toBe(stableJson(state));
      physics.dispose();
    }
  });

  it('restores an identical record through the browser storage JSON', () => {
    const { state, physics } = played(SEEDS[0] as string);
    const into = createSimState(1);
    restoreSimState(into, saveFromJson(JSON.stringify(createSave('sunset', state))));
    expect(stableJson(into)).toBe(stableJson(state));
    physics.dispose();
  });

  it('is a copy: the session going on does not change a save already taken', () => {
    const { state, physics } = played(SEEDS[0] as string);
    const save = createSave('sunset', state);
    const before = stableJson(save);
    stepSim(state, undefined, physics);
    state.money += 100;
    expect(stableJson(save)).toBe(before);
    physics.dispose();
  });

  it('plays a loaded session the same way every time it is loaded', () => {
    const { state, physics, inputs } = played(SEEDS[1] as string);
    const save = saveFromText(saveToText(createSave(SEEDS[1] as string, state)));
    physics.dispose();
    const first = continueFrom(save, inputs);
    const second = continueFrom(save, inputs);
    expect(first.tick).toBe(save.state.tick + inputs.length);
    expect(stableJson(first)).toBe(stableJson(second));
  });

  it('refuses text that is not a save, a damaged save and a save of another version', () => {
    const state = createSimState(seedFromString('sunset'));
    const good = createSave('sunset', state);
    const reject = (text: string, message: RegExp): void => {
      expect(() => saveFromText(text)).toThrow(SaveError);
      expect(() => saveFromText(text)).toThrow(message);
    };
    reject('hello', /not a Sunset Driver save/);
    reject(`${SAVE_FORMAT}.1.%%%`, /damaged/);
    reject(saveToText({ ...good, version: 99 }), /version 99/);
    const edited = (change: (value: Record<string, any>) => void): string => {
      const copy = JSON.parse(JSON.stringify(good)) as Record<string, any>;
      change(copy);
      return saveToText(copy as SaveFile);
    };
    reject(edited((s) => delete s.state.player), /damaged at state\.player/);
    reject(edited((s) => (s.state.money = 'lots')), /damaged at state\.money/);
    reject(edited((s) => (s.state.seed = 12)), /its own seed/);
    reject(edited((s) => (s.state.tick = -3)), /valid time/);
    reject(edited((s) => (s.state.vehicle.cls = 'tank')), /vehicle/);
    reject(edited((s) => (s.state.loadout.slots[0].id = 'laser-sword')), /weapon/);
    // The factions of spec section 17: a row of standing short, and an enforcer
    // carrying something this arsenal has never heard of.
    reject(edited((s) => s.state.factions.standing.pop()), /reputation/);
    reject(
      edited((s) => {
        s.state.enforcers.units.push({
          id: 0,
          faction: 0,
          weapon: 'laser-sword',
          x: 0,
          y: 0,
          height: 0,
          heading: 0,
          speed: 0,
          cycle: 0,
          edges: [],
          distance: 0,
          planned: 0,
          fired: 0,
          goalX: 0,
          goalY: 0,
        });
      }),
      /weapon/,
    );
    expect(() => saveFromJson('{')).toThrow(/damaged/);
  });

  // A save is read against a fresh record, so a save from before a field was
  // added is refused. The version is what tells the player why (issue #285).
  it('raises the version whenever the shape of the record changes', () => {
    expect(
      { version: SAVE_VERSION, shape: recordShape() },
      'The shape of SimState changed, so an older save no longer loads. Raise SAVE_VERSION in ' +
        'src/sim/save.ts, say there what the version added, and pin the new version and shape in PINNED.',
    ).toEqual(PINNED);
  });

  it('refuses a save from before a field was added by its version, not as damaged', () => {
    const copy = JSON.parse(JSON.stringify(createSave('sunset', createSimState(seedFromString('sunset')))));
    delete copy.state.pedestrians;
    copy.version = SAVE_VERSION - 1;
    expect(() => saveFromJson(JSON.stringify(copy))).toThrow(`from version ${SAVE_VERSION - 1}`);
  });

  it('drops a field the record does not know', () => {
    const state = createSimState(seedFromString('sunset'));
    const copy = JSON.parse(JSON.stringify(createSave('sunset', state))) as SaveFile & { state: { stray?: number } };
    copy.state.stray = 1;
    const loaded = saveFromJson(JSON.stringify(copy));
    expect('stray' in loaded.state).toBe(false);
    expect(stableJson(loaded.state)).toBe(stableJson(state));
  });
});
