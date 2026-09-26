/**
 * Measure whether past sessions followed the issue ritual, from their own
 * transcripts. This is the evaluation behind the `working-issues` skill: the
 * skill claims sessions forget to claim an issue and to release it, and this
 * says whether that is still true and whether the skill moved the number.
 *
 * Usage: node scripts/issue-ritual.ts [--since=YYYY-MM-DD] [--sessions]
 *   --since     count only sessions whose last message is on or after this day.
 *   --sessions  list each session that opened a pull request, and what it did.
 *
 * A session counts only if it opened a pull request, because a session that
 * wrote no code was never in the ritual. Of those, it should have claimed the
 * issue before the work and released it after the merge.
 *
 * The transcripts live outside the repository, under the Claude Code project
 * directory for this checkout and for every worktree of it. Nothing here is
 * read by the game or by CI; it answers a question about how the sessions go.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Where Claude Code keeps a project's transcripts. */
const PROJECTS = path.join(homedir(), '.claude', 'projects');

/** The part of a project directory name that marks it as this repository. */
const PROJECT = 'sunset-driver';

interface Session {
  file: string;
  /** The day of the last message, as `YYYY-MM-DD`. */
  day: string;
  claimed: boolean;
  opened: boolean;
  released: boolean;
  skill: boolean;
}

const args = process.argv.slice(2);
const since = args.find((a) => a.startsWith('--since='))?.slice('--since='.length) ?? '';

const dirs = existsSync(PROJECTS)
  ? readdirSync(PROJECTS)
      .filter((name) => name.includes(PROJECT))
      .map((name) => path.join(PROJECTS, name))
  : [];
if (dirs.length === 0) {
  console.log(`no transcripts for ${PROJECT} under ${PROJECTS} — nothing to measure.`);
  process.exit(0);
}

const sessions: Session[] = [];
for (const dir of dirs) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // A transcript being written while this runs is not an error worth stopping for.
      continue;
    }
    const day = new Date(statSync(file).mtime).toISOString().slice(0, 10);
    if (since !== '' && day < since) continue;
    // Only what the session ran counts. A transcript that merely quotes
    // `gh pr create` — this script's own session does — is not a session that
    // opened a pull request, so the search is over the Bash tool's input alone.
    const ran = [...text.matchAll(/"command":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('\n');
    sessions.push({
      file,
      day,
      claimed: /gh issue edit [^\n]*--add-assignee/.test(ran),
      opened: /gh pr create/.test(ran),
      released: /gh issue edit [^\n]*--remove-assignee/.test(ran),
      skill: /"skill":"working-issues"/.test(text),
    });
  }
}

const worked = sessions.filter((s) => s.opened);
if (args.includes('--sessions')) {
  worked.sort((a, b) => (a.day < b.day ? -1 : 1));
  for (const s of worked) {
    const marks = [s.claimed ? 'claimed' : '-', s.released ? 'released' : '-', s.skill ? 'skill' : '-'];
    console.log(`  ${s.day}  ${marks.join('  ')}  ${path.basename(s.file)}`);
  }
}

/** One line of the report: how many of `of` did `what`. */
function rate(what: string, count: number, of: number): string {
  const share = of === 0 ? 0 : (count / of) * 100;
  return `  ${what.padEnd(28)} ${String(count).padStart(3)} of ${of}  (${share.toFixed(0)} %)`;
}

const sinceText = since === '' ? '' : ` since ${since}`;
console.log(`${sessions.length} sessions${sinceText}, ${worked.length} opened a pull request`);
console.log(rate('claimed the issue first', worked.filter((s) => s.claimed).length, worked.length));
console.log(rate('released it afterwards', worked.filter((s) => s.released).length, worked.length));
console.log(rate('did both', worked.filter((s) => s.claimed && s.released).length, worked.length));

const withSkill = worked.filter((s) => s.skill);
const without = worked.filter((s) => !s.skill);
if (withSkill.length > 0 && without.length > 0) {
  console.log('with the working-issues skill loaded:');
  console.log(rate('did both', withSkill.filter((s) => s.claimed && s.released).length, withSkill.length));
  console.log('without it:');
  console.log(rate('did both', without.filter((s) => s.claimed && s.released).length, without.length));
}
