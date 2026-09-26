/**
 * Move files and rewrite every path that names them.
 *
 * Usage: node scripts/move-files.ts <plan> [--dry-run]
 *
 * The plan is a text file with one move per line, `<from> <to>`, both relative
 * to the repository root. A `#` starts a comment. A folder is never moved
 * whole: name each file, so the plan is the full list of what changes.
 *
 * The script rewrites three kinds of path in every tracked text file:
 *
 * - a relative specifier in code (`'./batch.ts'`, `'../src/sim/traffic/traffic.ts'`),
 *   resolved against the file that holds it, in imports, worker URLs and CSS
 *   `@import` alike;
 * - a path from the repository root (`src/render/streaming/batch.ts`, and `/src/...` in
 *   the HTML pages), in code, configs and docs;
 * - a path from the layer, without `src/` (`render/streaming/batch.ts`), as the docs
 *   write it.
 *
 * It then moves each file with `git mv`, so git follows the rename. A string
 * that builds a path at run time (`path.join(dir, 'fixtures')`) is not a path
 * the script can see: check those by hand.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compareStrings } from '../src/core/sort.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The files whose relative strings are specifiers: code, pages and styles. */
const CODE = /\.(ts|mjs|js|html|css)$/;

/** Every file the rewrite reads: code, configs, docs and workflows. */
const TEXT = /\.(ts|mjs|js|html|css|md|json|jsonc|ya?ml|sh)$/;

/** The layers of `src`, which the docs name without the `src/` in front. */
const LAYERS = 'core|sim|world|render|audio|net|ui';

/** A relative specifier in quotes: `'./x.ts'`, `"../a/b.css"`. */
const RELATIVE = /(['"])(\.{1,2}\/[^'"\n]+)\1/g;

/** A path from the root that the HTML pages load: `'/src/ui/style.css'`. */
const ROOTED = /(['"])\/((?:src|scripts|test)\/[^'"\n]+)\1/g;

/** A path from the root, not part of a longer path. */
const FROM_ROOT = /(?<![\w./-])((?:src|test|scripts)\/[\w./-]+?\.(?:ts|css|html))(?![\w-])/g;

/** A path from a layer, not part of a longer path. */
const FROM_LAYER = new RegExp(`(?<![\\w./-])((?:${LAYERS})\\/[\\w-]+\\.(?:ts|css))(?![\\w-])`, 'g');

/** Read the plan: moves keyed by the path they leave, both relative to the root. */
function readPlan(file: string): Map<string, string> {
  const moves = new Map<string, string>();
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/#.*/, '').trim();
    if (line === '') continue;
    const [first, second, ...rest] = line.split(/\s+/);
    if (first === undefined || second === undefined || rest.length > 0) {
      throw new Error(`${file}:${i + 1}: expected "<from> <to>"`);
    }
    const from = path.normalize(first);
    const to = path.normalize(second);
    if (moves.has(from)) throw new Error(`${file}:${i + 1}: ${from} is moved twice`);
    moves.set(from, to);
  }
  return moves;
}

/** Refuse a plan that moves a file that is not there, onto one that is, or two onto one. */
function checkPlan(moves: Map<string, string>, tracked: Set<string>): void {
  const targets = new Set<string>();
  for (const [from, to] of moves) {
    if (!tracked.has(from)) throw new Error(`${from} is not a tracked file`);
    if (targets.has(to)) throw new Error(`two files move to ${to}`);
    if (tracked.has(to) && !moves.has(to)) throw new Error(`${to} already exists`);
    targets.add(to);
  }
}

/** A specifier from `dir` to `file`, both relative to the root, as an import writes it. */
function specifier(dir: string, file: string): string {
  const rel = path.relative(dir, file).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Rewrite the relative specifiers of a code file that lives at `from` and moves to `to`. */
function rewriteCode(text: string, from: string, to: string, moves: Map<string, string>, tracked: Set<string>): string {
  const relative = text.replace(RELATIVE, (whole, quote: string, spec: string) => {
    const target = path.normalize(path.join(path.dirname(from), spec));
    if (!tracked.has(target)) return whole;
    const next = moves.get(target) ?? target;
    if (next === target && from === to) return whole;
    return `${quote}${specifier(path.dirname(to), next)}${quote}`;
  });
  return relative.replace(ROOTED, (whole, quote: string, rel: string) => {
    const next = moves.get(path.normalize(rel));
    return next === undefined ? whole : `${quote}/${next}${quote}`;
  });
}

/** Rewrite the paths from the root and from a layer, in any text file. */
function rewriteText(text: string, moves: Map<string, string>): string {
  const rooted = text.replace(FROM_ROOT, (whole, rel: string) => moves.get(rel) ?? whole);
  return rooted.replace(FROM_LAYER, (whole, rel: string) => {
    const next = moves.get(`src/${rel}`);
    return next === undefined ? whole : next.slice('src/'.length);
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const planFile = args.find((a) => !a.startsWith('--'));
  if (planFile === undefined) {
    console.error('usage: node scripts/move-files.ts <plan> [--dry-run]');
    process.exit(2);
  }
  const dryRun = args.includes('--dry-run');
  const git = (...gitArgs: string[]): string =>
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- a developer tool runs the git the developer installed, which sits in a different directory on each machine
    execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
  const tracked = new Set(git('ls-files').split('\n').filter((f) => f !== ''));
  const moves = readPlan(path.resolve(planFile));
  checkPlan(moves, tracked);

  const rewritten = new Map<string, string>();
  for (const file of [...tracked].sort(compareStrings)) {
    if (!TEXT.test(file) || !existsSync(path.join(ROOT, file))) continue;
    const before = readFileSync(path.join(ROOT, file), 'utf8');
    const to = moves.get(file) ?? file;
    const code = CODE.test(file) ? rewriteCode(before, file, to, moves, tracked) : before;
    const after = rewriteText(code, moves);
    if (after !== before) rewritten.set(to, after);
  }

  console.log(`${moves.size} files to move, ${rewritten.size} files to rewrite`);
  if (dryRun) {
    for (const file of [...rewritten.keys()].sort(compareStrings)) console.log(`  rewrite ${file}`);
    return;
  }
  for (const [from, to] of [...moves].sort(([a], [b]) => compareStrings(a, b))) {
    mkdirSync(path.dirname(path.join(ROOT, to)), { recursive: true });
    git('mv', from, to);
  }
  for (const [file, text] of rewritten) writeFileSync(path.join(ROOT, file), text);
}

main();
