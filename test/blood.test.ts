import { describe, expect, it } from 'vitest';
import {
  BLOOD_CAP,
  casualtyMarks,
  POOL_TICKS,
  SPATTER_CAP,
  spatterMarks,
  type BloodMark,
  type Spatter,
} from '../src/render/blood-layout.ts';
import { DEFAULT_GORE, GORE_LEVELS } from '../src/render/gore.ts';
import { restDistance, restTicks, throwOf, type Casualty } from '../src/sim/casualty-motion.ts';
import type { KeyValueStore } from '../src/ui/saves.ts';
import { DEFAULT_SETTINGS, readSettings, writeSettings } from '../src/ui/settings.ts';

/** A body shot down where it stood: no push, so it lies where it fell. */
function body(overrides: Partial<Casualty> = {}): Casualty {
  return {
    id: 7,
    since: 1000,
    first: 1000,
    cause: 'shot',
    health: 0,
    x: 10,
    y: 20,
    height: 2,
    rest: 2,
    heading: 0,
    dir: 0,
    push: 0,
    lift: 0,
    reach: 50,
    down: -1,
    side: 1,
    cash: 0,
    gone: false,
    bumped: -1,
    ragdoll: null,
    ...overrides,
  };
}

function marks(record: Casualty, tick: number, gore: Parameters<typeof casualtyMarks>[2]): BloodMark[] {
  const out: BloodMark[] = [];
  const n = casualtyMarks([record], tick, gore, out);
  return out.slice(0, n);
}

describe('the blood under a body', () => {
  it('lays a pool once the body is still, which spreads with time', () => {
    const record = body();
    const rest = record.since + restTicks(record);
    expect(marks(record, rest - 1, 'moderate')).toHaveLength(0);
    const early = marks(record, rest + 60, 'moderate');
    const late = marks(record, rest + POOL_TICKS, 'moderate');
    const later = marks(record, rest + 2 * POOL_TICKS, 'moderate');
    expect(early).toHaveLength(1);
    const pool = early[0] as BloodMark;
    expect(pool.x).toBeCloseTo(10);
    expect(pool.y).toBeCloseTo(20);
    expect(pool.h).toBeCloseTo(2);
    expect(pool.streak).toBe(0);
    expect((late[0] as BloodMark).length).toBeGreaterThan(pool.length);
    // Spread to its full size, it stops growing.
    expect((later[0] as BloodMark).length).toBeCloseTo((late[0] as BloodMark).length);
  });

  it('spreads the pool wider the more gore is asked for, and lays nothing with it off', () => {
    const record = body();
    const tick = record.since + restTicks(record) + POOL_TICKS;
    expect(marks(record, tick, 'off')).toHaveLength(0);
    const sizes = (['subtle', 'moderate', 'heavy'] as const).map((level) => (marks(record, tick, level)[0] as BloodMark).length);
    expect(sizes[0]).toBeLessThan(sizes[1] as number);
    expect(sizes[1]).toBeLessThan(sizes[2] as number);
  });

  it('lays less under the wounded than under the dead, and fades once they are up', () => {
    const wounded = body({ health: 40, down: 5 * 60 });
    const rest = wounded.since + restTicks(wounded);
    const tick = rest + 4 * 60;
    const small = marks(wounded, tick, 'moderate')[0] as BloodMark;
    const large = marks(body(), tick, 'moderate')[0] as BloodMark;
    expect(small.length).toBeLessThan(large.length);
    expect(marks(wounded, rest + wounded.down + 60 * 60, 'moderate')).toHaveLength(0);
  });

  it('lays nothing for a body taken away, or for someone only staggered', () => {
    const record = body({ gone: true });
    expect(marks(record, record.since + 10 * POOL_TICKS, 'heavy')).toHaveLength(0);
    const staggered = body({ health: 90, down: 0 });
    expect(marks(staggered, staggered.since + 10 * POOL_TICKS, 'heavy')).toHaveLength(0);
  });

  it('smears a body a car threw along the way it slid, from where it came down', () => {
    const dir = Math.PI / 4;
    const record = body({ cause: 'car', dir, push: 12, lift: 3 });
    const tick = record.since + restTicks(record) + 60;
    const all = marks(record, tick, 'moderate');
    const smear = all.find((mark) => mark.streak === 1) as BloodMark;
    expect(smear).toBeDefined();
    expect(smear.angle).toBeCloseTo(dir);
    const from = throwOf(record).airDistance;
    const middle = Math.hypot(smear.x - record.x, smear.y - record.y);
    expect(middle).toBeGreaterThan(from);
    expect(middle).toBeLessThan(restDistance(record));
    expect(Math.atan2(smear.y - record.y, smear.x - record.x)).toBeCloseTo(dir);
    expect(smear.length).toBeGreaterThan(smear.width);
    // And a mark where the car struck.
    expect(all.some((mark) => mark.streak === 0 && mark.x === record.x && mark.y === record.y)).toBe(true);
    // Subtle draws no smear, and Heavy a longer one.
    expect(marks(record, tick, 'subtle').some((mark) => mark.streak === 1)).toBe(false);
    const heavy = marks(record, tick, 'heavy').find((mark) => mark.streak === 1) as BloodMark;
    expect(heavy.length).toBeGreaterThan(smear.length);
  });

  it('never lays more than the batch holds', () => {
    const many = Array.from({ length: 200 }, (_, i) => body({ id: i, x: i }));
    const out: BloodMark[] = [];
    expect(casualtyMarks(many, 1000 + POOL_TICKS, 'heavy', out)).toBe(BLOOD_CAP);
  });
});

describe('the spatter around a hit', () => {
  const hit: Spatter = { tick: 500, x: 3, y: 4, h: 1, strength: 0.5 };

  it('throws the same spots for the same hit, more with more gore, and none with it off', () => {
    const count = (gore: Parameters<typeof spatterMarks>[2]): number => spatterMarks([hit], 520, gore, []);
    expect(count('off')).toBe(0);
    expect(count('subtle')).toBeLessThan(count('moderate'));
    expect(count('moderate')).toBeLessThan(count('heavy'));
    const a: BloodMark[] = [];
    const b: BloodMark[] = [];
    spatterMarks([hit], 520, 'moderate', a);
    spatterMarks([hit], 520, 'moderate', b);
    expect(a).toEqual(b);
    for (const spot of a) expect(spot.h).toBe(1);
  });

  it('keeps to its own share of the batch', () => {
    const hits = Array.from({ length: 40 }, (_, i) => ({ ...hit, tick: 500 + i }));
    expect(spatterMarks(hits, 600, 'heavy', [])).toBe(SPATTER_CAP);
  });
});

function memoryStore(): KeyValueStore {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

describe('the gore setting', () => {
  it('starts at Moderate', () => {
    expect(DEFAULT_GORE).toBe('moderate');
    expect(readSettings(memoryStore()).gore).toBe('moderate');
    expect(GORE_LEVELS.map((level) => level.label)).toEqual(['Off', 'Subtle', 'Moderate', 'Heavy']);
  });

  it('keeps a choice, and falls back on a value it does not know', () => {
    const store = memoryStore();
    writeSettings(store, { ...DEFAULT_SETTINGS, gore: 'off' });
    expect(readSettings(store).gore).toBe('off');
    store.setItem('sunset-driver.settings', '{"gore":"extreme"}');
    expect(readSettings(store).gore).toBe('moderate');
  });
});
