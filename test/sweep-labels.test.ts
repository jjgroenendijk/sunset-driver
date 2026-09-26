import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { unlabelledExpects } from './sweep-labels.ts';

const HERE = import.meta.dirname;

describe('the seed sweep names the seed of every failure', () => {
  it('finds a bare assertion inside a loop over the seeds, and nothing outside one', () => {
    const text = [
      'expect(1).toBe(1);',
      'for (const seed of seeds) {',
      '  expect(seed, `seed ${seed}`).toBe(seed);',
      '  for (const p of points) expect(p.x).toBe(0);',
      '}',
    ].join('\n');
    expect(unlabelledExpects('fixture.ts', text).map((u) => u.line)).toEqual([4]);
  });

  it('holds every check file of the sweep to it', () => {
    const files = readdirSync(HERE).filter((name) => /^seed-.*\.test\.ts$/.test(name));
    const found = files.flatMap((name) => unlabelledExpects(path.join(HERE, name)));
    const report = found.map((u) => `${path.basename(u.file)}:${u.line} ${u.text.slice(0, 80)}`);
    expect(report.join('\n')).toBe('');
  });
});
