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

/** Every fixture, linted in one program. */
const FIXTURES = ['no-symbol-types.ts', 'violations.ts'];

/**
 * Building the program is almost all of what a lint costs, because it loads the
 * standard library, and the run of a file is cheap next to it. So the fixtures
 * are linted together, once, and each test reads its own file out of the
 * findings. The lint only walks the files it was given, so a fixture sees the
 * same program it would have seen alone.
 */
const findings = lintDeterminism(
  FIXTURES.map((name) => path.join(DIR, name)),
  OPTIONS,
  [DIR],
  DIR,
);

function lint(fixture: string): Finding[] {
  return findings.filter((finding) => finding.file === fixture);
}

describe('determinism lint', () => {
  it('accepts types the checker builds without a symbol', () => {
    // Regression: getBaseTypes on such a type threw and killed the whole run.
    expect(lint('no-symbol-types.ts')).toEqual([]);
  });

  it('leaves the exactly specified Math functions alone', () => {
    // abs, floor, sqrt, max and round are exact by the standard, so banning
    // them would cost every call site for nothing.
    expect(lint('violations.ts').filter((f) => f.line >= 30)).toEqual([]);
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
      { file: 'violations.ts', line: 27, message: expect.stringContaining('Math.sin()') },
      { file: 'violations.ts', line: 27, message: expect.stringContaining('Math.hypot()') },
      { file: 'violations.ts', line: 27, message: expect.stringContaining('Math.pow()') },
    ]);
  });
});
