/**
 * The README's control table, generated from `CONTROLS`. The table drifted from
 * the bindings once already (issue #353), because it was written by hand beside
 * the one table `src/ui/input/controls.ts` says is the only description of the keys.
 *
 * Run as a script it rewrites the table between the markers in `README.md`.
 * Imported it exports `readmeWithControls`, so the test can ask whether the file
 * on disk is the file this would write.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONTROLS } from '../src/ui/input/controls.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Where the README holds the generated table. */
export const README = path.join(ROOT, 'README.md');
const START = '<!-- controls: generated from src/ui/input/controls.ts by scripts/readme-controls.ts -->';
const END = '<!-- end controls -->';

/** `CONTROLS` as a markdown table, without the markers around it. */
export function controlsTable(): string {
  const rows = CONTROLS.map((b) => `| ${b.action} | ${b.keys} |`);
  return ['| Action | Keys |', '|---|---|', ...rows].join('\n');
}

/** `text` with the block between the markers replaced by the current table. */
export function readmeWithControls(text: string): string {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < 0) throw new Error(`README.md has lost the control table markers: ${START}`);
  return `${text.slice(0, start)}${START}\n\n${controlsTable()}\n\n${text.slice(end)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const text = fs.readFileSync(README, 'utf8');
  const next = readmeWithControls(text);
  if (next === text) {
    console.log('README.md control table is current.');
  } else {
    fs.writeFileSync(README, next);
    console.log('README.md control table rewritten from src/ui/input/controls.ts.');
  }
}
