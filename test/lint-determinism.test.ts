import { describe, expect, it } from 'vitest';
import path from 'node:path';
import ts from 'tsapi';
import { lintDeterminism, type Finding } from '../scripts/lint-determinism.ts';

const DIR = path.join(import.meta.dirname, 'fixtures', 'lint');
const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
};

function lint(fixture: string): Finding[] {
  const file = path.join(DIR, fixture);
  return lintDeterminism([file], OPTIONS, [DIR], DIR);
}

describe('determinism lint', () => {
  it('accepts types the checker builds without a symbol', () => {
    // Regression: getBaseTypes on such a type threw and killed the whole run.
    expect(lint('no-symbol-types.ts')).toEqual([]);
  });

  it('reports every kind of violation', () => {
    // A spread of map.keys() breaks two rules at once, so line 9 appears twice.
    expect(lint('violations.ts')).toEqual([
      { file: 'violations.ts', line: 4, message: expect.stringContaining('iteration over Set') },
      { file: 'violations.ts', line: 9, message: expect.stringContaining('iteration over MapIterator') },
      { file: 'violations.ts', line: 9, message: expect.stringContaining('Map.keys()') },
      { file: 'violations.ts', line: 13, message: expect.stringContaining('Object.keys/values/entries') },
      { file: 'violations.ts', line: 18, message: expect.stringContaining('for-in') },
      { file: 'violations.ts', line: 23, message: expect.stringContaining('Math.random()') },
    ]);
  });
});
