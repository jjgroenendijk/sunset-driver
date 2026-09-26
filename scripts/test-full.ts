/**
 * The full tier, `npm run test:full`: the tests over 500 sweep seeds.
 *
 * Usage: node scripts/test-full.ts [vitest arguments]
 *
 * One process cannot hold the whole seed sweep. The fixture keeps every world of
 * its share for all the check files, and 500 worlds run a worker out of heap
 * (issue #726). CI never met this, because `full-tier.yml` gives each share a
 * runner of its own. So this runs the sweep the same way on one machine: one
 * vitest process per share, one after the other, and then every other file.
 *
 * A run that names its share with `SWEEP_SHARD` is one process, as before, and
 * so is a run of `--project unit` alone. `SWEEP_SEEDS` and `SWEEP_OFFSET` pass
 * through; `SWEEP_SEEDS` is 500 unless set.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * The shares a local run cuts the sweep into. Each process holds only its own
 * worlds, and four is what a machine of 16 GB carries. CI cuts it finer for
 * wall clock (`full-tier.yml`), which changes nothing about the seeds read.
 */
const LOCAL_SHARDS = 4;

/** Vitest's own entry, run by this Node rather than through a command found on the path. */
const VITEST = path.resolve(import.meta.dirname, '../node_modules/vitest/vitest.mjs');

const env = { ...process.env, SWEEP_SEEDS: process.env.SWEEP_SEEDS ?? '500' };

/** Split `--project x` and `--project=x` out of the arguments, keeping the rest. */
function splitProjects(args: readonly string[]): { projects: string[]; rest: string[] } {
  const projects: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--project' && i + 1 < args.length) projects.push(args[++i] as string);
    else if (arg.startsWith('--project=')) projects.push(arg.slice('--project='.length));
    else rest.push(arg);
  }
  return { projects, rest };
}

/**
 * Run vitest once. A failure is remembered rather than fatal, so every share
 * runs and one run reports every seed that fails.
 */
let failed = false;
function vitest(args: readonly string[], extra: Record<string, string> = {}): void {
  const run = spawnSync(process.execPath, [VITEST, 'run', ...args], { stdio: 'inherit', env: { ...env, ...extra } });
  if (run.status !== 0) failed = true;
}

const { projects, rest } = splitProjects(process.argv.slice(2));
const wanted = (name: string): boolean => projects.length === 0 || projects.includes(name);

if (process.env.SWEEP_SHARD !== undefined || !wanted('sweep')) {
  vitest(process.argv.slice(2));
} else {
  for (let shard = 1; shard <= LOCAL_SHARDS; shard++) {
    vitest([...rest, '--project', 'sweep'], { SWEEP_SHARD: `${shard}/${LOCAL_SHARDS}` });
  }
  const others = projects.filter((name) => name !== 'sweep');
  if (projects.length === 0) vitest([...rest, '--project', 'unit']);
  else if (others.length > 0) vitest([...rest, ...others.flatMap((name) => ['--project', name])]);
}
if (failed) process.exit(1);
