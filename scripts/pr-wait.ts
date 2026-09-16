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
 * It exits 0 when every watched check passed, so `&& gh pr merge` is safe.
 */
import { execFileSync } from 'node:child_process';

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

/** Run `gh` and return its output, or undefined when it failed. */
function gh(...argv: string[]): string | undefined {
  try {
    // `gh` writes its own complaints to stderr, and they are inherited into
    // this command's output unless they are caught here.
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

/** Actions plumbing, which says nothing about why the job failed. */
const PLUMBING =
  /^(##\[(group|endgroup|debug|section|start-action|end-action|set-output|add-matcher|remove-matcher|save-state)[\] ]|\[command\]|Received \d+ of |Cache (hit|Size|restored)|Post job cleanup|Prepare all required actions|Getting action download info|Download action repository )/;

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
      // characters `^[`, so that form is stripped as well as the real byte.
      // eslint-disable-next-line no-control-regex
      .replace(/(\u001b|\^\[)\[[0-9;]*m/g, '');
    if (/^(with|env):$/.test(line)) {
      inSettings = true;
      continue;
    }
    if (inSettings && /^\s/.test(line)) continue;
    inSettings = false;
    if (line.trim() === '' || PLUMBING.test(line)) continue;
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
let seen: Check[] = [];

for (;;) {
  const now = checks();
  if (now !== undefined && now.length > 0) {
    seen = now;
    if (!now.some((c) => c.bucket === 'pending')) break;
  }
  if (Date.now() > deadline) {
    console.log(`PR ${pr}: still pending after ${Math.round((Date.now() - started) / 60000)}m, gave up waiting.`);
    for (const c of seen) console.log(`  ${c.bucket.padEnd(8)} ${c.name}`);
    process.exit(1);
  }
  const moved = head();
  if (moved !== '' && headAtStart !== '' && moved !== headAtStart) {
    console.log(`PR ${pr}: the head moved from ${headAtStart.slice(0, 7)} to ${moved.slice(0, 7)}; these checks are stale.`);
    process.exit(1);
  }
  await wait(intervalMs);
}

const elapsed = `${Math.floor((Date.now() - started) / 60000)}m${String(Math.round(((Date.now() - started) % 60000) / 1000)).padStart(2, '0')}s`;
for (const c of seen) {
  const label = c.bucket === 'pass' ? 'pass' : c.bucket === 'skipping' ? 'skip' : c.bucket.toUpperCase();
  console.log(`  ${label.padEnd(6)} ${took(c).padEnd(7)} ${c.name}`);
}

const bad = seen.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
const mergeState = (gh('pr', 'view', pr!, '--json', 'mergeStateStatus', '--jq', '.mergeStateStatus') ?? '').trim();

if (bad.length === 0) {
  console.log(`PR ${pr}: ${seen.length} checks passed in ${elapsed}, merge state ${mergeState || 'unknown'}.`);
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
