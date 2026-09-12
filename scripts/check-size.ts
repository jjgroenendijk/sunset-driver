/**
 * File size lint. A source file over `HARD_LIMIT` lines fails the build, and
 * markdown has limits of its own: `MD_COLUMN_LIMIT` columns to a line and
 * `MD_HARD_LIMIT` lines to a file.
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
const MARKDOWN = /\.md$/;

/** Columns past which a markdown line fails the build. */
export const MD_COLUMN_LIMIT = 100;
/** Lines past which a markdown file fails the build. */
export const MD_HARD_LIMIT = 400;
/**
 * Lines past which `CLAUDE.md` fails. It is loaded into every session in full,
 * before the agent knows its task, so it is held tighter than the docs it
 * points at. `docs/claude-md.md` says what belongs in it.
 */
export const CLAUDE_MD_LIMIT = 160;
/** Where the markdown lives: the project root, not walked, and `docs`. */
export const DOC_DIRS = ['.', 'docs'];
/**
 * Markdown the line limit does not apply to. `spec.md` is the whole design as
 * one document, which is the point of it; it is read by section, not in full.
 */
export const MD_EXEMPT = ['spec.md'];

export interface SizeFinding {
  file: string;
  lines: number;
  /** The limit the file passed, so a caller can report it. */
  limit: number;
}

export interface WidthFinding {
  file: string;
  line: number;
  columns: number;
}

/** Every code file under `dirs`, absolute, in a stable order. */
export function sourceFiles(dirs: readonly string[] = SOURCE_DIRS, root: string = ROOT): string[] {
  const out: string[] = [];
  for (const dir of dirs) walk(path.resolve(root, dir), out);
  return out.sort();
}

function walk(dir: string, out: string[], match: RegExp = CODE): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, match);
    else if (match.test(entry.name)) out.push(full);
  }
}

/** Every markdown file under `dirs`, absolute, in a stable order. */
export function markdownFiles(dirs: readonly string[] = DOC_DIRS, root: string = ROOT): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    const full = path.resolve(root, dir);
    // The root holds the markdown beside `node_modules` and `dist`, so it is
    // read one level deep; `docs` is walked.
    if (path.resolve(dir) === path.resolve(root, '.') || dir === '.') {
      for (const entry of fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (entry.isFile() && MARKDOWN.test(entry.name)) out.push(path.join(full, entry.name));
      }
    } else {
      walk(full, out, MARKDOWN);
    }
  }
  return out.sort();
}

/** The line limit `file` is held to. */
export function markdownLimit(file: string, root: string = ROOT): number {
  const rel = path.relative(root, file);
  if (MD_EXEMPT.includes(rel)) return Infinity;
  return rel === 'CLAUDE.md' ? CLAUDE_MD_LIMIT : MD_HARD_LIMIT;
}

/**
 * The lines of `fileNames` wider than `limit` columns, widest first. A table
 * row and the body of a fenced code block are left alone: neither can be
 * wrapped without breaking what it means. A column is a code point, so an em
 * dash counts once however many bytes it takes.
 */
export function lintWidths(fileNames: readonly string[], limit: number, root: string = ROOT): WidthFinding[] {
  const findings: WidthFinding[] = [];
  for (const file of fileNames) {
    let fenced = false;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced || line.trimStart().startsWith('|')) continue;
      const columns = [...line].length;
      if (columns > limit) findings.push({ file: path.relative(root, file), line: i + 1, columns });
    }
  }
  return findings.sort((a, b) => b.columns - a.columns);
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
export function lintSizes(
  fileNames: readonly string[],
  limit: number | ((file: string) => number),
  root: string = ROOT,
): SizeFinding[] {
  const findings: SizeFinding[] = [];
  for (const file of fileNames) {
    const lines = lineCount(file);
    const cap = typeof limit === 'function' ? limit(file) : limit;
    if (lines > cap) findings.push({ file: path.relative(root, file), lines, limit: cap });
  }
  return findings.sort((a, b) => b.lines - a.lines);
}

/**
 * Every complaint about `files`, as the lines a caller prints. Code files are
 * measured against `HARD_LIMIT`, markdown against its own two limits.
 */
export function complaints(files: readonly string[]): string[] {
  const code = files.filter((f) => CODE.test(f));
  const docs = files.filter((f) => MARKDOWN.test(f));
  const out: string[] = [];
  for (const f of lintSizes(code, HARD_LIMIT)) {
    out.push(`${f.file}: ${f.lines} lines, over the ${f.limit} line limit. Split it along the seams the code already has.`);
  }
  for (const f of lintWidths(docs, MD_COLUMN_LIMIT)) {
    out.push(`${f.file}:${f.line}: ${f.columns} columns, over the ${MD_COLUMN_LIMIT} column limit. Wrap the line.`);
  }
  for (const f of lintSizes(docs, (file) => markdownLimit(file))) {
    out.push(`${f.file}: ${f.lines} lines, over the ${f.limit} line limit. Move a section into a doc of its own.`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const named = process.argv.slice(2).map((a) => path.resolve(ROOT, a));
  const files = named.length > 0 ? named : [...sourceFiles(), ...markdownFiles()];
  const found = complaints(files);
  for (const line of found) console.error(line);
  if (found.length > 0) {
    console.error(`\n${found.length} problem(s). See docs/claude-md.md for what a doc is for.`);
    process.exit(1);
  }
  if (named.length === 0) {
    console.log(
      `file sizes: ${sourceFiles().length} code files under ${HARD_LIMIT} lines, ` +
        `${markdownFiles().length} markdown files under ${MD_COLUMN_LIMIT} columns`,
    );
  }
}
