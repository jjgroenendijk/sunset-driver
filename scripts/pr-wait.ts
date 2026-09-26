/**
 * Wait for a pull request's checks and say what happened, in one command.
 *
 * Usage: node scripts/pr-wait.ts <pr> [--all] [--interval=20] [--timeout=1200]
 *
 * Without this, a session invents its own poll loop — `--watch`, an `until`
 * grep, a bare `sleep` the harness refuses — and each turn of it costs a tool
 * call and its output. This blocks instead: one call in, one verdict out.
 *
 * Only the checks required to merge are watched, because those are the ones
 * that decide. `--all` watches every check, CodeQL included.
 *
 * A failure prints the failing job's log, stripped of its timestamps, so the
 * reason arrives with the verdict rather than after two more commands.
 *
 * `gh pr checks --required` lists only the required checks that have reported.
 * `full-tier / seed-sweep` reports only after every sweep share finishes, so
 * the wait also lasts until every check the base branch's ruleset requires has
 * reported.
 *
 * A pull request that conflicts with its base has no merge commit, so GitHub
 * runs none of its checks and a wait for them would last until the timeout.
 * The wait stops as soon as GitHub reports the conflict and says how to fix it.
 *
 * It exits 0 when every watched check passed and the branch is up to date with
 * its base, so `&& gh pr merge` is safe.
 */
import { execFileSync } from 'node:child_process';
import { requireGh } from './gh.ts';

interface Check {
  name: string;
  bucket: string;
  state: string;
  link: string;
  startedAt: string;
  completedAt: string;
}

const args = process.argv.slice(2);
const pr = args.find((a) => /^\d+$/.test(a));
if (pr === undefined) {
  console.error('usage: node scripts/pr-wait.ts <pr> [--all] [--interval=20] [--timeout=1200]');
  process.exit(2);
}
const flag = (name: string, fallback: number): number => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? fallback : Number(found.slice(name.length + 3));
};
const everyCheck = args.includes('--all');
const intervalMs = flag('interval', 20) * 1000;
const deadline = Date.now() + flag('timeout', 1200) * 1000;

requireGh(
  'Until gh is back, read the checks through the GitHub MCP server. Ask once, and ask again\n' +
    'after other work: a poll loop of your own costs a tool call for every turn.',
);

/** Run `gh` and return its output, or undefined when it failed. */
function gh(...argv: string[]): string | undefined {
  try {
    // `gh` writes its own complaints to stderr, and they are inherited into
    // this command's output unless they are caught here.
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- a developer tool runs the gh the developer installed, which sits in a different directory on each machine
    return execFileSync('gh', argv, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
}

function checks(): Check[] | undefined {
  const argv = ['pr', 'checks', pr!, '--json', 'name,bucket,state,link,startedAt,completedAt'];
  if (!everyCheck) argv.push('--required');
  const out = gh(...argv);
  // `gh` exits non-zero both when a check failed and when none has reported
  // yet, and prints the JSON in the first case. No output means no checks yet.
  if (out === undefined || out.trim() === '') return undefined;
  try {
    return JSON.parse(out) as Check[];
  } catch {
    return undefined;
  }
}

/** The commit the checks belong to. A push during the wait invalidates them. */
function head(): string {
  return (gh('pr', 'view', pr!, '--json', 'headRefOid', '--jq', '.headRefOid') ?? '').trim();
}

/** The check names the ruleset of the pull request's base branch requires. */
function required(): string[] {
  const base = (gh('pr', 'view', pr!, '--json', 'baseRefName', '--jq', '.baseRefName') ?? '').trim();
  if (base === '') return [];
  const out = gh(
    'api',
    `repos/{owner}/{repo}/rules/branches/${base}`,
    '--jq',
    '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context]',
  );
  try {
    return out === undefined ? [] : (JSON.parse(out) as string[]);
  } catch {
    return [];
  }
}

/**
 * True when GitHub says the pull request conflicts with its base. GitHub works
 * `mergeable` out in the background, so `UNKNOWN` is read as no conflict yet.
 */
function conflicting(): boolean {
  return (gh('pr', 'view', pr!, '--json', 'mergeable', '--jq', '.mergeable') ?? '').trim() === 'CONFLICTING';
}

/** Say the pull request conflicts and how to clear it, then exit 1. */
function reportConflict(): never {
  const base = (gh('pr', 'view', pr!, '--json', 'baseRefName', '--jq', '.baseRefName') ?? '').trim() || 'main';
  console.log(`PR ${pr}: conflicts with ${base}, so GitHub runs none of its checks.`);
  console.log(`Rebase it: git fetch origin ${base} && git rebase origin/${base}, then push with --force-with-lease.`);
  process.exit(1);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `1m12s` from two timestamps. */
function took(check: Check): string {
  const from = Date.parse(check.startedAt);
  const to = Date.parse(check.completedAt);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return '';
  const seconds = Math.round((to - from) / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** The job id at the end of a check's link, for `gh run view --job`. */
function jobId(link: string): string | undefined {
  return /\/(?:job|runs)\/(\d+)$/.exec(link)?.[1];
}

/** An Actions workflow command, which says nothing about why the job failed. */
const WORKFLOW_COMMAND =
  /^(##\[(group|endgroup|debug|section|start-action|end-action|set-output|add-matcher|remove-matcher|save-state)[\] ]|\[command\])/;

/** The runner's own progress lines, which say nothing about it either. */
const RUNNER_PROGRESS =
  /^(Received \d+ of |Cache (hit|Size|restored)|Post job cleanup|Prepare all required actions|Getting action download info|Download action repository )/;

/** Whether `line` is Actions plumbing rather than output of the job. */
function isPlumbing(line: string): boolean {
  return WORKFLOW_COMMAND.test(line) || RUNNER_PROGRESS.test(line);
}

/** The escape byte that opens a colour code in a terminal. */
const ESCAPE = String.fromCharCode(27);

/**
 * The part of a run log worth reading: the lines running up to the last
 * `##[error]` annotation, which is where the job gave up. The tail of the log
 * is the post-job cleanup, so a blind `tail` reads git plumbing instead.
 */
function readable(log: string, lines: number): string[] {
  const body: string[] = [];
  // A `with:` or `env:` header is followed by its indented settings, which are
  // the workflow repeating itself rather than anything the job did.
  let inSettings = false;
  for (const raw of log.split('\n')) {
    // Each line carries a job column, a step column, a byte-order mark, an ISO
    // timestamp and sometimes a colour escape before its text.
    const line = raw
      .replace(/^.*?\t.*?\t/, '')
      .replace(/^\uFEFF/, '')
      .replace(/^\S*Z /, '')
      // A colour escape. The log API writes the escape as the two literal
      // characters `^[`, so the real byte is turned into that form first.
      .replaceAll(ESCAPE, '^[')
      .replace(/\^\[\[[0-9;]*m/g, '');
    if (/^(with|env):$/.test(line)) {
      inSettings = true;
      continue;
    }
    if (inSettings && /^\s/.test(line)) continue;
    inSettings = false;
    if (line.trim() === '' || isPlumbing(line)) continue;
    body.push(line);
  }
  let last = -1;
  for (let i = 0; i < body.length; i++) if (body[i]!.startsWith('##[error]')) last = i;
  const end = last === -1 ? body.length : last + 1;
  // Each step names its shell before it runs. The last such line before the
  // error opens the step that failed, and the command it ran is just above it.
  let step = 0;
  for (let i = 0; i < end; i++) if (body[i]!.startsWith('shell: ')) step = Math.max(0, i - 4);
  return body
    .slice(Math.max(step, end - lines), end)
    .map((line) => line.replace(/^##\[error\]/, ''));
}

const started = Date.now();
const headAtStart = head();
if (headAtStart === '') {
  console.log(`PR ${pr}: no such pull request, or gh cannot reach the repository.`);
  process.exit(2);
}
const gating = required();
let seen: Check[] = [];
/** Required checks that have not reported yet, so `gh` does not list them. */
let unreported: string[] = [];

for (;;) {
  if (conflicting()) reportConflict();
  const now = checks();
  if (now !== undefined && now.length > 0) {
    seen = now;
    unreported = gating.filter((name) => !now.some((c) => c.name === name));
    const failed = now.some((c) => c.bucket === 'fail' || c.bucket === 'cancel');
    // A failure decides the verdict, so a check still to come need not be waited for.
    if (!now.some((c) => c.bucket === 'pending') && (unreported.length === 0 || failed)) break;
  }
  if (Date.now() > deadline) {
    console.log(`PR ${pr}: still pending after ${Math.round((Date.now() - started) / 60000)}m, gave up waiting.`);
    for (const c of seen) console.log(`  ${c.bucket.padEnd(8)} ${c.name}`);
    for (const name of unreported) console.log(`  ${'absent'.padEnd(8)} ${name}`);
    process.exit(1);
  }
  const moved = head();
  if (moved !== '' && headAtStart !== '' && moved !== headAtStart) {
    console.log(`PR ${pr}: the head moved from ${headAtStart.slice(0, 7)} to ${moved.slice(0, 7)}; these checks are stale.`);
    process.exit(1);
  }
  await wait(intervalMs);
}

/** The verdict column for a check: quiet for a pass or a skip, loud otherwise. */
function bucketLabel(bucket: string): string {
  if (bucket === 'pass') return 'pass';
  if (bucket === 'skipping') return 'skip';
  return bucket.toUpperCase();
}

const elapsed = `${Math.floor((Date.now() - started) / 60000)}m${String(Math.round(((Date.now() - started) % 60000) / 1000)).padStart(2, '0')}s`;
for (const c of seen) {
  console.log(`  ${bucketLabel(c.bucket).padEnd(6)} ${took(c).padEnd(7)} ${c.name}`);
}

const bad = seen.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
const mergeState = (gh('pr', 'view', pr!, '--json', 'mergeStateStatus', '--jq', '.mergeStateStatus') ?? '').trim();

if (bad.length === 0) {
  console.log(`PR ${pr}: ${seen.length} checks passed in ${elapsed}, merge state ${mergeState || 'unknown'}.`);
  // The ruleset wants the branch up to date with its base, so green checks on
  // a branch that is behind still do not merge. Exit 1, so `&& gh pr merge`
  // is not tried and refused.
  if (mergeState === 'DIRTY') reportConflict();
  if (mergeState === 'BEHIND') {
    const base = (gh('pr', 'view', pr!, '--json', 'baseRefName', '--jq', '.baseRefName') ?? '').trim() || 'main';
    console.log(`PR ${pr}: behind ${base}, so it will not merge. Rebase on origin/${base}, push with --force-with-lease and wait again.`);
    process.exit(1);
  }
  process.exit(0);
}

console.log(`PR ${pr}: ${bad.length} of ${seen.length} checks failed after ${elapsed}, merge state ${mergeState || 'unknown'}.`);
for (const c of bad) {
  const id = jobId(c.link);
  console.log(`\n=== ${c.name} ===`);
  if (id === undefined) {
    console.log(c.link);
    continue;
  }
  const log = gh('run', 'view', '--job', id, '--log-failed');
  if (log === undefined || log.trim() === '') {
    console.log(`no failed-step log; see ${c.link}`);
    continue;
  }
  for (const line of readable(log, 40)) console.log(line);
}
process.exit(1);
