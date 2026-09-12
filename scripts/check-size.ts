/**
 * File size lint. A source file over `HARD_LIMIT` lines fails the build.
 *
 * A long file is a file nobody reads to the end. The limit is deliberately
 * blunt: it says nothing about what the file does, only that it has grown past
 * the point where a reader can hold it in their head. Split it along the seams
 * the code already has — one concern per file — rather than cutting it in half.
 *
 * `WARN_LIMIT` is the earlier mark the Claude Code hook reports, so a file is
 * split while the split is still small.
 *
 * Run as a script it lints the project. Imported it exports `lintSizes`, which
 * measures any file set, so the hook and the tests can ask about one file.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Lines past which a file fails the build. */
export const HARD_LIMIT = 800;
/** Lines past which the edit hook asks for a split. */
export const WARN_LIMIT = 700;

/** Directories holding the code the limit applies to, relative to the project root. */
export const SOURCE_DIRS = ['src', 'scripts', 'test'];

const CODE = /\.tsx?$/;

export interface SizeFinding {
  file: string;
  lines: number;
}

/** Every code file under `dirs`, absolute, in a stable order. */
export function sourceFiles(dirs: readonly string[] = SOURCE_DIRS, root: string = ROOT): string[] {
  const out: string[] = [];
  for (const dir of dirs) walk(path.resolve(root, dir), out);
  return out.sort();
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (CODE.test(entry.name)) out.push(full);
  }
}

/** The number of lines in `file`, counted the way `wc -l` counts them. */
export function lineCount(file: string): number {
  const text = fs.readFileSync(file, 'utf8');
  if (text.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  if (!text.endsWith('\n')) lines++;
  return lines;
}

/** The files of `fileNames` longer than `limit`, longest first. */
export function lintSizes(fileNames: readonly string[], limit: number, root: string = ROOT): SizeFinding[] {
  const findings: SizeFinding[] = [];
  for (const file of fileNames) {
    const lines = lineCount(file);
    if (lines > limit) findings.push({ file: path.relative(root, file), lines });
  }
  return findings.sort((a, b) => b.lines - a.lines);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const findings = lintSizes(sourceFiles(), HARD_LIMIT);
  for (const f of findings) console.error(`${f.file}: ${f.lines} lines, over the ${HARD_LIMIT} line limit`);
  if (findings.length > 0) {
    console.error(`\n${findings.length} file(s) over ${HARD_LIMIT} lines. Split them along the seams the code already has.`);
    process.exit(1);
  }
  console.log(`file sizes: ${sourceFiles().length} files, none over ${HARD_LIMIT} lines`);
}
